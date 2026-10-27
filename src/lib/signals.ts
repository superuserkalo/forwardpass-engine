import { createHash } from "node:crypto";
import { z } from "zod";
import { entryKey } from "./entry-key.js";
import { FEED_TOPICS, storyTypeSchema } from "./issue.js";

// A signal is a short, quote-verified item published within minutes of its source going live. The record is the
// public contract: the API, the pages, the feed and the agent tools all serve it. SignalStore is the one SQL
// authority behind it, a pure class over Durable Object storage (the pattern ChatSubscriptions uses), so claims are
// atomic across overlapping runs and the whole thing is tested on node:sqlite.

export type Topic = (typeof FEED_TOPICS)[number];

/** A time written any way, kept as one canonical UTC string so that strings compare as times. */
const time = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "not a time").transform((value) => new Date(value).toISOString());
const httpsUrl = z.string().url().startsWith("https://");

/** The shape of a signal id, which is all anything outside the store may assume about one. */
const SIGNAL_ID = /^g-[a-f0-9]{16}$/;
export const isSignalId = (value: string): boolean => SIGNAL_ID.test(value);

export const signalRecordSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(SIGNAL_ID),
  url: httpsUrl,
  /** The primary source and every page a fact was taken from. */
  sources: z.array(z.object({ label: z.string().min(1), url: httpsUrl })).min(1).max(8),
  headline: z.string().min(1).max(200),
  summary: z.string().min(1).max(700),
  type: storyTypeSchema,
  topics: z.array(z.enum(FEED_TOPICS)).max(3),
  project: z.string().nullable(),
  publisher: z.string().min(1),
  /** The source's own date when it gave one. */
  sourcePublishedAt: time.nullable(),
  /** When the collector first saw the item. */
  firstSeenAt: time,
  publishedAt: time,
  /** "1,762 HN points" and the like, printed by code from measurements, never written by a model. */
  traction: z.string().nullable(),
  importance: z.number().min(0).max(10),
  /** At least one, and every quote was found verbatim in the captured text: a signal without one is never published. */
  facts: z.array(z.object({ fact: z.string().min(1), quote: z.string().min(1), impact: z.number().min(0).max(10) })).min(1).max(12),
  evidence: z.object({
    documentIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8),
    capturedAt: time,
    /** "page" when the quotes were checked against the captured source page, "feed-summary" when the page could not be captured. */
    basis: z.enum(["page", "feed-summary"]),
    grounding: z.object({ evaluator: z.string(), verdicts: z.array(z.object({ text: z.string(), verdict: z.string(), supported: z.number() })) }),
  }).refine(({ basis, documentIds }) => basis !== "page" || documentIds.length > 0, "a page basis needs the captured document"),
  status: z.enum(["live", "corrected", "retracted"]),
});
export type SignalRecord = z.infer<typeof signalRecordSchema>;

/** Stable and date-independent: the same page is the same signal however its URL is spelled. */
export const signalId = (url: string): string => `g-${createHash("sha256").update(entryKey(url)).digest("hex").slice(0, 16)}`;
export const urlKey = (url: string): string => entryKey(url);

