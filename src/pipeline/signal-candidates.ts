import { entryKey } from "../lib/entry-key.js";
import type { SignalService } from "../lib/signal-service.js";
import { isVagueTitle } from "../lib/vague-title.js";
import { clusterCandidates, mergeSnapshots, previousIssues, snapshotKeys, type Cluster } from "./candidates.js";
import { isFreshCandidate, overlap, terms } from "./freshness.js";
import { isTier1, isTier1FirstParty } from "./tier1.js";

// Signals look for what is new on every run, of either lane, so they read only the collection snapshots written since
// the last run (plus a little overlap, for a snapshot that lands late) and skip whatever another run already holds.

/** Where the newest snapshot time read so far is kept, in the signal service's key-value store. */
export const CURSOR_KEY = "candidates-cursor";
/**
 * How far before the cursor to read again. A failed item is retried by later runs, so its snapshot has to stay readable
 * for the three attempts and the pauses between them, and a backlog has to be readable until it is drained.
 */
const DEFAULT_OVERLAP_MINUTES = 360;
/** News older than this is not a live signal; the daily issue still covers it. */
const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_LIMIT = 100;
const REPOST_WINDOW_HOURS = 48;
/** An overlap coefficient this high between a title and a headline we published is the same event, reposted. */
const REPOST_SIMILARITY = 0.7;
/** Fewer distinctive words than this say too little to call two titles the same ("Embed 5" overlaps everything about Embed). */
const MIN_TERMS = 3;

export type SignalCandidate = { urlKey: string; cluster: Cluster };
export type NextCandidates = { candidates: SignalCandidate[]; cursor: string; read: number; invalid: string[] };

const keyOf = (url: string): string | null => { try { return entryKey(url); } catch { return null; } };

/**
 * The tier-1 publisher's own item leads its cluster. A cluster is items that look like one story, so a repository or a
 * post titled like a launch can join it, and by score alone could lead it; but the lead is what is claimed, triaged,
 * attributed and verified, and what the tier-1 gate vouches for has to be that item and not a neighbour.
 */
const ownItemLeads = (cluster: Cluster): Cluster => {
  const own = cluster.items.find(isTier1FirstParty);
  return own && own.url !== cluster.lead.url ? { ...cluster, lead: own } : cluster;
};

/** Whether a title is the same event as one of these headlines: overlapping at least 0.7, with enough distinctive words to say so. */
export function isRepost(title: string, headlines: string[]): boolean {
  const own = terms(title);
  if (own.size < MIN_TERMS) return false;
  return headlines.some((headline) => {
    const words = terms(headline);
    return words.size >= MIN_TERMS && overlap(own, words) >= REPOST_SIMILARITY;
  });
}

export type PublishedHeadline = { headline: string; url: string };

/**
 * The published headlines a story can be a repost of. A tier-1 launch is authoritative: someone else's earlier item, which
 * anyone can make, cannot make it a repost, so it only repeats the publisher's own announcements (tier-1 addresses). Any other
 * story can repeat any headline.
 */
export const repostable = (tier1Launch: boolean, headlines: PublishedHeadline[]): string[] =>
  headlines.filter(({ url }) => !tier1Launch || isTier1(url)).map(({ headline }) => headline);

/**
 * The URLs that are the story. For a tier-1 launch: the lead and every other item on a tier-1 address (the publisher's own pages,
 * and other tier-1 publishers'), but not a repository, an article, or a forum or support page on the publisher's own domain,
 * which merely share its title. For any other story: every member.
 */
export function storyKeys(cluster: Cluster): string[] {
  const members = cluster.items.filter((item) => !isTier1FirstParty(cluster.lead) || item.url === cluster.lead.url || (item.source !== "Hacker News" && isTier1(item.url)));
  return [...new Set(members.flatMap((item) => keyOf(item.url) ?? []))];
}

/**
 * What holds a story back when it is claimed, rejected or given up on: for a tier-1 launch the story's own URLs, for anything
 * else the lead alone. The second is a trade-off, not an oversight: with no tier-1 publisher in the story nobody's own items can
 * be trusted, and honouring a neighbour's state would let anyone suppress the story with an item that gets rejected, while
 * ignoring it lets a story whose lead keeps changing have fresh attempts. The second costs money and nothing else, and the
 * cost is bounded by the per-run and per-day caps (see "Cost and capacity" in the design).
 */
