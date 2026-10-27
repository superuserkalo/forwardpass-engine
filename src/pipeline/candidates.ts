import { z } from "zod";
import { attachAttention, githubRepository } from "../lib/attention.js";
import { loadIssue, publishedMarkerSchema } from "../lib/issue.js";
import { listPrivateJsonKeys, readPrivateJson } from "../lib/private-store.js";
import { attentionSchema, candidateSchema, type Attention, type Candidate } from "../lib/schemas.js";
import { entryKey } from "../lib/entry-key.js";
import { freshnessWindowStart, isFreshCandidate, terms, textSimilarity } from "./freshness.js";
import { mergeSameRelease } from "./story-merge.js";
import { publisherDomain } from "./publisher-domain.js";
import { isComputeCandidate } from "./compute.js";
import { languageOfCandidate } from "./language.js";
import { isTier1, isTier1FirstParty, NOISE, TIER1_SLOTS } from "./tier1.js";

// Stage 1 of the daily issue, with no model calls: everything collected since the previous
// issue, minus what earlier issues already reported, clustered into stories and pre-ranked
// on public signals so the model only reads the few hundred that could matter.

// The main lane writes one snapshot per run, named by the hour; the fast lane one per poll, named by the minute.
const RUN_SNAPSHOT = /^collection\/runs\/(\d{4}-\d{2}-\d{2})\/(\d{2})\.json$/;
const FAST_SNAPSHOT = /^collection\/fast\/(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})\.json$/;
// Snapshots written by the old collector also carry the full collector state; it is ignored here.
const snapshotSchema = z.object({
  collectedAt: z.string(),
  items: z.array(candidateSchema),
  attention: z.object({ measurements: z.array(attentionSchema), candidates: z.array(candidateSchema) }).passthrough(),
}).passthrough();

const canonical = (url: string): string | null => {
  try { return entryKey(url); } catch { return null; }
};

export type PreviousIssue = { date: string; publishedAt: number } | null;

export const WEIGHTS_KEY = "sources/benchmark-weights.json";
const weightsSchema = z.object({ version: z.literal(1), hits: z.record(z.string(), z.array(z.iso.date())) });
export type WeightLog = z.infer<typeof weightsSchema>;

export async function loadWeightLog(): Promise<WeightLog> {
  const saved = await readPrivateJson(WEIGHTS_KEY);
  return saved === null ? { version: 1, hits: {} } : weightsSchema.parse(saved);
}

/** Per-domain counts over the 30 days before `date`. */
export function publisherWeights(log: WeightLog, date: string): PublisherWeights {
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  return Object.fromEntries(Object.entries(log.hits).map(([domain, days]) => [domain, days.filter((d) => d >= from && d <= date).length]).filter(([, n]) => Number(n) > 0));
}

export async function previousIssues(date: string, days = 7): Promise<{ previous: PreviousIssue; reportedUrls: Set<string> }> {
  const dates = (await listPrivateJsonKeys("published/daily/"))
    .flatMap((key) => /(\d{4}-\d{2}-\d{2})\.json$/.exec(key)?.[1] ?? [])
    .filter((day) => day < date).sort();
  const last = dates.at(-1);
  const previous = last ? { date: last, publishedAt: Date.parse(publishedMarkerSchema.parse(await readPrivateJson(`published/daily/${last}.json`)).publishedAt) } : null;
  const reportedUrls = new Set<string>();
  for (const day of dates.slice(-days)) {
    const issue = await loadIssue(day);
    if (!issue) continue;
    const urls = issue.version === 2
      ? issue.stories.flatMap((story) => [story.url, ...story.sources.map(({ url }) => url)])
      : [...issue.markdown.matchAll(/https:\/\/[^\s)<>\]]+/g)].map(([url]) => url.replace(/[.,;:!?'"]+$/, ""));
    for (const url of urls) { const key = canonical(url); if (key) reportedUrls.add(key); }
  }
  return { previous, reportedUrls };
}

/** The headlines of the last published daily issues, newest first. */
export async function recentHeadlines(date: string, issues = 2): Promise<string[]> {
  const dates = (await listPrivateJsonKeys("published/daily/"))
    .flatMap((key) => /(\d{4}-\d{2}-\d{2})\.json$/.exec(key)?.[1] ?? [])
    .filter((day) => day < date).sort().slice(-issues).reverse();
  const headlines: string[] = [];
  for (const day of dates) {
    const issue = await loadIssue(day);
    if (issue?.version === 2) headlines.push(...issue.stories.map((story) => story.headline));
  }
  return headlines;
}

const DAY_MS = 86_400_000;

/**
 * The collection snapshots of both lanes whose time (the one in the name) lies in [from, to], oldest first. Only the
 * days in range are listed, so reading a few hours does not list the whole history.
 */
export async function snapshotKeys(from: number, to: number): Promise<{ key: string; time: number }[]> {
  const prefixes: string[] = [];
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day <= to; day += DAY_MS) {
    const date = new Date(day).toISOString().slice(0, 10);
    prefixes.push(`collection/runs/${date}/`, `collection/fast/${date}/`);
  }
  const found = (await Promise.all(prefixes.map((prefix) => listPrivateJsonKeys(prefix)))).flat().flatMap((key) => {
    const run = RUN_SNAPSHOT.exec(key), fast = FAST_SNAPSHOT.exec(key);
    const time = run ? Date.parse(`${run[1]}T${run[2]}:00:00Z`) : fast ? Date.parse(`${fast[1]}T${fast[2]}:${fast[3]}:00Z`) : NaN;
    return Number.isFinite(time) && time >= from && time <= to ? [{ key, time }] : [];
  });
  return found.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
}

