import type { Cluster } from "./candidates.js";

// Pure helpers behind the daily recall report: which of a benchmark newsroom's stories did we
// collect, shortlist, keep, show the editor and pick? The first version matched by cluster lead
// URL, re-clustered without the issue's learned weights, and dropped every GitHub, Hugging Face,
// arXiv and X link as "generic", which hid most of what it was meant to measure.

// In order, each further than the last. A story we published as a live signal reached the reader, which being shown to
// the editor did not, but the daily issue is what the reader is promised, so a pick is further still.
export type RecallStage = "missing" | "collected" | "shortlisted" | "kept" | "editor" | "published" | "picked";
const STAGES: RecallStage[] = ["missing", "collected", "shortlisted", "kept", "editor", "published", "picked"];
export const emptyCounts = (): Record<RecallStage, number> => ({ missing: 0, collected: 0, shortlisted: 0, kept: 0, editor: 0, published: 0, picked: 0 });

const hostOf = (url: string): string | null => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
};

/** Host and path without www, query, fragment or trailing slash: how two links to one page compare. */
export function looseUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, "")}${pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch { return ""; }
}

const X_POST = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/i;
// Furniture of the benchmark's pages (image CDN, signup form, chat apps, analytics, social profiles)
// and the generic hosts source discovery has always ignored. A generic host must never count as a
// source: its links feed the learned publisher weights and discovery leads.
const FURNITURE = /(^|\.)(imagedelivery\.net|cloudflarestream\.com|cloudflare\.com|typeform\.com|chatgpt\.com|claude\.ai|googleapis\.com|gstatic\.com|google-analytics\.com|googletagmanager\.com|schema\.org|w3\.org|linkedin\.com|instagram\.com|facebook\.com|youtube\.com|youtu\.be|substack\.com|beehiiv\.com|short\.io|termly\.io|posthog\.com|stripe\.com|reddit\.com|wikipedia\.org|medium\.com|news\.ycombinator\.com|t\.co|bit\.ly|notion\.site|discord\.gg|discord\.com|githubusercontent\.com)$/i;
// Big domains that are generic on their own pages but host real publishers on subdomains (cloud.google.com, machinelearning.apple.com).
const GENERIC_PAGES = /^(google\.com|docs\.google\.com|drive\.google\.com|forms\.gle|apple\.com)$/i;
// Artifact hosts carry real sources, so being linked often is not a sign of page furniture.
const ARTIFACT_HOST = /(^|\.)(github\.com|huggingface\.co|arxiv\.org)$/i;

export type ArticleLinks = { sources: string[]; xPosts: string[] };

/** The outbound links of one benchmark article: publisher, repository, model and paper links, and X posts kept apart. */
export function articleLinks(html: string, pageUrl: string): ArticleLinks {
  const own = hostOf(pageUrl);
  const sources = new Set<string>();
  const xPosts = new Set<string>();
  for (const [, raw] of html.matchAll(/href=["'](https:\/\/[^"'\s]+)["']/gi)) {
    const href = raw.replace(/&amp;/g, "&");
    const post = X_POST.exec(href)?.[0];
    if (post) { xPosts.add(post); continue; }
    let url: URL;
    try { url = new URL(href); } catch { continue; }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === own || /(^|\.)(x|twitter)\.com$/.test(host) || FURNITURE.test(host) || GENERIC_PAGES.test(host)) continue;
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    url.hash = "";
    sources.add(url.toString());
  }
  return { sources: [...sources], xPosts: [...xPosts] };
}

/** Removes hosts linked from most articles (shared furniture); needs a handful of articles to judge. */
export function dropChromeHosts(articles: Map<string, ArticleLinks>): Map<string, ArticleLinks> {
  const articlesPerHost = new Map<string, number>();
  for (const { sources } of articles.values()) for (const host of new Set(sources.map(hostOf))) if (host) articlesPerHost.set(host, (articlesPerHost.get(host) ?? 0) + 1);
  const chrome = (host: string | null) => !host || (articles.size >= 5 && !ARTIFACT_HOST.test(host) && (articlesPerHost.get(host) ?? 0) > articles.size * 0.3);
  return new Map([...articles].map(([url, links]) => [url, { ...links, sources: links.sources.filter((source) => !chrome(hostOf(source))) }]));
}

/** Index of the first (best-ranked) cluster containing any of the source URLs, or -1. */
export function matchByUrl(sources: string[], clusters: Cluster[]): number {
  const wanted = new Set(sources.map(looseUrl).filter(Boolean));
  return wanted.size ? clusters.findIndex((cluster) => cluster.items.some((item) => wanted.has(looseUrl(item.url)))) : -1;
}

export type StagePools = { collected: Set<string>; shortlisted: Set<string>; kept: Set<string>; editor: Set<string>; published: Set<string>; picked: Set<string> };

/**
 * What counts as published, as loose URLs: each signal's own address, which may be a page nothing else collected, and every
 * item of any cluster that holds one, since a story that links another member of the cluster was published all the same.
 */
export function publishedPool(signalUrls: string[], clusters: Cluster[]): Set<string> {
  const own = new Set(signalUrls.map(looseUrl).filter(Boolean));
  const pool = new Set(own);
  for (const cluster of clusters) {
    if (cluster.items.some((item) => own.has(looseUrl(item.url)))) for (const item of cluster.items) pool.add(looseUrl(item.url));
  }
  return pool;
}

/** The furthest stage any of the story's URLs reached. Pools hold loose URLs of every item in the stage's clusters. */
export function stageOf(urls: string[], pools: StagePools): RecallStage {
  const keys = urls.map(looseUrl).filter(Boolean);
  for (let i = STAGES.length - 1; i > 0; i--) {
    const pool = pools[STAGES[i] as keyof StagePools];
    if (keys.some((key) => pool.has(key))) return STAGES[i];
  }
  return "missing";
}