export type SignalSummary = Pick<SignalRecord, "id" | "headline" | "summary" | "type" | "topics" | "publisher" | "publishedAt" | "sourcePublishedAt" | "traction" | "importance" | "url" | "status"> & { evidenceCount: number };
export type ListQuery = { limit?: number; before?: string; since?: string; type?: SignalRecord["type"]; topic?: string; minImportance?: number; q?: string };
export type CorrectionPatch = { headline?: string; summary?: string };
/** How a claim ends. Published and rejected are final for a while, failed is retried after a pause up to three times, skipped (a cap, not a verdict) is free at once and charges nothing. */
export type Outcome = "published" | "rejected" | "failed" | "skipped";
const OUTCOMES: readonly string[] = ["published", "rejected", "failed", "skipped"] satisfies readonly Outcome[];
export type Correction = { signalId: string; at: string; kind: "correction" | "retraction"; note: string; before: CorrectionPatch | null };
export type SignalStats = { published: number; medianLatencyMinutes: number | null; pageVerifiedShare: number | null; corrections: number };

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
type EvaluatedRow = { state: string; attempts: number; at: string; claim_until: string | null };
type ListRow = { id: string; url: string; headline: string; summary: string; type: string; topics: string; publisher: string; published_at: string; source_published_at: string | null; traction: string | null; importance: number; status: string; evidence_count: number };

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, url_key TEXT NOT NULL UNIQUE, published_at TEXT NOT NULL, type TEXT NOT NULL, importance REAL NOT NULL, publisher TEXT NOT NULL, headline TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS signals_by_time ON signals(published_at DESC, id DESC)",
  "CREATE TABLE IF NOT EXISTS signal_topics (signal_id TEXT NOT NULL, topic TEXT NOT NULL, PRIMARY KEY (signal_id, topic))",
  "CREATE INDEX IF NOT EXISTS signal_topics_by_topic ON signal_topics(topic, signal_id)",
  "CREATE TABLE IF NOT EXISTS evaluated (url_key TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, claim_until TEXT)",
  "CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, before TEXT)",
  "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

/** A claim lapses after this long, so a crashed run's items are retried by the next one. */
export const CLAIM_MS = 30 * 60_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const REJECTION_MS = 3 * 86_400_000;
/** Failures and lapsed claims an item may use up before it is given up on. */
const MAX_ATTEMPTS = 3;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function iso(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`Not a time: ${value}`);
  return new Date(ms).toISOString();
}

const CURSOR = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\|(g-[a-f0-9]{16})$/;
const encodeCursor = (publishedAt: string, id: string): string => Buffer.from(`${publishedAt}|${id}`).toString("base64url");
function decodeCursor(cursor: string): [string, string] {
  const match = CURSOR.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) throw new Error("Invalid cursor");
  return [match[1], match[2]];
}

/** Whether a string is a cursor this store issued, so a caller can refuse a bad one without asking the store. */
export function isCursor(value: string): boolean {
  try { decodeCursor(value); return true; } catch { return false; }
}

// SQLite folds only ASCII case; folding the query the same way keeps both sides of the comparison alike.
const foldCase = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Signals and the bookkeeping that keeps overlapping runs from paying twice for, or publishing, one item. */
export class SignalStore {
  constructor(private readonly storage: Storage) {
    for (const statement of SCHEMA) storage.sql.exec(statement);
  }

  /**
   * The subset of `urlKeys` this caller now owns. An item is claimable when it was never evaluated, its last claim
   * lapsed, it failed at least ten minutes ago, or it was rejected three days ago; never when it is published, held by
   * a live claim, or has used up its attempts. A claim that lapses counts as an attempt, so an item that keeps
   * crashing its runs is given up on.
   */
  claim(urlKeys: string[], now: string, ttlMs = CLAIM_MS): string[] {
    const at = Date.parse(iso(now));
    const until = new Date(at + ttlMs).toISOString();
    return this.storage.transactionSync(() => {
      const owned: string[] = [];
      for (const key of new Set(urlKeys)) {
        const verdict = this.claimable(key, at);
        if (verdict === null) continue;
        this.storage.sql.exec("INSERT OR REPLACE INTO evaluated(url_key, state, attempts, at, claim_until) VALUES (?, 'claimed', ?, ?, ?)", key, verdict, new Date(at).toISOString(), until);
        owned.push(key);
      }
      return owned;
    });
  }

  /** The subset of `urlKeys` that claim would refuse right now, each once, in order. It changes nothing. */
  unavailable(urlKeys: string[], now: string): string[] {
    const at = Date.parse(iso(now));
    return [...new Set(urlKeys)].filter((key) => this.claimable(key, at) === null);
  }