/**
 * The candidates in some snapshots, one per entry, with attention attached. A snapshot that cannot be read throws,
 * unless `onInvalid` is given, in which case it is skipped and named.
 */
export async function mergeSnapshots(keys: string[], onInvalid?: (key: string) => void): Promise<Candidate[]> {
  const byUrl = new Map<string, Candidate>();
  const measurements = new Map<string, Attention>();
  for (const key of keys) {
    const parsed = snapshotSchema.safeParse(await readPrivateJson(key));
    if (!parsed.success) {
      if (!onInvalid) throw parsed.error;
      onInvalid(key);
      continue;
    }
    const snapshot = parsed.data;
    for (const metric of snapshot.attention.measurements) measurements.set(`${metric.platform}:${metric.id}`, metric);
    for (const item of [...snapshot.attention.candidates, ...snapshot.items]) {
      const url = canonical(item.url);
      if (!url) continue;
      const existing = byUrl.get(url);
      // A community submission adds attention but never replaces a publisher's own date, summary or attribution.
      if (item.source === "Hacker News" && existing && existing.source !== "Hacker News") continue;
      byUrl.set(url, item);
    }
  }
  return attachAttention([...byUrl.values()], [...measurements.values()]);
}

/** Everything new since the previous issue: news always lands in the very next issue. */
export async function freshCandidates(date: string, now: Date): Promise<{ candidates: Candidate[]; benchmark: Candidate[]; since: string; previousIssue: string | null; snapshots: number }> {
  const reference = now.getTime();
  const { previous, reportedUrls } = await previousIssues(date);
  const since = freshnessWindowStart(reference, previous?.publishedAt ?? null);
  const keys = (await snapshotKeys(since - 3_600_000, reference)).map(({ key }) => key);
  const fresh = (await mergeSnapshots(keys))
    .filter((candidate) => isFreshCandidate(candidate, reference, since) && !reportedUrls.has(canonical(candidate.url) ?? ""));
  // AlphaSignal is collected only as the recall benchmark, never as an input to the issue.
  const isBenchmark = (candidate: Candidate) => /(^|\.)alphasignal\.ai$/.test(new URL(candidate.url).hostname);
  return { candidates: fresh.filter((c) => !isBenchmark(c)), benchmark: fresh.filter(isBenchmark), since: new Date(since).toISOString(), previousIssue: previous?.date ?? null, snapshots: keys.length };
}

// ---- Clustering and pre-rank (ported from the prototype, commit 1536d27) ----

export type Item = Candidate & { host: string };
export type Cluster = { items: Item[]; score: number; lead: Item };

// A tier-1 publisher, or a GitHub or Hugging Face page, which have always counted as lab output.
const GITHUB_OR_HF = /(^|\.)(github\.com|huggingface\.co)$/;
const isLab = (item: Item) => isTier1(item.url) || GITHUB_OR_HF.test(item.host.replace(/^www\./, ""));

export const hnPoints = (item: Candidate) => Math.max(0, ...(item.attention ?? []).filter((m) => m.platform === "hacker-news").map((m) => m.score));
const hnComments = (item: Candidate) => Math.max(0, ...(item.attention ?? []).filter((m) => m.platform === "hacker-news").map((m) => m.secondaryCount));
const distinctWords = (title: string) => (title.toLowerCase().match(/[\p{L}\p{N}._-]{3,}/gu) ?? []).length;

