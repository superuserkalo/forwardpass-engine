import { z } from "zod";
import { attentionReportSchema, collectAttention, type AttentionReport } from "../lib/attention.js";
import { createPrivateJson, listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "../lib/private-store.js";
import { candidateSchema, type Candidate } from "../lib/schemas.js";
import { collectSourceStreams, type CollectorState } from "../lib/source-collector.js";
import { entryKey } from "../lib/entry-key.js";
import { SOURCE_STREAMS, type SourceStream } from "../lib/source-streams.js";
import { discoveredStreams, loadRegistry, runSourceDiscovery } from "../lib/source-discovery.js";
import { collectTrending } from "../lib/trending-streams.js";
import { IO_STEP, type Steps } from "../pipeline/steps.js";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { BROWSER_HOURS, MAX_BROWSER_ROUTES, needsBrowser, withBrowserFetcher } from "./browser.js";

// Scheduled collection: no model calls, no email. Source routes are split into shards so each
// step stays small and retries alone. Collector state lives in one object; each hourly snapshot
// holds only what is new, trending artifacts and attention, so a day of snapshots stays small.

export const STATE_KEY = "collection/state.json";
const SHARDS = 8;
// The shards run this many at a time. What a shard holds while it runs (the pages it is reading and the ones it has parsed) is most of the
// memory the collection uses, and the Worker has 128 MB for all of it, so all eight at once ran out on 8 October.
const SHARD_CONCURRENCY = 2;
const SNAPSHOT = /^collection\/runs\/(\d{4}-\d{2}-\d{2})\/(\d{2})\.json$/;

const streamStateSchema = z.object({
  etag: z.string().optional(), lastModified: z.string().optional(), lastSucceededAt: z.string().optional(),
  seen: z.record(z.string(), z.string()), revisions: z.record(z.string(), z.string()).optional(), undatedIds: z.array(z.string()).optional(),
});
export const stateSchema = z.object({ version: z.literal(1), streams: z.record(z.string(), streamStateSchema) });
// The whole state is checked at its edges only: it is large (8 MB of JSON by 8 October) and a full parse copies all of it, which a Worker with
// 128 MB cannot afford beside the original. What a shard is given is checked in full when the shard reads it.
const storedStateSchema = z.object({ version: z.literal(1), streams: z.record(z.string(), z.unknown()) });
export const healthSchema = z.object({ streamId: z.string(), status: z.string(), error: z.string().optional() }).passthrough();
export const shardSchema = z.object({ items: z.array(candidateSchema), health: z.array(healthSchema), streams: z.record(z.string(), streamStateSchema) });

export type CollectJob = { now: string };
export type CollectResult = { snapshot: string; items: number; routes: number; failed: number; trending: number; attention: AttentionReport["health"] };

async function latestSnapshotKey(before: string): Promise<string | undefined> {
  return (await listPrivateJsonKeys("collection/runs/")).filter((key) => SNAPSHOT.test(key) && key < before).sort().at(-1);
}

/** Collector state; on the first run it is taken over from the last snapshot the old collector wrote. */
async function loadState(before: string): Promise<CollectorState> {
  const saved = await readPrivateJson(STATE_KEY);
  if (saved !== null) return storedStateSchema.parse(saved) as CollectorState;
  const keys = (await listPrivateJsonKeys("collection/runs/")).filter((key) => SNAPSHOT.test(key) && key < before).sort().reverse();
  for (const key of keys) {
    const legacy = z.object({ state: stateSchema.optional() }).passthrough().parse(await readPrivateJson(key));
    if (legacy.state) return legacy.state;
  }
  return { version: 1, streams: {} };
}

const shardOf = <T>(list: readonly T[], shard: number): T[] => list.filter((_, i) => i % SHARDS === shard);

/**
 * `streams` replaces the catalog and the discovered feeds, for a test. The eight shard steps run at once in one Worker, which has 128 MB
 * for all of them, so none of them may hold the whole of the collector's state (8 MB of JSON by 8 October, and growing): it is read once,
 * in a step of its own, and each shard is given only the part that is its own.
 */
export async function collectSources(steps: Steps, job: CollectJob, options: { browser?: BrowserWorker; forceBrowser?: boolean; streams?: SourceStream[] } = {}): Promise<CollectResult> {
  const now = new Date(job.now);
  const hour = job.now.slice(0, 13);
  const snapshotKey = `collection/runs/${hour.slice(0, 10)}/${hour.slice(11, 13)}.json`;
  const work = `collection/work/${hour.slice(0, 10)}/${hour.slice(11, 13)}`;

  const done = await steps.run("existing-snapshot", IO_STEP, async () => (await readPrivateJson(snapshotKey)) !== null);
  if (done) return { snapshot: snapshotKey, items: 0, routes: 0, failed: 0, trending: 0, attention: [] };

  // Feeds found by source discovery join the catalog while on probation or active.
  const discovered: SourceStream[] = options.streams ? [] : await steps.run("discovered-streams", IO_STEP, async () => discoveredStreams(await loadRegistry()));
  const allStreams = options.streams ?? [...SOURCE_STREAMS, ...discovered];

  await steps.run("state", IO_STEP, async () => {
    const state = await loadState(snapshotKey);
    for (let shard = 0; shard < SHARDS; shard++) {
      const own = shardOf(allStreams, shard);
      await writePrivateJson(`${work}/state-${shard}.json`, { version: 1, streams: Object.fromEntries(own.flatMap((s) => state.streams[s.id] ? [[s.id, state.streams[s.id]]] : [])) });
    }
    // What a stream that has left the catalog had stays in the state, set aside here so the commit need not read the whole of the old one.
    const catalog = new Set(allStreams.map((s) => s.id));
    await writePrivateJson(`${work}/state-retired.json`, { version: 1, streams: Object.fromEntries(Object.entries(state.streams).filter(([id]) => !catalog.has(id))) });
    return true;
  });

  const sourceShard = (shard: number) => steps.run(`sources-${shard}`, IO_STEP, async () => {
    const key = `${work}/sources-${shard}.json`;
    const saved = await readPrivateJson(key);
    if (saved !== null) { const parsed = shardSchema.parse(saved); return { items: parsed.items.length, failed: parsed.health.filter((h) => h.status === "failed").length, routes: parsed.health.length }; }
    const streams = shardOf(allStreams, shard);
    // Nothing is guessed when the part is missing: a stream with no state is read as new, and everything it lists would be announced again.
    const part = await readPrivateJson(`${work}/state-${shard}.json`);
    if (part === null) throw new Error(`The collector state for shard ${shard} is missing.`);
    const previous: CollectorState = stateSchema.parse(part);
    const result = await collectSourceStreams(previous, { now, streams });
    const updated = Object.fromEntries(streams.flatMap((s) => result.state.streams[s.id] ? [[s.id, result.state.streams[s.id]]] : []));
    await createPrivateJson(key, { items: result.items, health: result.health, streams: updated });
    return { items: result.items.length, failed: result.health.filter((h) => h.status === "failed").length, routes: result.health.length };
  });
  const shards: Awaited<ReturnType<typeof sourceShard>>[] = [];
  for (let first = 0; first < SHARDS; first += SHARD_CONCURRENCY) {
    shards.push(...await Promise.all(Array.from({ length: Math.min(SHARD_CONCURRENCY, SHARDS - first) }, (_, i) => sourceShard(first + i))));
  }

  const trending = await steps.run("trending", IO_STEP, async () => {
    const key = `${work}/trending.json`;
    if ((await readPrivateJson(key)) === null) await createPrivateJson(key, await collectTrending({ now }));
    return z.object({ items: z.array(candidateSchema) }).passthrough().parse(await readPrivateJson(key)).items.length;
  });

  const attention = await steps.run("attention", IO_STEP, async () => {
    const key = `${work}/attention.json`;
    if ((await readPrivateJson(key)) === null) {
      const items = await collectedItems(work);
      const previousKey = await latestSnapshotKey(snapshotKey);
      const previous = previousKey ? z.object({ attention: attentionReportSchema }).passthrough().parse(await readPrivateJson(previousKey)).attention : undefined;
      await createPrivateJson(key, await collectAttention(items, previous, { now }));
    }
    return attentionReportSchema.parse(await readPrivateJson(key)).health;
  });

  // Twice a day, routes that block plain HTTP are re-read through a real browser.
  if (options.browser && (options.forceBrowser || BROWSER_HOURS.has(hour.slice(11, 13)))) {
    const browser = options.browser;
    await steps.run("browser", IO_STEP, async () => {
      const key = `${work}/browser.json`;
      if ((await readPrivateJson(key)) !== null) return true;
      const blocked = new Set<string>();
      for (let shard = 0; shard < SHARDS; shard++) {
        for (const row of shardSchema.parse(await readPrivateJson(`${work}/sources-${shard}.json`)).health) if (needsBrowser(row.status, row.error)) blocked.add(row.streamId);
      }
      const streams = allStreams.filter((stream) => blocked.has(stream.id)).slice(0, MAX_BROWSER_ROUTES);
      const state = await loadState(snapshotKey);
      const previous: CollectorState = { version: 1, streams: Object.fromEntries(streams.flatMap((s) => state.streams[s.id] ? [[s.id, { ...state.streams[s.id], etag: undefined, lastModified: undefined }]] : [])) };
      const collected = streams.length ? await withBrowserFetcher(browser, (fetcher) => collectSourceStreams(previous, { now, streams, fetcher })) : { items: [], health: [], state: previous };
      const updated = Object.fromEntries(streams.flatMap((s) => collected.state.streams[s.id] ? [[s.id, collected.state.streams[s.id]]] : []));
      await createPrivateJson(key, { items: collected.items, health: collected.health.map((row) => ({ ...row, via: "browser" })), streams: updated });
      console.info("forwardpass.browser_collection", JSON.stringify({ routes: streams.length, recovered: collected.health.filter((h) => h.status !== "failed").length, items: collected.items.length }));
      return true;
    });
  }

  const result = await steps.run("commit", IO_STEP, async () => {
    // The new state is what the shards handed back and what was set aside for the streams that left the catalog: the old state is not read
    // again, since beside the shards' output it was the largest thing this step held.
    const aside = await readPrivateJson(`${work}/state-retired.json`);
    if (aside === null) throw new Error("The streams set aside when the collector state was cut are missing.");
    const streams: Record<string, unknown> = { ...storedStateSchema.parse(aside).streams };
    const health: z.infer<typeof healthSchema>[] = [];
    const collected: Candidate[] = [];
    for (let shard = 0; shard < SHARDS; shard++) {
      const part = shardSchema.parse(await readPrivateJson(`${work}/sources-${shard}.json`));
      Object.assign(streams, part.streams);
      health.push(...part.health);
      collected.push(...part.items);
    }
    const trendingPart = z.object({ items: z.array(candidateSchema), health: z.array(z.object({ stream: z.string(), status: z.string(), items: z.number(), error: z.string().optional() })) }).passthrough()
      .parse(await readPrivateJson(`${work}/trending.json`));
    collected.push(...trendingPart.items);
    const browserPart = await readPrivateJson(`${work}/browser.json`);
    if (browserPart !== null) {
      const part = shardSchema.parse(browserPart);
      Object.assign(streams, part.streams);
      const recovered = new Set(part.health.filter((row) => row.status !== "failed").map((row) => row.streamId));
      health.splice(0, health.length, ...health.filter((row) => !recovered.has(row.streamId)), ...part.health.filter((row) => recovered.has(row.streamId)));
      collected.push(...part.items);
    }
    const items = uniqueByEntry(collected);
    const report = attentionReportSchema.parse(await readPrivateJson(`${work}/attention.json`));
    health.push(...trendingPart.health.map(({ stream, status, items: count, error }) => ({ streamId: stream, status, itemCount: count, ...(error ? { error } : {}) })));
    // The snapshot is written before the state, so a crash in between re-reads sources rather than skipping them.
    await createPrivateJson(snapshotKey, { version: 2, collectedAt: now.toISOString(), items, attention: report, health });
    await writePrivateJson(STATE_KEY, { version: 1, streams });
    const failed = health.filter((row) => row.status === "failed").length;
    console.info("forwardpass.collection", JSON.stringify({ at: now.toISOString(), routes: health.length, items: items.length, failed, attention: report.health }));
    return { snapshot: snapshotKey, items: items.length, routes: shards.reduce((n, s) => n + s.routes, 0), failed, trending, attention };
  });

  // Once a day, look for publishers readers keep linking to that the catalog does not cover.
  if (hour.endsWith("T04")) {
    await steps.run("discover-sources", IO_STEP, async () => {
      const { examined, counts } = await runSourceDiscovery(now);
      return { examined: examined.length, counts };
    });
  }
  return result;
}

/**
 * The collection the daily issue starts with, so that it includes what was published up to now. If it fails the issue is written from the
 * snapshots the two-hourly runs have already taken: a day without an issue costs readers far more than a few hours of staleness, and on
 * 8 October a collection that ran out of memory took the whole issue with it.
 */
export async function collectBeforeIssue(collect: () => Promise<CollectResult>): Promise<{ collection: CollectResult | null; failure: string | null }> {
  try {
    return { collection: await collect(), failure: null };
  } catch (error) {
    const failure = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    console.error("forwardpass.issue_collection_failed", JSON.stringify({ error: failure }));
    return { collection: null, failure };
  }
}

async function collectedItems(work: string): Promise<Candidate[]> {
  const items: Candidate[] = [];
  for (let shard = 0; shard < SHARDS; shard++) items.push(...shardSchema.parse(await readPrivateJson(`${work}/sources-${shard}.json`)).items);
  items.push(...z.object({ items: z.array(candidateSchema) }).passthrough().parse(await readPrivateJson(`${work}/trending.json`)).items);
  const browserPart = await readPrivateJson(`${work}/browser.json`);
  if (browserPart !== null) items.push(...shardSchema.parse(browserPart).items);
  return uniqueByEntry(items);
}

/** One item per canonical URL (and per entry anchor on changelog pages); the first one wins. */
export function uniqueByEntry(items: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    let key: string;
    try { key = entryKey(item.url); } catch { return false; }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
