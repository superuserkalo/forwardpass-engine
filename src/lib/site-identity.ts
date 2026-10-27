import { parse } from "tldts";

// Whose a URL is: the one definition behind every "is this the publisher's own?" decision, which feed a page may
// point its route at, where a redirect may land, whose pages an index links.
//
// A publisher owns a registrable domain and every subdomain of it. The registrable domain comes from the Public
// Suffix List with its private section, where github.io, vercel.app, workers.dev and their like are suffixes, so
// each tenant of such a platform is its own site. Platforms the list does not carry are named below: some give each
// tenant a subdomain (acme.substack.com), some separate tenants by path (medium.com/@acme). An address, or a name
// that is itself a suffix, names a platform and not a tenant of it, and a feed aggregator carries anyone's feed, so
// neither vouches for content. Add a platform here when it turns out to host other people's pages.

const SUBDOMAIN_PLATFORMS = new Set(["substack.com", "medium.com", "ghost.io", "tumblr.com", "wordpress.com", "beehiiv.com", "mintlify.app", "hashnode.dev",
  "typepad.com", "squarespace.com", "livejournal.com", "mataroa.blog", "write.as", "glitch.me", "railway.app", "hs-sites.com", "mailchimpsites.com", "ck.page",
  "bubbleapps.io", "cargo.site", "read.cv", "softr.app"]);

// Platform domain, and how many path segments name a tenant (youtube.com/channel/UC1, reddit.com/r/acme, gitlab.com/acme).
const PATH_PLATFORMS = new Map([["medium.com", 1], ["substack.com", 1], ["dev.to", 1], ["hashnode.com", 1], ["x.com", 1], ["twitter.com", 1], ["github.com", 1],
  ["gitlab.com", 1], ["bitbucket.org", 1], ["facebook.com", 1], ["instagram.com", 1], ["threads.net", 1], ["tiktok.com", 1], ["t.me", 1], ["mastodon.social", 1],
  ["linkedin.com", 2], ["reddit.com", 2], ["youtube.com", 2], ["bsky.app", 2]]);
// First path segments that are the platform's own pages, or a post addressed by number, and so name nobody.
const NOT_A_TENANT = new Set(["p", "m", "t", "i", "tag", "tags", "topic", "topics", "search", "explore", "home", "login", "about", "help", "hashtag", "share",
  "watch", "results", "playlist", "shorts", "trending", "orgs", "pricing", "settings"]);
const FEED_AGGREGATORS = ["feedburner.com", "feedproxy.google.com", "feedblitz.com"];

const unescaped = (segment: string): string => { try { return decodeURIComponent(segment); } catch { return segment; } };
// Platforms compare names by ASCII case; folding wider would merge look-alikes (the Kelvin sign is not a k).
const foldCase = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

function pathTenant(domain: string, depth: number, url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => foldCase(unescaped(segment)));
  // One feed prefix names the tenant's feed (medium.com/feed/@acme); a second is a path like any other, not a prefix.
  if (segments[0] === "feed") segments.shift();
  const first = segments[0];
  if (!first || first === "feed" || NOT_A_TENANT.has(first)) return null;
  const handle = first.startsWith("@");
  const named = segments.slice(0, handle ? 1 : depth);
  if (named.length < (handle ? 1 : depth)) return null;
  // Medium serves one author at medium.com/@acme and at acme.medium.com.
  return domain === "medium.com" && handle ? `${first.slice(1)}.medium.com` : `${domain}/${named.join("/")}`;
}

// Hugging Face hosts its own pages and everyone else's: /<kind>/<owner>/... for spaces, datasets, collections and posts,
// /blog/<slug> for its own writing and /blog/<owner>/<slug> for an organisation's or a member's, and /<owner>/<repo> for
// models. Its own pages are the tenant "huggingface.co", and each owner is a tenant of their own.
const HF_OWNED = new Set(["spaces", "datasets", "collections", "posts"]);
const HF_OWN_PAGES = new Set(["huggingface", "docs", "learn", "papers", "tasks", "api", "models", "join", "login", "settings", "pricing", "enterprise", "chat", "organizations", "new", "support", "jobs", "about", "welcome", "brand"]);
function huggingFaceTenant(url: URL): string {
  const [first, second, third] = url.pathname.split("/").filter(Boolean).map((segment) => foldCase(unescaped(segment)));
  if (!first || HF_OWN_PAGES.has(first)) return "huggingface.co";
  if (HF_OWNED.has(first)) return second ? `huggingface.co/${second}` : "huggingface.co";
  if (first === "blog") return third ? `huggingface.co/${second}` : "huggingface.co";
  return `huggingface.co/${first}`;
}

function tenantName(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  if (FEED_AGGREGATORS.some((aggregator) => host === aggregator || host.endsWith(`.${aggregator}`))) return null;
  // The library validates the name it is given, and reads nothing back for text no name can be (a host with a semicolon
  // or an apostrophe in it), which is then only itself. Do not pass extractHostname: false: it skips that validation and
  // attributes a.github.io'.b.github.io to b.github.io.
  const { domain, hostname, isIp } = parse(host, { allowPrivateDomains: true });
  if (hostname !== host || isIp || !domain) return host;
  const subdomain = host === domain ? "" : host.slice(0, -domain.length - 1);
  const label = subdomain.split(".").at(-1) ?? "";
  if (SUBDOMAIN_PLATFORMS.has(domain) && label && label !== "www") return `${label}.${domain}`;
  if (domain === "huggingface.co" && (subdomain === "" || subdomain === "www")) return huggingFaceTenant(url);
  const depth = PATH_PLATFORMS.get(domain);
  return depth ? pathTenant(domain, depth, url) : domain;
}

/**
 * Whose a URL is, or null when its address proves nothing about who published what is there. The port is part of
 * it: another port is another service, and on a shared host often another customer.
 */
export function tenantOf(url: URL): string | null {
  const name = tenantName(url);
  return name === null ? null : `${name}${url.port ? `:${url.port}` : ""}`;
}

/** Whether two URLs belong to the same publisher: the same site, and on a shared platform the same tenant. */
export function sameSite(a: URL, b: URL): boolean {
  const left = tenantOf(a);
  return left !== null && left === tenantOf(b);
}

/**
 * A bare host name (no scheme, path, credentials or port) as an https URL, or null. The URL parser reads 0x7f.1 and
 * 2130706433 as addresses and folds case, so a name is accepted only when what the parser makes of it is the name,
 * and a name made only of digits and dots is never a name.
 */
export function bareHost(value: string): URL | null {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) || /^[\d.]+$/.test(value)) return null;
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value.toLowerCase() ? url : null;
  } catch { return null; }
}
