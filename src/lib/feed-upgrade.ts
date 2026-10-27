import { load } from "cheerio/slim";
import { bareHost, sameSite } from "./site-identity.js";

export { sameSite };

// Many index pages advertise an RSS or Atom feed in their <head>. A feed gives every item a
// date and an identity, which card extraction from HTML often cannot, so a route whose page
// advertises a working feed should read the feed instead.

export type FeedProbe = { url: string; kind: "rss" | "atom"; entries: number; recent: number; latestAt: string | null; sampleTitles: string[] };

/** Absolute https URLs of the feeds a page advertises, without comment feeds, each once. */
export function extractFeedLinks(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const found = new Set<string>();
  $("link[href]").each((_, element) => {
    const link = $(element);
    const type = (link.attr("type") ?? "").toLowerCase();
    if (!/^application\/(rss|atom)\+xml/.test(type) || !/alternate/i.test(link.attr("rel") ?? "alternate")) return;
    let url: URL;
    try { url = new URL(link.attr("href") ?? "", pageUrl); } catch { return; }
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || /comment/i.test(url.pathname)) return;
    url.hash = "";
    found.add(url.toString());
  });
  return [...found];
}

const lastSegment = (url: string) => { try { return new URL(url).pathname.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? ""; } catch { return ""; } };

/**
 * The best live feed for a page: one whose address names the page's section ("/research" prefers
 * /research/rss.xml over the site-wide feed), then the one with more recent entries. A feed with
 * nothing recent is never chosen.
 */
export function chooseFeed(pageUrl: string, probes: FeedProbe[]): FeedProbe | null {
  const section = lastSegment(pageUrl);
  const names = (probe: FeedProbe) => section.length >= 3 && new URL(probe.url).pathname.toLowerCase().includes(section) ? 1 : 0;
  return probes.filter((probe) => probe.recent > 0)
    .sort((a, b) => names(b) - names(a) || b.recent - a.recent || a.url.length - b.url.length)[0] ?? null;
}

const CHANGELOG = /changelog|release|updates|what-?s-?new|notes/i;
// Pages that are themselves a stream of posts. A site-level feed may replace one of these; it must not replace
// a listing, a leaderboard or a portfolio that merely lives on the same site.
const CONTENT_SECTION = /(?:^|\/)(?:blogs?|news|newsroom|research|press|updates|changelog|releases?|insights|articles|posts|stories|signals|publications|learn|resources|engineering|announcements?|chronicle|whats-new|release[-_]notes?)(?:\/|$|[-_.])/i;

/**
 * The address a page should read instead of itself, or null to leave the page alone.
 * - The feed must be the publisher's own (same site, same tenant on a shared platform; see sameSite).
 * - GitHub pages stay: unauthenticated atom feeds from shared egress addresses are rate limited.
 * - A site-level feed only replaces a page that is itself a content section (blog, news, research,
 *   changelog and the like), never a listing, leaderboard or portfolio on the same site.
 * - A changelog or release-notes page only reads a feed of the same kind: the site's blog feed does
 *   not carry its entries, and swapping one for the other would lose them.
 * - A forum category page whose advertised feed is the site-wide stream (Discourse /posts.rss,
 *   /latest.rss) reads its own category feed, which Discourse serves at the category address plus
 *   .rss. Elsewhere /latest.rss (the newest topics) is fine, but /posts.rss is every reply on the
 *   site and never replaces a page of topics.
 */
export function upgradeTarget(pageUrl: string, feedUrl: string, ownerHost?: string): string | null {
  const page = new URL(pageUrl);
  const feed = new URL(feedUrl);
  if (feed.protocol !== "https:" || feed.username || feed.password) return null;
  // The feed must be the publisher's own: on the page's site, or on the catalog owner's when the page has moved
  // (docs.factory.ai became docs.factory.com). Otherwise a page could point a trusted route at another site or tenant.
  const owner = ownerHost ? bareHost(ownerHost) : null;
  if (!sameSite(page, feed) && !(owner && sameSite(owner, feed))) return null;
  if (/(^|\.)github\.com$/.test(page.hostname)) return null;
  if (CHANGELOG.test(page.pathname) && !CHANGELOG.test(new URL(feedUrl).pathname)) return null;
  const section = page.pathname.replace(/\/+$/, "");
  const underPage = section !== "" && (feed.pathname.startsWith(`${section}/`) || feed.pathname === `${section}.rss`);
  if (!underPage && section !== "" && !CONTENT_SECTION.test(page.pathname) && !/^\/c\//.test(page.pathname)) return null;
  const forumPath = /\/(posts|latest)\.rss$/.exec(feed.pathname)?.[1];
  if (forumPath && /^\/c\//.test(page.pathname)) return `${page.origin}${page.pathname.replace(/\/+$/, "")}.rss`;
  return forumPath === "posts" ? null : feedUrl;
}

const SECTION_FEEDS = ["rss.xml", "feed.xml", "feed", "rss", "atom.xml", "index.xml"];
const SITE_FEEDS = ["feed", "rss.xml", "feed.xml", "atom.xml", "index.xml", "blog/rss.xml", "blog/feed.xml", "news/rss.xml", "news/feed.xml", "blog/feed", "blog/rss"];

/**
 * Where a feed usually is when a page does not advertise one: the page's own address with a feed
 * name appended (cursor.com/changelog/rss.xml), then the site's conventional paths. Each guess is
 * only a candidate; it is a feed once it parses and has recent entries.
 */
export function guessFeedLinks(pageUrl: string): string[] {
  const page = new URL(pageUrl);
  const section = page.pathname.replace(/\/+$/, "");
  const guesses = new Set<string>();
  if (section) {
    for (const name of SECTION_FEEDS) guesses.add(`${page.origin}${section}/${name}`);
    guesses.add(`${page.origin}${section}.rss`);
  }
  for (const path of SITE_FEEDS) guesses.add(`${page.origin}/${path}`);
  return [...guesses];
}
