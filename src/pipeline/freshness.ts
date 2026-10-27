import type { Candidate } from "../lib/schemas.js";

// A daily issue reports everything new since the previous issue, so news always lands
// in the very next issue and a missed day never ages anything out. The window starts
// a little before the previous issue went out (its sources were read earlier) and never
// reaches back further than MAX_LOOKBACK_HOURS. Items already reported are removed by URL.
export const FIRST_ISSUE_HOURS = 36;
export const PREVIOUS_ISSUE_OVERLAP_HOURS = 12;
export const MAX_LOOKBACK_HOURS = 72;

export function freshnessWindowStart(reference: number, previousPublishedAt: number | null): number {
  const floor = reference - MAX_LOOKBACK_HOURS * 3_600_000;
  if (previousPublishedAt === null) return reference - FIRST_ISSUE_HOURS * 3_600_000;
  return Math.max(floor, previousPublishedAt - PREVIOUS_ISSUE_OVERLAP_HOURS * 3_600_000);
}

const parse = (value: string | null | undefined) => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

// Many publishers give a day and no time, which parses to midnight UTC. Taken literally that
// makes an item look up to a day older than it is, and a window that opens mid-morning drops it.
// The item cannot be newer than the day it names or than our first sighting, so the earlier of
// the day's last moment and that sighting is its latest possible publication time.
const DATE_ONLY = /T00:00:00(?:\.000)?Z$/;

/** When the item became news: the source's own time, else the moment a page changed, else when we first saw it. */
export function candidateTime(candidate: Candidate): number | null {
  const published = parse(candidate.publishedAt);
  if (published !== null) {
    const seen = parse(candidate.firstSeenAt);
    return DATE_ONLY.test(candidate.publishedAt ?? "") && seen !== null ? Math.min(seen, published + 86_400_000 - 1) : published;
  }
  // A changed page keeps the time we first saw it, which says nothing about the change.
  return (candidate.dateKind === "changed" ? parse(candidate.observedAt) : null) ?? parse(candidate.submittedAt) ?? parse(candidate.firstSeenAt);
}

export function isFreshCandidate(candidate: Candidate, reference: number, since: number): boolean {
  const time = candidateTime(candidate);
  // Undated items cannot show they are new, so they do not compete for today's issue.
  return time !== null && time <= reference + 3_600_000 && time >= since;
}

const stopWords = new Set("the and for with from this that into using use new model models release releases ai introduces introducing update updates".split(" "));
export const terms = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).filter((word) => !stopWords.has(word)));
export const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((term) => b.has(term)).length / Math.max(1, Math.min(a.size, b.size));

export function textSimilarity(left: string, right: string): number {
  return overlap(terms(left), terms(right));
}
