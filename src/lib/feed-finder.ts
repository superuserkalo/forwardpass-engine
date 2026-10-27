import { XMLParser } from "fast-xml-parser";
import { extractFeedLinks } from "./feed-upgrade.js";
import { fetchSameSite } from "./safe-fetch.js";
import { bareHost, sameSite } from "./site-identity.js";
import { harvestUrls } from "./url-harvest.js";

export type FoundFeed = { url: string; kind: "rss" | "atom"; items: number; recentItems: number; latestAt: string; sampleTitles: string[] };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });
const COMMON_PATHS = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/blog/rss.xml", "/blog/feed", "/blog/rss",
  "/blog/atom.xml", "/blog/feed.xml", "/news/rss.xml", "/news/feed", "/changelog/rss.xml", "/changelog/feed.xml", "/changelog.rss", "/research/rss.xml"];
const PAGES = ["", "/blog", "/news", "/changelog"];
const MAX_BODY = 5_000_000;

// Pages are named by aggregator links, so they are read like any untrusted link: public HTTPS, redirects
// kept on the same site, size capped (see safe-fetch.ts). Without a custom fetcher, the evidence loader.
async function get(url: string, fetcher: Fetcher | undefined): Promise<{ url: string; text: string } | null> {
  const page = await fetchSameSite(url, { fetcher, contentType: /xml|html|text|json/i, timeoutMs: 10_000, maxBytes: MAX_BODY, headers: { "User-Agent": "ForwardPassFeedFinder/1.0" } });
  return page && { url: page.url, text: page.body };
}

// Parses an RSS/Atom document into dated entries. Returns null for anything else.
export function parseFeed(text: string): { kind: "rss" | "atom"; entries: { title: string; date: number }[] } | null {
  const head = text.slice(0, 3000);
  const kind = /<feed[\s>]/i.test(head) ? "atom" : /<(rss|rdf:RDF)[\s>]/i.test(head) ? "rss" : null;
  if (!kind) return null;
  try {
    const doc = parser.parse(text);
    const raw = doc.rss?.channel?.item ?? doc.feed?.entry ?? doc["rdf:RDF"]?.item ?? [];
    const list: Record<string, unknown>[] = Array.isArray(raw) ? raw : [raw];
    const str = (value: unknown) => String(typeof value === "object" && value !== null ? (value as Record<string, unknown>)["#text"] ?? "" : value ?? "");
    return { kind, entries: list.map((entry) => ({ title: str(entry.title).trim(),
      date: Date.parse(str(entry.pubDate ?? entry.published ?? entry.updated ?? entry["dc:date"])) })) };
  } catch { return null; }
}

// Finds publication feeds for a domain without model calls: autodiscovery links on
// the home/blog/news/changelog pages, then conventional feed paths. Only feeds with
// dated entries inside the recency window are returned.
export async function findFeeds(domain: string, options: { fetcher?: Fetcher; now?: Date; recentDays?: number } = {}): Promise<FoundFeed[]> {
  const fetcher = options.fetcher;
  const since = (options.now ?? new Date()).getTime() - (options.recentDays ?? 90) * 86_400_000;
  const base = bareHost(domain.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (!base) return [];
  const candidates = new Set(COMMON_PATHS.map((path) => base.origin + path));
  for (const page of await Promise.all(PAGES.map((path) => get(base.origin + path, fetcher)))) {
    if (!page) continue;
    // Only the publisher's own feed: a page can advertise one on another site or tenant (a shared host, an aggregator).
    // Links are read from the parsed page, so markup inside a comment or a script advertises nothing.
    for (const link of extractFeedLinks(page.text, page.url)) if (sameSite(new URL(link), base)) candidates.add(link);
  }
  const found = new Map<string, FoundFeed>();
  await Promise.all([...candidates].map(async (url) => {
    const page = await get(url, fetcher);
    // A redirect is part of the answer, so the address a feed ends at must be the publisher's own too.
    const feed = page && sameSite(new URL(page.url), base) ? parseFeed(page.text) : null;
    if (!page || !feed) return;
    const recent = feed.entries.filter(({ date }) => Number.isFinite(date) && date >= since);
    if (!recent.length) return;
    found.set(page.url, { url: page.url, kind: feed.kind, items: feed.entries.length, recentItems: recent.length,
      latestAt: new Date(Math.max(...recent.map(({ date }) => date))).toISOString(), sampleTitles: recent.slice(0, 5).map(({ title }) => title) });
  }));
  // Several paths often serve one feed; keep the one with most recent entries per latest date.
  const byContent = new Map<string, FoundFeed>();
  for (const feed of found.values()) {
    const key = `${feed.latestAt}:${feed.sampleTitles[0]}`;
    const prior = byContent.get(key);
    if (!prior || feed.url.length < prior.url.length) byContent.set(key, feed);
  }
  return [...byContent.values()].sort((a, b) => b.recentItems - a.recentItems);
}



export type FoundIndex = { url: string; articles: number; sampleSlugs: string[] };
const INDEX_PATHS = ["/blog", "/news", "/research", "/changelog", "/updates", "/press", "/articles", "/posts", "/stories", "/engineering"];
const INDEX_WORD = /^(?:blog|news|research|changelog|updates|press|articles|posts|stories|engineering|insights|resources)$/i;
const MIN_ARTICLES = 3;

/**
 * Index pages of a publisher that has no feed: the usual blog and news paths, and the ones its home
 * page links, that list several articles of their own. The collector reads such a page like any
 * other index (cards, or the article links it embeds) and each new article from its own page.
 */
export async function findIndexPages(domain: string, options: { fetcher?: Fetcher } = {}): Promise<FoundIndex[]> {
  const base = bareHost(domain.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (!base) return [];
  const candidates = new Set(INDEX_PATHS.map((path) => `${base.origin}${path}`));
  const home = await get(`${base.origin}/`, options.fetcher);
  if (home) {
    for (const [, href] of home.text.matchAll(/href=["']([^"'#]+)["']/gi)) {
      try {
        const url = new URL(href, home.url);
        const segments = url.pathname.split("/").filter(Boolean);
        if (url.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "") && segments.length === 1 && INDEX_WORD.test(segments[0])) candidates.add(`${url.origin}/${segments[0]}`);
      } catch { /* malformed link */ }
    }
  }
  const found: FoundIndex[] = [];
  const reached = new Set<string>();
  for (const candidate of [...candidates].slice(0, 12)) {
    const page = await get(candidate, options.fetcher);
    // Two routes (a path and a link on the home page) can end at the same page.
    if (!page || reached.has(page.url)) continue;
    reached.add(page.url);
    const articles = harvestUrls(page.text, page.url, 30);
    if (articles.length >= MIN_ARTICLES) found.push({ url: page.url, articles: articles.length, sampleSlugs: articles.slice(0, 5).map((article) => new URL(article).pathname.split("/").filter(Boolean).at(-1) ?? "") });
  }
  return found.sort((a, b) => b.articles - a.articles).slice(0, 2);
}
