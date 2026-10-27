import { z } from "zod";
import { signalPaths, type pingIndexNow } from "../lib/indexnow.js";
import type { Usage } from "../lib/issue.js";
import { deletePrivateJson, listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "../lib/private-store.js";
import { candidateSchema } from "../lib/schemas.js";
import type { SignalService } from "../lib/signal-service.js";
import { signalId, signalRecordSchema, type Outcome, type SignalRecord } from "../lib/signals.js";
import { storyType, traction, type Cluster } from "./candidates.js";
import { CURSOR_KEY, isRepost, nextCandidates, repostable, type PublishedHeadline } from "./signal-candidates.js";
import { cleanDraft, draftProblems, publisherLabel, settleSummary, signalProject, type DraftItem, type EvidenceResult, type SignalDraft, type SummaryVerdict, type WriterItem, type gatherEvidence, type groundDrafts, type writeDrafts } from "./signal-writing.js";
import { IO_STEP, MODEL_STEP, type StepConfig, type Steps } from "./steps.js";
import { isTier1FirstParty } from "./tier1.js";
import { TRIAGE_BATCH, type ShortlistEntry, type TriageRow } from "./triage.js";

// One run of the live signals pipeline, as durable steps: read what is new, claim it, triage it, capture and verify
// evidence, write, check, ground, publish. Every model and store call is injected, so a run is a function of its inputs.
// A step's result is stored as JSON and returned again if the step is retried, so none of them holds more than ids,
// facts and drafts; the clusters themselves wait in the private store.

/** Signals one run may publish, by lane, and the most any UTC day may hold. */
export const CAPS = { fast: 15, main: 30, day: 80 } as const;
/** Candidates triaged for each signal the run may still publish, since triage drops most of them. */
const TRIAGE_FACTOR = 3;
const EVIDENCE_CONCURRENCY = 5;
const MIN_IMPORTANCE = 5;
const MIN_IMPORTANCE_TIER1 = 4;
const REPOST_WINDOW_MS = 48 * 3_600_000;
/** The ping gives up on its own after ten seconds, so this only bounds a step that never starts. */
const ANNOUNCE_STEP: StepConfig = { retries: { limit: 1, delay: 5_000 }, timeout: 60_000 };
const ANNOUNCE_DETAIL_MAX = 200;

export type SignalsJob = { now: string; lane: "fast" | "main"; publish: boolean };
export type SignalsDeps = {
  service: SignalService;
  triage: (batch: ShortlistEntry[]) => Promise<{ rows: TriageRow[]; usage: Usage }>;
  evidence: typeof gatherEvidence;
  write: typeof writeDrafts;
  ground: typeof groundDrafts;
  /** The clock for the time a signal is published; the job's own time is when the run started. */
  now?: () => Date;
  /** Tells the search engines about new pages. A courtesy: whatever it does, or fails to do, the run's signals stand. */
  announce?: typeof pingIndexNow;
};
/** `published` is what was published, or in a preview what would have been. */
export type SignalsResult = { considered: number; claimed: number; triaged: number; published: number; skippedCap: number; failed: number; rejected: number; preview: boolean; cost: number; ids: string[] };

type Announcement = { paths: number; outcome: "sent" | "skipped" | "failed"; detail: string };
const announcementFailed = (paths: number, error: unknown): Announcement => ({ paths, outcome: "failed", detail: (error instanceof Error ? error.message : String(error)).slice(0, ANNOUNCE_DETAIL_MAX) });

type Disposition = "published" | "preview" | Outcome;
type Note = { urlKey: string; outcome: Disposition; reason: string };

const itemSchema = candidateSchema.extend({ host: z.string() });
const workSchema = z.object({ candidates: z.array(z.object({ urlKey: z.string(), cluster: z.object({ items: z.array(itemSchema), score: z.number(), lead: itemSchema }) })) });

const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const validTime = (value: string | null | undefined): number | null => { const time = value ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : null; };

/** The record a signal is published as. A source date is never later than we first saw the item, or than now; an unreadable one is left out. */
function buildRecord(cluster: Cluster, draft: SignalDraft & { summary: string }, row: TriageRow, evidence: NonNullable<EvidenceResult["evidence"]>, grounding: { evaluator: string; verdict: SummaryVerdict; replaced: boolean }, now: Date): SignalRecord {
  const seen = cluster.items.map((item) => validTime(item.firstSeenAt)).filter((time): time is number => time !== null);
  const firstSeen = seen.length ? Math.min(...seen) : now.getTime();
  const stated = validTime(cluster.lead.publishedAt) ?? cluster.items.map((item) => validTime(item.publishedAt)).find((time): time is number => time !== null) ?? null;
  const sources = [{ label: publisherLabel(cluster.lead), url: cluster.lead.url }, ...evidence.sources].filter((source, i, all) => all.findIndex(({ url }) => url === source.url) === i).slice(0, 8);
  const { verdict } = grounding;
  // What the record says was checked is what is published: when a verified fact replaced the summary, it is that fact's check and not the sentences it replaced.
  const summaryChecks = grounding.replaced && verdict.fact ? [{ text: draft.summary, verdict: "supported", supported: verdict.fact.supported }] : verdict.sentences;
  return signalRecordSchema.parse({
    version: 1, id: signalId(cluster.lead.url), url: cluster.lead.url, sources, headline: draft.headline, summary: draft.summary, type: storyType(cluster.lead.url), topics: row.topics,
    project: signalProject(cluster), publisher: publisherLabel(cluster.lead), sourcePublishedAt: stated === null ? null : new Date(Math.min(stated, firstSeen, now.getTime())).toISOString(),
    firstSeenAt: new Date(firstSeen).toISOString(), publishedAt: now.toISOString(), traction: traction(cluster), importance: row.importance,
    facts: evidence.facts.map(({ fact, quote, impact }) => ({ fact, quote, impact: Math.round(impact * 100) / 100 })),
    evidence: { documentIds: evidence.documentIds, capturedAt: evidence.capturedAt, basis: evidence.basis,
      grounding: { evaluator: grounding.evaluator, verdicts: [{ text: draft.headline, verdict: verdict.headline.verdict, supported: verdict.headline.supported }, ...summaryChecks] } },
    status: "live",
  });
}

export async function produceSignals(steps: Steps, job: SignalsJob, deps: SignalsDeps): Promise<SignalsResult> {
  const { service } = deps;
  const clock = deps.now ?? (() => new Date());
  const start = new Date(job.now);
  const day = job.now.slice(0, 10);
  const stamp = `${day}/${job.now.slice(11, 13)}${job.now.slice(14, 16)}`;
  const workKey = `signals/work/${stamp}-${job.lane}.json`;
  const usage: Usage[] = [];
  const notes = new Map<string, Note>();
  const note = (urlKey: string, outcome: Disposition, reason: string) => { notes.set(urlKey, { urlKey, outcome, reason }); };
  let triaged = 0;
  let claimed = 0;
  const drafted: { id: string; urlKey: string; headline: string; summary: string }[] = [];

  const found = await steps.run("candidates", IO_STEP, async () => {
    // A run that failed part-way leaves its work file; those of earlier days are stale. Today's may belong to a run still going.
    for (const key of await listPrivateJsonKeys("signals/work/")) if (!key.startsWith(`signals/work/${day}/`)) await deletePrivateJson(key);
    const next = await nextCandidates(service, start);
    if (next.candidates.length) await writePrivateJson(workKey, { candidates: next.candidates });
    return { urlKeys: next.candidates.map(({ urlKey }) => urlKey), cursor: next.cursor, read: next.read, invalid: next.invalid, publishedToday: await service.publishedToday(day) };
  });
  const room = Math.max(0, Math.min(CAPS[job.lane], CAPS.day - found.publishedToday));
  const window = found.urlKeys.slice(0, room * TRIAGE_FACTOR);
  const dayFull = room === 0 ? found.urlKeys.length : 0;
  const ids: string[] = [];
  let announced: Announcement | null = null;

  if (window.length) {
    // In a preview nothing is claimed: another run may be working on the same items, and it is not told.
    const owned = await steps.run("claim", IO_STEP, async () => job.publish ? service.claim(window, job.now) : window);
    claimed = job.publish ? owned.length : 0;
    if (owned.length) {
      const stored = workSchema.parse(await readPrivateJson(workKey));
      const byKey = new Map(stored.candidates.map(({ urlKey, cluster }) => [urlKey, cluster]));
      const entries = owned.flatMap((urlKey, i) => byKey.has(urlKey) ? [{ id: `c${i}`, urlKey, cluster: byKey.get(urlKey)! }] : []);
      for (const urlKey of owned) if (!byKey.has(urlKey)) note(urlKey, "failed", "the run's candidates were lost");

      // ---- triage: which are worth the cost of reading, and in what order
      const batches = await Promise.all(chunks(entries, TRIAGE_BATCH).map((batch, b) => steps.run(`triage-${b}`, MODEL_STEP, async () => deps.triage(batch.map(({ id, cluster }) => ({ id, cluster }))))));
      usage.push(...batches.map((batch) => batch.usage));
      const rows = new Map<string, TriageRow>();
      for (const { rows: list } of batches) for (const row of list) if (!rows.has(row.id)) rows.set(row.id, row);
      triaged = rows.size;
      const eligible = entries.flatMap((entry) => {
        const row = rows.get(entry.id);
        if (!row) { note(entry.urlKey, "failed", "triage returned no row for it"); return []; }
        const tier1 = isTier1FirstParty(entry.cluster.lead);
        const floor = tier1 ? MIN_IMPORTANCE_TIER1 : MIN_IMPORTANCE;
        if (!row.keep || row.section === "offtopic") { note(entry.urlKey, "rejected", "triage dropped it"); return []; }
        if (row.importance < floor) { note(entry.urlKey, "rejected", `importance ${row.importance} is below ${floor}`); return []; }
        return [{ entry, row, tier1 }];
      }).sort((a, b) => Number(b.tier1) - Number(a.tier1) || b.row.importance - a.row.importance || b.entry.cluster.score - a.entry.cluster.score || a.entry.id.localeCompare(b.entry.id));
      const selected = eligible.slice(0, room);
      // Over the cap is not a verdict on the item: it goes back, free, for the next run.
      for (const { entry } of eligible.slice(room)) note(entry.urlKey, "skipped", "over the cap for this run or day");

      // ---- evidence: a verified fact, or nothing is published
      const evidence = new Map<string, EvidenceResult>();
      for (let at = 0; at < selected.length; at += EVIDENCE_CONCURRENCY) {
        const wave = selected.slice(at, at + EVIDENCE_CONCURRENCY);
        const results = await Promise.all(wave.map(({ entry }, j) => steps.run(`evidence-${at + j}`, MODEL_STEP, async () => deps.evidence(day, entry.cluster))));
        results.forEach((result, j) => { evidence.set(wave[j].entry.id, result); usage.push(...result.usage); });
      }
      const verified = selected.flatMap((item) => {
        const result = evidence.get(item.entry.id);
        if (result?.evidence) return [{ ...item, evidence: result.evidence }];
        note(item.entry.urlKey, "failed", `no verified evidence (${result?.reason ?? "none"}${result?.detail ? `: ${result.detail}` : ""})`);
        return [];
      });

      // ---- write, check, and repair once
      const itemOf = ({ entry, evidence: proof }: (typeof verified)[number]): DraftItem => ({ title: entry.cluster.lead.title, project: signalProject(entry.cluster), facts: proof.facts.map(({ fact, quote }) => ({ fact, quote })) });
      const writerItem = (item: (typeof verified)[number]): WriterItem => ({ id: item.entry.id, title: item.entry.cluster.lead.title, project: signalProject(item.entry.cluster), facts: item.evidence.facts.map(({ fact }) => fact) });
      const known = new Set(verified.map(({ entry }) => entry.id));
      const drafts = new Map<string, SignalDraft>();
      const keep = (list: SignalDraft[]) => { for (const draft of list) if (known.has(draft.id)) drafts.set(draft.id, cleanDraft(draft)); };
      if (verified.length) {
        const first = await steps.run("write", MODEL_STEP, async () => deps.write(verified.map(writerItem)));
        usage.push(first.usage);
        keep(first.drafts);
        const broken = verified.filter((item) => drafts.has(item.entry.id) && draftProblems(drafts.get(item.entry.id)!, itemOf(item)).length);
        if (broken.length) {
          // Each problem names its item by id and never repeats the draft's words.
          const problems = broken.flatMap((item) => draftProblems(drafts.get(item.entry.id)!, itemOf(item)).map((problem) => `[${item.entry.id}] ${problem}`));
          const repaired = await steps.run("repair", MODEL_STEP, async () => deps.write(broken.map(writerItem), { drafts: broken.map((item) => drafts.get(item.entry.id)!), problems }));
          usage.push(repaired.usage);
          keep(repaired.drafts.filter((draft) => broken.some((item) => item.entry.id === draft.id)));
        }
      }
      const written = verified.flatMap((item) => {
        const draft = drafts.get(item.entry.id);
        if (!draft) { note(item.entry.urlKey, "failed", "the writer returned no draft"); return []; }
        const problems = draftProblems(draft, itemOf(item));
        if (problems.length) { note(item.entry.urlKey, "failed", `still has problems after one repair (${problems.length}): ${problems[0]}`); return []; }
        return [{ ...item, draft }];
      });

      // ---- a repost of a headline we already published, or of one written in this run, is not a second signal
      const published = await steps.run("recent", IO_STEP, async () => (await service.recentHeadlines(new Date(start.getTime() - REPOST_WINDOW_MS).toISOString())).map(({ headline, url }) => ({ headline, url })));
      const seenHeadlines: PublishedHeadline[] = [...published];
      const fresh = written.filter((item) => {
        if (isRepost(item.draft.headline, repostable(item.tier1, seenHeadlines))) { note(item.entry.urlKey, "rejected", "a repost of a headline already published"); return false; }
        seenHeadlines.push({ headline: item.draft.headline, url: item.entry.cluster.lead.url });
        return true;
      });

      // ---- ground: the headline and each sentence against the quotes, and what would replace a failing summary against its own
      const grounded = fresh.length ? await steps.run("ground", MODEL_STEP, async () => {
        const result = await deps.ground(fresh.map((item) => ({ id: item.entry.id, headline: item.draft.headline, summary: item.draft.summary, facts: [...item.evidence.facts].sort((a, b) => b.impact - a.impact).map(({ fact, quote }) => ({ fact, quote })) })));
        return { verdicts: [...result.verdicts], evaluator: result.evaluator, usage: result.usage };
      }) : { verdicts: [] as [string, SummaryVerdict][], evaluator: "none", usage: [] as Usage[] };
      usage.push(...grounded.usage);
      const verdicts = new Map(grounded.verdicts);
      const settled = fresh.flatMap((item) => {
        const verdict = verdicts.get(item.entry.id);
        const result = settleSummary(item.draft, verdict, itemOf(item));
        if (result.dropped || !verdict) { note(item.entry.urlKey, "failed", `not grounded: ${result.reason}`); return []; }
        return [{ ...item, summary: result.summary, verdict, replaced: result.fallback }];
      });

      // ---- publish what was settled: the text that was grounded is the text that is published
      const result = await steps.run("publish", IO_STEP, async () => {
        const created: { id: string; urlKey: string; headline: string; summary: string }[] = [];
        const rest: Note[] = [];
        let today = await service.publishedToday(day);
        // Another run may have published the same story since the repost check, so it is made again, now, before each publication.
        const recent: PublishedHeadline[] = (await service.recentHeadlines(new Date(start.getTime() - REPOST_WINDOW_MS).toISOString())).map(({ headline, url }) => ({ headline, url }));
        for (const item of settled) {
          let record: SignalRecord;
          try { record = buildRecord(item.entry.cluster, { ...item.draft, summary: item.summary }, item.row, item.evidence, { evaluator: grounded.evaluator, verdict: item.verdict, replaced: item.replaced }, clock()); }
          catch { rest.push({ urlKey: item.entry.urlKey, outcome: "failed", reason: "the record failed validation" }); continue; }
          // Another run may have filled the day since this one began.
          if (today >= CAPS.day) { rest.push({ urlKey: item.entry.urlKey, outcome: "skipped", reason: "the day's cap was reached" }); continue; }
          if (isRepost(record.headline, repostable(item.tier1, recent))) { rest.push({ urlKey: item.entry.urlKey, outcome: "rejected", reason: "a repost of a headline published meanwhile" }); continue; }
          if (job.publish) {
            if ((await service.publish(record)) === "created") today += 1;
          }
          recent.push({ headline: record.headline, url: record.url });
          created.push({ id: record.id, urlKey: item.entry.urlKey, headline: record.headline, summary: record.summary });
        }
        return { created, rest };
      });
      for (const entry of result.rest) note(entry.urlKey, entry.outcome, entry.reason);
      for (const entry of result.created) { note(entry.urlKey, job.publish ? "published" : "preview", job.publish ? "published" : "would be published"); ids.push(entry.id); drafted.push(entry); }

      // ---- announce: once per run, after the store can serve the pages, and before anything that could still fail the run
      const paths = job.publish && deps.announce ? signalPaths(ids) : [];
      if (paths.length) {
        const ping = deps.announce!;
        try {
          announced = await steps.run("announce", ANNOUNCE_STEP, async (): Promise<Announcement> => {
            try {
              const answer = await ping(paths);
              return "skipped" in answer ? { paths: paths.length, outcome: "skipped", detail: answer.skipped } : { paths: paths.length, outcome: "sent", detail: `status ${answer.status}` };
            } catch (error) { return announcementFailed(paths.length, error); }
          });
        } catch (error) { announced = announcementFailed(paths.length, error); }
      }

      // ---- give each claim its outcome, then move the cursor: a crash before this leaves it where it was
      if (job.publish) {
        const outcomes = owned.map((urlKey): [string, Outcome] => { const n = notes.get(urlKey); return [urlKey, !n ? "skipped" : n.outcome === "published" ? "published" : n.outcome === "preview" ? "skipped" : n.outcome]; });
        await steps.run("release", IO_STEP, async () => { for (const [urlKey, outcome] of outcomes) await service.release(urlKey, outcome, job.now); return true; });
      }
    }
  }
  // Everything was looked at (nothing beyond the window), so what was read need not be read again.
  if (job.publish && room > 0 && found.urlKeys.length <= window.length) await steps.run("cursor", IO_STEP, async () => { await service.setValue(CURSOR_KEY, found.cursor); return true; });

  const outcomes = [...notes.values()];
  const count = (outcome: Disposition) => outcomes.filter((entry) => entry.outcome === outcome).length;
  const result: SignalsResult = {
    considered: found.urlKeys.length, claimed, triaged, published: count("published") + count("preview"), skippedCap: count("skipped") + dayFull, failed: count("failed"), rejected: count("rejected"),
    preview: !job.publish, cost: usage.reduce((sum, entry) => sum + (entry.cost ?? 0), 0), ids,
  };
  await steps.run("report", IO_STEP, async () => {
    await writePrivateJson(`signals/runs/${stamp}.json`, {
      version: 1, now: job.now, lane: job.lane, ...result, read: found.read, invalid: found.invalid, cursor: found.cursor, dayFull, outcomes, announced,
      ...(job.publish ? {} : { drafts: drafted }),
      usage: usage.map(({ step, model, ms, inputTokens, outputTokens, cost }) => ({ step, model, ms, inputTokens, outputTokens, cost })),
    });
    await deletePrivateJson(workKey);
    return true;
  });
  return result;
}