/** Publisher domain → how many stories the benchmark featured from it in the last 30 days (learned by the recall loop). */
export type PublisherWeights = Record<string, number>;
const domainOf = (host: string) => publisherDomain(host.replace(/^www\./, ""));

function score(cluster: { items: Item[] }, weights: PublisherWeights = {}): Cluster {
  const items = cluster.items;
  const publishers = new Set(items.map((item) => item.source));
  const hn = Math.max(...items.map(hnPoints)), comments = Math.max(...items.map(hnComments));
  const lab = items.some(isLab);
  const noise = items.every((item) => NOISE.test(item.url));
  const paper = items.every((item) => /arxiv\.org/.test(item.url));
  const hf = items.some((item) => /huggingface\.co\//.test(item.url));
  // A publisher's own post, release note or write-up. arXiv, OpenReview and Hugging Face papers are research, not first-party news.
  const firstParty = items.some((item) => item.source !== "Hacker News" && !NOISE.test(item.url)
    && (["news", "primary announcement", "developer tooling", "releases", "changelog", "engineering"].includes(item.category) || (item.category === "research" && !/arxiv\.org|openreview\.net|huggingface\.co/.test(item.url))));
  const hnOnlyWeak = items.every((item) => item.source === "Hacker News") && hn < 15;
  // Trending momentum: GitHub stars today, HF model downloads, HF paper upvotes (each scaled to roughly HN-point size).
  const attention = items.flatMap((item) => item.attention ?? []);
  const momentum = Math.max(0, ...attention.filter((m) => m.platform === "github").map((m) => (m.scoreDelta ?? 0) / 5),
    ...attention.filter((m) => m.platform === "huggingface").map((m) => m.id.startsWith("paper:") ? m.score * 2 : m.secondaryCount / 1000));
  const value = (firstParty ? 2.5 : 0) - (hnOnlyWeak ? 4 : 0) + 2.2 * Math.log1p(hn) + 0.6 * Math.log1p(comments) + 1.5 * Math.log(publishers.size)
    + (lab ? 3 : 0) + (hf ? 1 : 0) - (noise ? 6 : 0) - (paper ? 1.5 : 0) + 1.2 * Math.log1p(momentum)
    // Learned from recall: publishers the benchmark keeps featuring get a bounded boost (at most ~3.6).
    + 1.5 * Math.log1p(Math.min(10, Math.max(0, ...items.map((item) => weights[domainOf(item.host)] ?? 0))));
  const lead = items.find(isLab) ?? items.find((item) => item.source !== "Hacker News") ?? items[0];
  // An HN submission of the lead's own URL usually has the clearer, human-written title.
  const title = items.find((item) => item.source === "Hacker News" && item.url === lead.url)?.title ?? lead.title;
  return { items, score: value, lead: { ...lead, title } };
}

/**
 * Groups candidates that point at the same repository or URL, then those with near-identical
 * titles (≥ 0.7 overlap, both with ≥ 5 words), then folds reposts of one release together.
 * Titles are compared through an inverted index, so 2,600 items take milliseconds, not seconds.
 */
export function clusterCandidates(candidates: Candidate[], weights: PublisherWeights = {}): Cluster[] {
  const groups: { items: Item[]; titleTerms: Set<string>; longTitle: boolean }[] = [];
  const byKey = new Map<string, number>();
  const byTerm = new Map<string, number[]>();
  for (const candidate of candidates) {
    let host: string;
    try { host = new URL(candidate.url).hostname; } catch { continue; }
    const key = githubRepository(candidate.url) ?? canonical(candidate.url) ?? candidate.url;
    let index = byKey.get(key);
    if (index === undefined && distinctWords(candidate.title) >= 5) {
      const own = terms(candidate.title);
      const nearby = [...new Set([...own].flatMap((term) => byTerm.get(term) ?? []))].sort((a, b) => a - b);
      index = nearby.find((i) => groups[i].longTitle && textSimilarity(candidate.title, groups[i].items[0].title) >= 0.7);
    }
    if (index === undefined) {
      index = groups.length;
      const titleTerms = terms(candidate.title);
      groups.push({ items: [], titleTerms, longTitle: distinctWords(candidate.title) >= 5 });
      for (const term of titleTerms) byTerm.set(term, [...(byTerm.get(term) ?? []), index]);
    }
    groups[index].items.push({ ...candidate, host });
    byKey.set(key, index);
  }
  const ranked = groups.map((group) => score(group, weights)).sort((a, b) => b.score - a.score);
  // Reposts of a release (availability, day-0 support, roundups) join the highest-ranked
  // cluster for that release, and the merged coverage raises the story's score.
  return mergeSameRelease(ranked).map((cluster) => score(cluster, weights)).sort((a, b) => b.score - a.score);
}

export const POOL = 450;
export const PAPER_SLOTS = 60;
/** How many compute-lane clusters may join the shortlist beyond the ranked ones, when the issue is built with the lane on. */
export const COMPUTE_SLOTS = 80;

/**
 * The top clusters, then every tier-1 publisher's own post that attention left outside them
 * (a new release has no Hacker News thread yet), then a slice of papers, which rarely carry
 * attention in this collector, then, with the Compute lane on, the best of its news (chip news
 * has no attention to rank by).
 */
export function shortlistClusters(allClusters: Cluster[], pool = POOL, paperSlots = PAPER_SLOTS, tier1Slots = TIER1_SLOTS, computeSlots = 0): Cluster[] {
  // The Chinese, Korean and Japanese outlets are read for the supply chain. What they print about anything else is other outlets' news a day late and in
  // another language, which the issue would report again, so a story in those languages is shortlisted only as compute news and only with the lane on.
  const clusters = allClusters.filter((cluster) => !languageOfCandidate(cluster.lead) || (computeSlots > 0 && isComputeCandidate(cluster.lead)));
  const top = clusters.slice(0, pool);
  const chosen = new Set(top);
  const firstParty = clusters.filter((cluster) => !chosen.has(cluster) && cluster.items.some(isTier1FirstParty)).slice(0, tier1Slots);
  for (const cluster of firstParty) chosen.add(cluster);
  const papers = clusters.filter((cluster) => !chosen.has(cluster) && cluster.items.some((item) => /arxiv|huggingface\.co\/papers/.test(item.url))).slice(0, paperSlots);
  for (const cluster of papers) chosen.add(cluster);
  const compute = computeSlots > 0 ? clusters.filter((cluster) => !chosen.has(cluster) && isComputeCandidate(cluster.lead)).slice(0, computeSlots) : [];
  return [...top, ...firstParty, ...papers, ...compute];
}

// ---- Story presentation helpers used by later stages ----

const metrics = (cluster: Cluster, platform: Attention["platform"]) => cluster.items.flatMap((item) => (item.attention ?? []).filter((m) => m.platform === platform));
const formatCount = (n: number) => Math.round(n).toLocaleString("en-US");

/** The strongest public number for a story, printed by code and never by a model. */
export function traction(cluster: Cluster): string | null {
  const hfModel = metrics(cluster, "huggingface").filter((m) => !m.id.startsWith("paper:")).sort((a, b) => b.secondaryCount - a.secondaryCount)[0];
  if (hfModel?.secondaryCount) return `${formatCount(hfModel.secondaryCount)} Downloads`;
  const github = metrics(cluster, "github").sort((a, b) => b.score - a.score)[0];
  if (github?.scoreDelta) return `${formatCount(github.scoreDelta)} Stars today`;
  if (github?.score) return `${formatCount(github.score)} Stars`;
  if (hfModel?.score) return `${formatCount(hfModel.score)} Likes`;
  const paper = metrics(cluster, "huggingface").find((m) => m.id.startsWith("paper:"));
  if (paper?.score) return `${formatCount(paper.score)} Upvotes`;
  const hn = Math.max(...cluster.items.map(hnPoints));
  // Small HN counts read as weakness rather than traction.
  return hn >= 20 ? `${formatCount(hn)} HN points` : null;
}

const HF_MODEL = /^https:\/\/huggingface\.co\/(?!papers\/|blog\/|docs\/|spaces\/|datasets\/|learn\/|posts\/)([\w.-]+\/[\w.-]+)\/?$/;

export function storyType(url: string): "news" | "papers" | "models" | "repos" {
  if (/arxiv\.org|huggingface\.co\/papers\//.test(url)) return "papers";
  if (HF_MODEL.test(url)) return "models";
  if (githubRepository(url) && /^https:\/\/github\.com\//.test(url)) return "repos";
  return "news";
}

/** Section label from the story's primary artifact, as AlphaSignal labels Top News / Repo / Paper / Model. */
export function sectionLabel(url: string): string {
  return { news: "Top News", papers: "Top Paper", models: "Top Model", repos: "Top Repo" }[storyType(url)];
}

export function projectOf(cluster: Cluster): string {
  return githubRepository(cluster.lead.url) ?? HF_MODEL.exec(cluster.lead.url)?.[1] ?? cluster.lead.source;
}
