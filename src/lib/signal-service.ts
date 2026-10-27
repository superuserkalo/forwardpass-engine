import type { Correction, CorrectionPatch, ListQuery, Outcome, SignalRecord, SignalStats, SignalStore, SignalSummary } from "./signals.js";

/**
 * What the pipeline and the API need from the signal store, async so a Durable Object stub and a local store both fit.
 * The Durable Object is the single writer in production; the local service wraps a store directly in tests and previews.
 */
export interface SignalService {
  claim(urlKeys: string[], now: string, ttlMs?: number): Promise<string[]>;
  /** What claim would refuse right now, without claiming: published, held, rejected lately, failed lately or out of attempts. */
  unavailable(urlKeys: string[], now: string): Promise<string[]>;
  /** Which of these URLs already have a signal. */
  published(urlKeys: string[]): Promise<string[]>;
  release(urlKey: string, outcome: Outcome, now: string): Promise<void>;
  publish(record: SignalRecord): Promise<"created" | "exists">;
  get(id: string): Promise<SignalRecord | null>;
  list(query?: ListQuery): Promise<{ signals: SignalSummary[]; next: string | null }>;
  recentHeadlines(sinceIso: string): Promise<{ id: string; headline: string; url: string }[]>;
  publishedToday(dayUtc: string): Promise<number>;
  getValue(key: string): Promise<string | null>;
  setValue(key: string, value: string): Promise<void>;
  correct(id: string, kind: "correction" | "retraction", note: string, now: string, patch?: CorrectionPatch): Promise<boolean>;
  corrections(limit?: number): Promise<Correction[]>;
  stats(sinceIso: string): Promise<SignalStats>;
}

/** Every method of SignalService, so a test can require an implementation to name them all. */
export const SIGNAL_SERVICE_METHODS = ["claim", "unavailable", "published", "release", "publish", "get", "list", "recentHeadlines", "publishedToday", "getValue", "setValue", "correct", "corrections", "stats"] as const satisfies readonly (keyof SignalService)[];

export function localSignalService(store: SignalStore): SignalService {
  return {
    claim: async (urlKeys, now, ttlMs) => store.claim(urlKeys, now, ttlMs),
    unavailable: async (urlKeys, now) => store.unavailable(urlKeys, now),
    published: async (urlKeys) => store.published(urlKeys),
    release: async (urlKey, outcome, now) => store.release(urlKey, outcome, now),
    publish: async (record) => store.publish(record),
    get: async (id) => store.get(id),
    list: async (query) => store.list(query),
    recentHeadlines: async (sinceIso) => store.recentHeadlines(sinceIso),
    publishedToday: async (dayUtc) => store.publishedToday(dayUtc),
    getValue: async (key) => store.getValue(key),
    setValue: async (key, value) => store.setValue(key, value),
    correct: async (id, kind, note, now, patch) => store.correct(id, kind, note, now, patch),
    corrections: async (limit) => store.corrections(limit),
    stats: async (sinceIso) => store.stats(sinceIso),
  };
}
