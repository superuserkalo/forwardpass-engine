import { createHash } from "node:crypto";
import { z } from "zod";
import { findFeeds, findIndexPages, type FoundFeed, type FoundIndex } from "./feed-finder.js";
import { publisherDomain } from "../pipeline/publisher-domain.js";
export { publisherDomain } from "../pipeline/publisher-domain.js";
import { listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "./private-store.js";
import { SOURCE_STREAMS, type SourceStream } from "./source-streams.js";
import { candidateSchema, type Candidate } from "./schemas.js";

// Aggregators say which publishers matter; the feed finder turns them into streams.
// No model calls: counts, HTTP and dated feed entries only.
const REGISTRY_KEY = "sources/discovered.json";
// Deliberately narrow: "agents", "model" or "training" alone also match general news.
const AI = /\b(ai|a\.i\.|llms?|gpt[\w.-]*|genai|inference|embeddings?|transformers?|neural|machine learning|ml|rag|gpus?|diffusion|mcp|copilot|(?:ai|coding|llm) agents?|(?:language|foundation|open[- ]weights?) models?|fine-?tun\w*)\b/i;
// Hosts that are aggregators, social networks or artifact hosts: covered by other streams or not publishers.
export const GENERIC = /(^|\.)(github\.com|githubusercontent\.com|huggingface\.co|arxiv\.org|x\.com|twitter\.com|youtube\.com|youtu\.be|linkedin\.com|reddit\.com|wikipedia\.org|medium\.com|substack\.com|news\.ycombinator\.com|alphasignal\.ai|google\.com|apple\.com|t\.co|bit\.ly|docs\.google\.com|notion\.site|discord\.(gg|com))$/i;
const MIN_HN_POINTS = 30;
const DAILY_LIMIT = 20;

const feedSchema = z.object({ url: z.string(), kind: z.enum(["rss", "atom"]), items: z.number(), recentItems: z.number(), latestAt: z.string(), sampleTitles: z.array(z.string()) });
const entrySchema = z.object({
  domain: z.string(), status: z.enum(["probation", "active", "no-feed", "off-topic", "stale"]),
  feeds: z.array(feedSchema), firstSeenAt: z.string(), checkedAt: z.string(),
  // Index pages for a publisher with no feed: its blog or news page, read like any other index.
  indexes: z.array(z.string()).default([]),
  mentions: z.number(), evidence: z.array(z.string()),
  // Linked by a curated AI aggregator (vs. only seen on general-interest HN).
  curated: z.boolean().default(false),
  // Active GitHub repositories of the publisher's organization; their releases are collected too.
  repos: z.array(z.string()).default([]),
});
const registrySchema = z.object({ version: z.literal(1), sources: z.record(z.string(), entrySchema) });
export type DiscoveredSource = z.infer<typeof entrySchema>;
export type DiscoveryRegistry = z.infer<typeof registrySchema>;

export const hostOf = (value: string): string | null => {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
};

export function knownHosts(streams: readonly SourceStream[] = SOURCE_STREAMS): Set<string> {
  return new Set(streams.flatMap((stream) => [stream.host, hostOf(stream.url), ...(stream.catalogUrls ?? []).map(hostOf)]).filter((host): host is string => !!host).map((host) => host.replace(/^www\./, "")));
}

const covered = (host: string, known: Set<string>) => [...known].some((k) => host === k || host.endsWith(`.${k}`) || k.endsWith(`.${host}`));

// Weighted mentions of uncovered publishers. Aggregator links count double: an editor already chose them.
export function missedPublishers(candidates: readonly Candidate[], aggregatorLinks: readonly { url: string; title: string }[], known: Set<string>): Map<string, { mentions: number; evidence: string[]; curated: boolean }> {
  const misses = new Map<string, { mentions: number; evidence: string[]; curated: boolean }>();
  const add = (url: string, title: string, weight: number, curated = false) => {
    const raw = hostOf(url);
    const host = raw && publisherDomain(raw);
    if (!host || GENERIC.test(host) || covered(host, known)) return;
    const row = misses.get(host) ?? { mentions: 0, evidence: [], curated: false };
    row.mentions += weight;
    row.curated ||= curated;
    if (row.evidence.length < 5) row.evidence.push(title.slice(0, 140));
    misses.set(host, row);
  };
  for (const candidate of candidates) {
    const points = Math.max(0, ...(candidate.attention ?? []).filter((m) => m.platform === "hacker-news").map((m) => m.score));
    if (candidate.source === "Hacker News" && points >= MIN_HN_POINTS && AI.test(candidate.title)) add(candidate.url, candidate.title, 1);
  }
  // A host linked from most aggregator articles is page chrome (analytics, forms, CDNs), not a source.
  const articlesPerHost = new Map<string, Set<string>>();
  for (const link of aggregatorLinks) {
    const host = hostOf(link.url);
    if (host) articlesPerHost.set(host, (articlesPerHost.get(host) ?? new Set()).add(link.title));
  }
  const articles = new Set(aggregatorLinks.map(({ title }) => title)).size;
  const seen = new Set<string>();
  for (const link of aggregatorLinks) {
    const host = hostOf(link.url);
    const key = `${link.title}\n${host && publisherDomain(host)}`;
    if (!host || seen.has(key) || (articles >= 5 && articlesPerHost.get(host)!.size > articles * 0.3)) continue;
    seen.add(key);
    add(link.url, link.title, 2, true);
  }
  return misses;
}

// Outbound source links from an aggregator article (e.g. an AlphaSignal news page).
export function outboundLinks(html: string, pageUrl: string): string[] {
  const own = hostOf(pageUrl);
  const links = new Set<string>();
  for (const [, href] of html.matchAll(/href=["'](https:\/\/[^"'#\s]+)["']/gi)) {
    const host = hostOf(href);
    if (host && host !== own && !GENERIC.test(host)) links.add(href.replace(/&amp;/g, "&").split("?")[0]);
  }
  return [...links];
}

export async function loadRegistry(): Promise<DiscoveryRegistry> {
  const saved = await readPrivateJson(REGISTRY_KEY);
  return saved === null ? { version: 1, sources: {} } : registrySchema.parse(saved);
}

export function discoveredStreams(registry: DiscoveryRegistry): SourceStream[] {
  return Object.values(registry.sources).filter(({ status }) => status === "probation" || status === "active").flatMap((entry) =>
    entry.feeds.slice(0, 2).map((feed): SourceStream => ({
      id: `discovered-${createHash("sha256").update(feed.url).digest("hex").slice(0, 16)}`,
      publisher: entry.domain, publisherId: entry.domain, host: entry.domain, section: "discovered feed",
      category: entry.status === "active" ? "discovered publisher" : "discovered publisher (probation)",
      kind: feed.kind, url: feed.url, access: "public", intervalHours: 2,
      notes: `Auto-discovered from ${entry.mentions} aggregator mentions, e.g. ${entry.evidence[0] ?? "n/a"}`,
    })).concat((entry.indexes ?? []).slice(0, 2).map((url): SourceStream => ({
      id: `discovered-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
      publisher: entry.domain, publisherId: entry.domain, host: entry.domain, section: "discovered index",
      category: entry.status === "active" ? "discovered publisher" : "discovered publisher (probation)",
      kind: "html-news", url, access: "public", intervalHours: 2,
      notes: `Index page of ${entry.domain}, which has no feed; auto-discovered from ${entry.mentions} aggregator mentions, e.g. ${entry.evidence[0] ?? "n/a"}`,
    }))).concat((entry.repos ?? []).map((repo): SourceStream => ({
      id: `discovered-${createHash("sha256").update(repo).digest("hex").slice(0, 16)}`,
      publisher: entry.domain, publisherId: entry.domain, host: "github.com", section: `${repo} releases`,
      category: "software release", kind: "github-releases", url: `https://api.github.com/repos/${repo}/releases?per_page=100`, access: "public", intervalHours: 2,
      notes: `Repository of discovered publisher ${entry.domain}`,
    }))));
}

type Deps = { find?: typeof findFeeds; fetcher?: typeof fetch; now?: Date; known?: Set<string>; repos?: typeof findGithubRepos; indexes?: typeof findIndexPages };

const repoSchema = z.object({ full_name: z.string(), stargazers_count: z.number(), fork: z.boolean(), archived: z.boolean(), pushed_at: z.string() });
const NOT_ORGS = new Set(["features", "about", "pricing", "login", "signup", "sponsors", "topics", "orgs", "marketplace", "enterprise", "security", "site", "contact", "github"]);

/**
 * Startups often launch on GitHub before (or instead of) their blog. The publisher's homepage
 * names its GitHub organization; its three most-starred repositories pushed in the last 90 days
 * are kept so their releases are collected.
 */
export async function findGithubRepos(domain: string, options: { fetcher?: typeof fetch; now?: Date } = {}): Promise<string[]> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();
  let html: string;
  try {
    const response = await fetcher(`https://${domain}/`, { headers: { "User-Agent": "Mozilla/5.0 ForwardPassSourceDiscovery/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); return []; }
    html = (await response.text()).slice(0, 2_000_000);
  } catch { return []; }
  const orgs = new Map<string, number>();
  for (const [, org] of html.matchAll(/https:\/\/github\.com\/([A-Za-z0-9-]{1,39})(?=[/"'?#\s])/g)) {
    if (!NOT_ORGS.has(org.toLowerCase())) orgs.set(org, (orgs.get(org) ?? 0) + 1);
  }
  const org = [...orgs].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!org) return [];
  const headers: Record<string, string> = { "User-Agent": "ForwardPassSourceDiscovery/1.0", Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  for (const kind of ["orgs", "users"]) {
    try {
      const response = await fetcher(`https://api.github.com/${kind}/${org}/repos?per_page=100&sort=pushed`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { await response.body?.cancel(); continue; }
      const cutoff = now.getTime() - 90 * 86_400_000;
      return z.array(repoSchema).parse(await response.json())
        .filter((repo) => !repo.fork && !repo.archived && Date.parse(repo.pushed_at) >= cutoff)
        .sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 3).map((repo) => repo.full_name.toLowerCase());
    } catch { /* try the next account kind */ }
  }
  return [];
}

// A curated AI aggregator already vetted the publisher. HN-only finds must show AI is a
// recurring subject (not one headline on a general news site) or keep being mentioned.
export function classifyFeeds(feeds: FoundFeed[], mentions: number, curated = false): DiscoveredSource["status"] {
  if (!feeds.length) return "no-feed";
  if (curated) return "probation";
  const relevant = feeds.some(({ sampleTitles }) => {
    const hits = sampleTitles.filter((title) => AI.test(title)).length;
    return hits >= Math.min(2, sampleTitles.length) && hits / sampleTitles.length >= 0.4;
  });
  return relevant || mentions >= 4 ? "probation" : "off-topic";
}

// A feed decides first, then an index page; failing both, a vetted publisher's active repositories still earn probation.
function statusOf(feeds: FoundFeed[], indexes: FoundIndex[], repos: string[], mentions: number, curated: boolean): DiscoveredSource["status"] {
  if (feeds.length) return classifyFeeds(feeds, mentions, curated);
  if (indexes.length) return classifyIndexes(indexes, mentions, curated);
  return repos.length && curated ? "probation" : classifyFeeds([], mentions, curated);
}

/** Index pages carry slugs, not feed titles; an aggregator's vote or AI subjects in the slugs put a publisher on probation. */
export function classifyIndexes(indexes: FoundIndex[], mentions: number, curated = false): DiscoveredSource["status"] {
  if (!indexes.length) return "no-feed";
  if (curated) return "probation";
  const slugs = indexes.flatMap(({ sampleSlugs }) => sampleSlugs);
  // Both forms: "fine-tuning-llama" matches the pattern as written, "serving-llms-on-gpus" once spaced.
  const hits = slugs.filter((slug) => AI.test(slug) || AI.test(slug.replace(/[-_]+/g, " "))).length;
  return (hits >= Math.min(2, slugs.length) && hits / slugs.length >= 0.4) || mentions >= 4 ? "probation" : "off-topic";
}

export async function reviewSources(registry: DiscoveryRegistry, deps: Deps = {}): Promise<DiscoveryRegistry> {
  const now = deps.now ?? new Date();
  const find = deps.find ?? findFeeds;
  const next = structuredClone(registry);
  for (const entry of Object.values(next.sources)) {
    const age = now.getTime() - Date.parse(entry.checkedAt);
    const due = entry.status === "no-feed" || entry.status === "off-topic" || entry.status === "stale" ? age >= 30 * 86_400_000 : age >= 7 * 86_400_000;
    if (!due) continue;
    const feeds = await find(entry.domain, { fetcher: deps.fetcher, now });
    entry.repos = await (deps.repos ?? findGithubRepos)(entry.domain, { fetcher: deps.fetcher, now });
    const indexes = feeds.length ? [] : await (deps.indexes ?? findIndexPages)(entry.domain, { fetcher: deps.fetcher });
    const status = statusOf(feeds, indexes, entry.repos, entry.mentions, entry.curated);
    entry.feeds = feeds.slice(0, 2);
    entry.indexes = indexes.map(({ url }) => url);
    entry.checkedAt = now.toISOString();
    // Two weeks of recent, relevant output on probation earns active status; silence makes it stale.
    entry.status = status === "no-feed" && (entry.status === "probation" || entry.status === "active") ? "stale"
      : status === "probation" && now.getTime() - Date.parse(entry.firstSeenAt) >= 14 * 86_400_000 ? "active" : status;
  }
  return next;
}

export async function discoverSources(candidates: readonly Candidate[], aggregatorLinks: readonly { url: string; title: string }[], deps: Deps = {}) {
  const now = deps.now ?? new Date();
  const find = deps.find ?? findFeeds;
  const registry = await reviewSources(await loadRegistry(), deps);
  const known = deps.known ?? knownHosts();
  Object.keys(registry.sources).forEach((host) => known.add(host));
  const misses = [...missedPublishers(candidates, aggregatorLinks, known)].sort((a, b) => b[1].mentions - a[1].mentions).slice(0, DAILY_LIMIT);
  for (const [domain, { mentions, evidence, curated }] of misses) {
    const feeds = await find(domain, { fetcher: deps.fetcher, now });
    const repos = await (deps.repos ?? findGithubRepos)(domain, { fetcher: deps.fetcher, now });
    const indexes = feeds.length ? [] : await (deps.indexes ?? findIndexPages)(domain, { fetcher: deps.fetcher });
    const status = statusOf(feeds, indexes, repos, mentions, curated);
    registry.sources[domain] = { domain, status, feeds: feeds.slice(0, 2), indexes: indexes.map(({ url }) => url), repos,
      firstSeenAt: now.toISOString(), checkedAt: now.toISOString(), mentions, evidence, curated };
  }
  await writePrivateJson(REGISTRY_KEY, registry);
  const counts = Object.values(registry.sources).reduce<Record<string, number>>((all, { status }) => ({ ...all, [status]: (all[status] ?? 0) + 1 }), {});
  console.info("forwardpass.source_discovery", JSON.stringify({ at: now.toISOString(), examined: misses.length, counts }));
  return { registry, examined: misses.map(([domain]) => domain), counts };
}

// Scheduled entry point: last 7 days of collected candidates plus AlphaSignal article links.
export async function runSourceDiscovery(now = new Date(), fetcher: typeof fetch = fetch) {
  const since = now.getTime() - 7 * 86_400_000;
  const candidates: Candidate[] = [];
  for (const key of (await listPrivateJsonKeys("collection/runs/")).sort()) {
    const match = /collection\/runs\/(\d{4}-\d{2}-\d{2})\//.exec(key);
    if (!match || Date.parse(`${match[1]}T23:59:59Z`) < since) continue;
    const snapshot = z.object({ items: z.array(candidateSchema), attention: z.object({ candidates: z.array(candidateSchema) }).passthrough() }).passthrough().parse(await readPrivateJson(key));
    candidates.push(...snapshot.items, ...snapshot.attention.candidates);
  }
  const aggregatorLinks: { url: string; title: string }[] = [];
  const articles = [...new Map(candidates.filter((c) => hostOf(c.url) === "alphasignal.ai").map((c) => [c.url, c])).values()].slice(0, 60);
  for (const article of articles) {
    try {
      const response = await fetcher(article.url, { headers: { "User-Agent": "ForwardPassSourceDiscovery/1.0" }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) aggregatorLinks.push(...outboundLinks(await response.text(), article.url).map((url) => ({ url, title: article.title })));
      else await response.body?.cancel();
    } catch { /* one unreachable article does not stop discovery */ }
  }
  return discoverSources(candidates, aggregatorLinks, { now, fetcher });
}