  /** Which of `urlKeys` already have a signal, each once, in order: a story that is covered however its other URLs stand. */
  published(urlKeys: string[]): string[] {
    const keys = [...new Set(urlKeys)];
    const found = new Set<string>();
    // A query takes a bounded number of variables, so a long list is asked in parts.
    for (let at = 0; at < keys.length; at += 200) {
      const part = keys.slice(at, at + 200);
      for (const row of this.storage.sql.exec<{ url_key: string }>(`SELECT url_key FROM signals WHERE url_key IN (${part.map(() => "?").join(", ")})`, ...part).toArray()) found.add(row.url_key);
    }
    return keys.filter((key) => found.has(key));
  }

  /** The attempts a new claim on `key` would carry, or null when it may not be claimed at `at` (milliseconds). */
  private claimable(key: string, at: number): number | null {
    if (this.storage.sql.exec("SELECT 1 AS found FROM signals WHERE url_key = ?", key).toArray().length) return null;
    const row = this.storage.sql.exec<EvaluatedRow>("SELECT state, attempts, at, claim_until FROM evaluated WHERE url_key = ?", key).toArray()[0];
    if (!row) return 0;
    let attempts = row.attempts;
    if (row.state === "published") return null;
    if (row.state === "rejected") return at - Date.parse(row.at) < REJECTION_MS ? null : attempts;
    if (attempts >= MAX_ATTEMPTS) return null;
    if (row.state === "skipped") return attempts;
    if (row.state === "failed") return at - Date.parse(row.at) < RETRY_AFTER_FAILURE_MS ? null : attempts;
    if (row.state === "claimed") {
      if (Date.parse(row.claim_until ?? row.at) > at) return null;
      // The claim that lapsed was an attempt that never finished.
      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) return null;
    }
    return attempts;
  }

  /** Ends a claim; see Outcome. An outcome that is not one of them is refused rather than stored as something claimable. */
  release(urlKey: string, outcome: Outcome, now: string): void {
    if (!OUTCOMES.includes(outcome)) throw new Error(`Unknown outcome: ${outcome}`);
    const at = iso(now);
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<EvaluatedRow>("SELECT state, attempts, at, claim_until FROM evaluated WHERE url_key = ?", urlKey).toArray()[0];
      this.storage.sql.exec("INSERT OR REPLACE INTO evaluated(url_key, state, attempts, at, claim_until) VALUES (?, ?, ?, ?, NULL)", urlKey, outcome, (row?.attempts ?? 0) + (outcome === "failed" ? 1 : 0), at);
    });
  }

  /** Idempotent on the id and on the URL key: a second publish of the same page is "exists" and changes nothing. */
  publish(record: SignalRecord): "created" | "exists" {
    const parsed = signalRecordSchema.parse(record);
    if (parsed.id !== signalId(parsed.url)) throw new Error("The signal id is not the id of its URL");
    const key = urlKey(parsed.url);
    return this.storage.transactionSync(() => {
      if (this.storage.sql.exec("SELECT 1 AS found FROM signals WHERE id = ? OR url_key = ?", parsed.id, key).toArray().length) return "exists";
      this.storage.sql.exec("INSERT INTO signals(id, url_key, published_at, type, importance, publisher, headline, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        parsed.id, key, parsed.publishedAt, parsed.type, parsed.importance, parsed.publisher, parsed.headline, JSON.stringify(parsed), parsed.status);
      for (const topic of parsed.topics) this.storage.sql.exec("INSERT OR IGNORE INTO signal_topics(signal_id, topic) VALUES (?, ?)", parsed.id, topic);
      const row = this.storage.sql.exec<EvaluatedRow>("SELECT state, attempts, at, claim_until FROM evaluated WHERE url_key = ?", key).toArray()[0];
      this.storage.sql.exec("INSERT OR REPLACE INTO evaluated(url_key, state, attempts, at, claim_until) VALUES (?, 'published', ?, ?, NULL)", key, row?.attempts ?? 0, parsed.publishedAt);
      return "created";
    });
  }

  get(id: string): SignalRecord | null {
    const row = this.storage.sql.exec<{ body: string; status: string }>("SELECT body, status FROM signals WHERE id = ?", id).toArray()[0];
    return row ? signalRecordSchema.parse({ ...JSON.parse(row.body), status: row.status }) : null;
  }

  /** Newest first, retracted signals left out. `next` encodes the (published_at, id) of the last row, so equal times neither repeat nor skip. */
  list(query: ListQuery = {}): { signals: SignalSummary[]; next: string | null } {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where = ["status != 'retracted'"];
    const bindings: (string | number)[] = [];
    if (query.before) {
      const [publishedAt, id] = decodeCursor(query.before);
      where.push("(published_at < ? OR (published_at = ? AND id < ?))");
      bindings.push(publishedAt, publishedAt, id);
    }
    if (query.since) { where.push("published_at >= ?"); bindings.push(iso(query.since)); }
    if (query.type) { where.push("type = ?"); bindings.push(query.type); }
    if (query.topic) { where.push("EXISTS (SELECT 1 FROM signal_topics t WHERE t.signal_id = signals.id AND t.topic = ?)"); bindings.push(query.topic); }
    if (query.minImportance !== undefined) { where.push("importance >= ?"); bindings.push(query.minImportance); }
    if (query.q) {
      // instr compares text literally, so a percent sign or underscore in the query means itself.
      const needle = foldCase(query.q.slice(0, 100));
      where.push("(instr(lower(headline), ?) > 0 OR instr(lower(json_extract(body, '$.summary')), ?) > 0)");
      bindings.push(needle, needle);
    }
    const rows = this.storage.sql.exec<ListRow>(
      `SELECT id, json_extract(body, '$.url') AS url, headline, json_extract(body, '$.summary') AS summary, type, json_extract(body, '$.topics') AS topics, publisher, published_at,
         json_extract(body, '$.sourcePublishedAt') AS source_published_at, json_extract(body, '$.traction') AS traction, importance, status, json_array_length(body, '$.facts') AS evidence_count
       FROM signals WHERE ${where.join(" AND ")} ORDER BY published_at DESC, id DESC LIMIT ?`, ...bindings, limit + 1).toArray();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      signals: page.map((row): SignalSummary => ({
        id: row.id, url: row.url, headline: row.headline, summary: row.summary, type: storyTypeSchema.parse(row.type), topics: z.array(z.enum(FEED_TOPICS)).parse(JSON.parse(row.topics)),
        publisher: row.publisher, publishedAt: row.published_at, sourcePublishedAt: row.source_published_at, traction: row.traction, importance: row.importance,
        status: z.enum(["live", "corrected", "retracted"]).parse(row.status), evidenceCount: row.evidence_count,
      })),
      next: rows.length > limit && last ? encodeCursor(last.published_at, last.id) : null,
    };
  }

  /** What was published since, with the address each is published for, so a caller can tell whose it is: for dropping a repost before any model is paid to look at it. */
  recentHeadlines(sinceIso: string): { id: string; headline: string; url: string }[] {
    return this.storage.sql.exec<{ id: string; headline: string; url: string }>("SELECT id, headline, json_extract(body, '$.url') AS url FROM signals WHERE published_at >= ? ORDER BY published_at DESC LIMIT 500", iso(sinceIso)).toArray().map(({ id, headline, url }) => ({ id, headline, url }));
  }

  /** How many were published on a UTC day (YYYY-MM-DD), for the daily cap. */
  publishedToday(dayUtc: string): number {
    if (!/^\d{4}-\d\d-\d\d$/.test(dayUtc)) throw new RangeError(`Not a day: ${dayUtc}`);
    return Number(this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM signals WHERE substr(published_at, 1, 10) = ?", dayUtc).toArray()[0]?.n ?? 0);
  }

  getValue(key: string): string | null {
    return this.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0]?.value ?? null;
  }
  setValue(key: string, value: string): void {
    this.storage.sql.exec("INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)", key, value);
  }

  /**
   * Corrects the text of a signal or retracts it, and logs what it replaced. A retraction changes the status and leaves
   * the text; a retracted signal is final. False when there is no such signal or it is already retracted.
   */
  correct(id: string, kind: "correction" | "retraction", note: string, now: string, patch: CorrectionPatch = {}): boolean {
    if (!note.trim()) throw new Error("A correction needs a note saying what was wrong");
    const at = iso(now);
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ body: string; status: string }>("SELECT body, status FROM signals WHERE id = ?", id).toArray()[0];
      if (!row || row.status === "retracted") return false;
      const record = signalRecordSchema.parse({ ...JSON.parse(row.body), status: row.status });
      const before: CorrectionPatch = {};
      const next = { ...record, status: kind === "retraction" ? "retracted" as const : "corrected" as const };
      if (kind === "correction") for (const field of ["headline", "summary"] as const) {
        const value = patch[field];
        if (value !== undefined && value !== record[field]) { before[field] = record[field]; next[field] = value; }
      }
      const valid = signalRecordSchema.parse(next);
      this.storage.sql.exec("UPDATE signals SET headline = ?, body = ?, status = ? WHERE id = ?", valid.headline, JSON.stringify(valid), valid.status, id);
      this.storage.sql.exec("INSERT INTO corrections(signal_id, at, kind, note, before) VALUES (?, ?, ?, ?, ?)", id, at, kind, note.trim(), Object.keys(before).length ? JSON.stringify(before) : null);
      return true;
    });
  }

  /** The public log, newest first. */
  corrections(limit = 50): Correction[] {
    return this.storage.sql.exec<{ signal_id: string; at: string; kind: string; note: string; before: string | null }>(
      "SELECT signal_id, at, kind, note, before FROM corrections ORDER BY id DESC LIMIT ?", Math.min(Math.max(Math.trunc(limit) || 50, 1), 200)).toArray()
      .map((row): Correction => ({ signalId: row.signal_id, at: row.at, kind: row.kind === "retraction" ? "retraction" : "correction", note: row.note, before: row.before ? z.object({ headline: z.string().optional(), summary: z.string().optional() }).parse(JSON.parse(row.before)) : null }));
  }

  /**
   * The scorecard's numbers since a time. Latency runs from the source's own time (ours, when it gave none) to ours, and
   * is null with nothing published. The share is the signals whose quotes were checked against the captured source page
   * and not a feed summary; every published fact is verified, so that is the measure that can move.
   */
  stats(sinceIso: string): SignalStats {
    const since = iso(sinceIso);
    const rows = this.storage.sql.exec<{ published_at: string; detected: string; basis: string }>(
      `SELECT published_at, COALESCE(json_extract(body, '$.sourcePublishedAt'), json_extract(body, '$.firstSeenAt')) AS detected, json_extract(body, '$.evidence.basis') AS basis
       FROM signals WHERE published_at >= ? AND status != 'retracted'`, since).toArray();
    const minutes = rows.map((row) => Math.max(0, Date.parse(row.published_at) - Date.parse(row.detected)) / 60_000).sort((a, b) => a - b);
    const middle = Math.floor(minutes.length / 2);
    const median = minutes.length === 0 ? null : minutes.length % 2 ? minutes[middle] : (minutes[middle - 1] + minutes[middle]) / 2;
    const corrections = Number(this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM corrections WHERE at >= ?", since).toArray()[0]?.n ?? 0);
    return {
      published: rows.length,
      medianLatencyMinutes: median === null ? null : Math.round(median * 10) / 10,
      pageVerifiedShare: rows.length === 0 ? null : rows.filter((row) => row.basis === "page").length / rows.length,
      corrections,
    };
  }
}