const holdKeys = (cluster: Cluster): string[] => {
  if (isTier1FirstParty(cluster.lead)) return storyKeys(cluster);
  const lead = keyOf(cluster.lead.url);
  return lead ? [lead] : [];
};

/**
 * Clusters whose story an issue already reported, or whose lead title is the same event as a headline already published.
 * Trust decides which of those count: see storyKeys and repostable. Without it, anyone's item that shares a launch's title
 * could use the story up before the publisher posts.
 */
export function dropCovered(clusters: Cluster[], headlines: PublishedHeadline[], reportedUrls: Set<string>): Cluster[] {
  return clusters.filter((cluster) => !storyKeys(cluster).some((key) => reportedUrls.has(key)) && !isRepost(cluster.lead.title, repostable(isTier1FirstParty(cluster.lead), headlines)));
}

/**
 * A page the collector watches for changes, as "OpenAI: News archive page changed" does, is a prompt to look and not an announcement: it
 * has no date of its own and no text that could be quoted as news, and the page it points at is a listing. A dated item that was seen
 * again is not one.
 */
const isPageMonitor = (candidate: { dateKind?: string; publishedAt?: string | null }): boolean => candidate.dateKind === "changed" && !candidate.publishedAt;

/** A link label ("View details") and no summary leaves a model nothing to judge, so it would only be paid to say no. */
const isUnjudgeable = (candidate: { title: string; summary?: string | null }): boolean => isVagueTitle(candidate.title) && !candidate.summary?.trim();

/**
 * The clusters worth a model's attention now: fresh, not covered, not claimed or published or given up on, tier-1
 * first-party launches first and then by score, at most `limit`. `cursor` is what to store once these are claimed.
 */
export async function nextCandidates(service: SignalService, now: Date, options: { overlapMinutes?: number; maxAgeHours?: number; limit?: number; reportedUrls?: Set<string> } = {}): Promise<NextCandidates> {
  const reference = now.getTime();
  const floor = reference - (options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3_600_000;
  const stored = Date.parse((await service.getValue(CURSOR_KEY)) ?? "");
  const from = Number.isFinite(stored) ? Math.max(floor, stored - (options.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES) * 60_000) : floor;
  const snapshots = await snapshotKeys(from, reference);
  const invalid: string[] = [];
  const merged = await mergeSnapshots(snapshots.map(({ key }) => key), (key) => invalid.push(key));
  // The cursor never moves back, and moves past a snapshot that could not be read so that it is not retried forever.
  const cursor = new Date(Math.max(snapshots.at(-1)?.time ?? floor, Number.isFinite(stored) ? stored : floor)).toISOString();

  const clusters = clusterCandidates(merged.filter((candidate) => isFreshCandidate(candidate, reference, floor) && !isPageMonitor(candidate) && !isUnjudgeable(candidate))).map(ownItemLeads);
  const reported = options.reportedUrls ?? (await previousIssues(new Date(reference + 86_400_000).toISOString().slice(0, 10))).reportedUrls;
  const headlines = await service.recentHeadlines(new Date(reference - REPOST_WINDOW_HOURS * 3_600_000).toISOString());
  const open = dropCovered(clusters, headlines, reported);
  // What holds a cluster back is its story: see storyKeys and holdKeys. A neighbour that merely shares the title says nothing, since
  // anyone can title an item like an announcement to come, and a story that has already been said is covered by what was published
  // for any of its URLs. Without this a story could dodge a rejection or its attempt limit by changing which item leads.
  const taken = new Set(await service.unavailable(open.flatMap(holdKeys), now.toISOString()));
  const covered = new Set(await service.published(open.flatMap(storyKeys)));
  const available = open.filter((cluster) => keyOf(cluster.lead.url) !== null && !holdKeys(cluster).some((key) => taken.has(key)) && !storyKeys(cluster).some((key) => covered.has(key)));
  // A launch has no attention yet, so by score a discussion of last week's news would outrank it.
  const ordered = [...available.filter((cluster) => isTier1FirstParty(cluster.lead)), ...available.filter((cluster) => !isTier1FirstParty(cluster.lead))];
  const candidates = ordered.slice(0, options.limit ?? DEFAULT_LIMIT).flatMap((cluster) => {
    const urlKey = keyOf(cluster.lead.url);
    return urlKey ? [{ urlKey, cluster }] : [];
  });
  return { candidates, cursor, read: snapshots.length - invalid.length, invalid };
}
