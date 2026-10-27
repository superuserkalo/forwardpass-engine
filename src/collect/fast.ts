import { createPrivateJson, deletePrivateJson, readPrivateJson, writePrivateJson } from "../lib/private-store.js";
import type { Candidate } from "../lib/schemas.js";
import { collectSourceStreams, type CollectorState } from "../lib/source-collector.js";
import { discoveredStreams, loadRegistry } from "../lib/source-discovery.js";
import { SOURCE_STREAMS, type SourceStream } from "../lib/source-streams.js";
import { IO_STEP, type Steps } from "../pipeline/steps.js";
import { isTier1 } from "../pipeline/tier1.js";
import { STATE_KEY, shardSchema, stateSchema, uniqueByEntry } from "./collect.js";

// The fast lane: every fifteen minutes, the feeds of tier-1 publishers, so a launch is a candidate within minutes of its
// source going live and not at the next two-hourly run. It is the same collector with its own state and its own snapshots
// (collection/fast/<date>/<hhmm>.json, in the shape the main lane's readers already take), and the main lane still polls
// everything, so an item both lanes see is one item. Most polls end in a 304: the collector sends the validators it kept.

export const FAST_STATE_KEY = "collection/fast-state.json";
const SHARDS = 4;
const FAST_KINDS = new Set<SourceStream["kind"]>(["rss", "atom", "github-releases", "json-index", "sitemap"]);

/** The address whose owner decides whether a stream is a tier-1 publisher's: a releases API says nothing, the repository it lists does. */
function ownerAddress(stream: SourceStream): string {
  const repository = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases/.exec(stream.url);
  return repository ? `https://github.com/${repository[1]}/${repository[2]}` : stream.url;
}

/** Public routes of a feed kind (a page needs its articles read, which the main lane does) that belong to a tier-1 publisher. */
export function isFastStream(stream: SourceStream): boolean {
  return (!stream.access || stream.access === "public") && FAST_KINDS.has(stream.kind) && isTier1(ownerAddress(stream));
}

export type FastResult = { snapshot: string | null; items: number; routes: number; failed: number };

/** The fast lane's own record of the streams it polls. */
async function ownState(): Promise<CollectorState> {
  const own = await readPrivateJson(FAST_STATE_KEY);
  return own !== null ? stateSchema.parse(own) : { version: 1, streams: {} };
}

/** The main lane's state, from which a stream the fast lane has not polled before starts, so that it does not re-emit a day of old items. */
async function mainState(): Promise<CollectorState> {
  const main = await readPrivateJson(STATE_KEY);
  return main !== null ? stateSchema.parse(main) : { version: 1, streams: {} };
}

export async function collectFast(steps: Steps, job: { now: string }, options: { fetcher?: typeof fetch; streams?: readonly SourceStream[] } = {}): Promise<FastResult> {
  const now = new Date(job.now);
  const day = job.now.slice(0, 10);
  const stamp = `${job.now.slice(11, 13)}${job.now.slice(14, 16)}`;
  const snapshotKey = `collection/fast/${day}/${stamp}.json`;
  const work = `collection/fast-work/${day}/${stamp}`;

  const done = await steps.run("existing-fast-snapshot", IO_STEP, async () => (await readPrivateJson(snapshotKey)) !== null);
  if (done) return { snapshot: snapshotKey, items: 0, routes: 0, failed: 0 };

  // Every one is due on every poll: the interval that suits the main lane is not this lane's.
  const streams: SourceStream[] = await steps.run("fast-streams", IO_STEP, async () =>
    (options.streams ?? [...SOURCE_STREAMS, ...discoveredStreams(await loadRegistry())]).filter(isFastStream).map((stream) => ({ ...stream, intervalHours: 0 })));

  await Promise.all(Array.from({ length: SHARDS }, (_, shard) => steps.run(`fast-${shard}`, IO_STEP, async () => {
    const key = `${work}/${shard}.json`;
    if ((await readPrivateJson(key)) !== null) return true;
    const mine = streams.filter((_, i) => i % SHARDS === shard);
    const [own, main] = await Promise.all([ownState(), mainState()]);
    const previous: CollectorState = { version: 1, streams: Object.fromEntries(mine.flatMap((stream) => { const known = own.streams[stream.id] ?? main.streams[stream.id]; return known ? [[stream.id, known]] : []; })) };
    const result = await collectSourceStreams(previous, { now, streams: mine, fetcher: options.fetcher });
    const updated = Object.fromEntries(mine.flatMap((stream) => result.state.streams[stream.id] ? [[stream.id, result.state.streams[stream.id]]] : []));
    await createPrivateJson(key, { items: result.items, health: result.health, streams: updated });
    return true;
  })));

  return steps.run("fast-commit", IO_STEP, async () => {
    const state = await ownState();
    const health: ReturnType<typeof shardSchema.parse>["health"] = [];
    const found: Candidate[] = [];
    for (let shard = 0; shard < SHARDS; shard++) {
      const part = shardSchema.parse(await readPrivateJson(`${work}/${shard}.json`));
      Object.assign(state.streams, part.streams);
      health.push(...part.health);
      found.push(...part.items);
    }
    const items = uniqueByEntry(found);
    // Most routes answer "unchanged" every time, so the snapshot names only those that failed or had something new.
    const noteworthy = health.filter((row) => row.status === "failed" || Number((row as Record<string, unknown>).newCount ?? 0) > 0);
    // The snapshot is written before the state, so a crash in between re-reads sources rather than skipping them.
    if (items.length) await createPrivateJson(snapshotKey, { version: 2, collectedAt: now.toISOString(), items, attention: { measurements: [], candidates: [], health: [] }, health: noteworthy });
    await writePrivateJson(FAST_STATE_KEY, state);
    for (let shard = 0; shard < SHARDS; shard++) await deletePrivateJson(`${work}/${shard}.json`);
    const failed = health.filter((row) => row.status === "failed").length;
    console.info("forwardpass.fast_collection", JSON.stringify({ at: now.toISOString(), routes: health.length, items: items.length, failed }));
    return { snapshot: items.length ? snapshotKey : null, items: items.length, routes: health.length, failed };
  });
}
