// Index pages rendered in the browser have no article cards to read, but the article URLs are
// still in the HTML: in anchors, and in the JSON a framework embeds for its client (Next.js,
// Nuxt, Remix). This lists the same-site URLs under the index page's section. It reads no
// titles or dates; those come from each article's own page (article-meta.ts).

const RESERVED = /^(?:category|categories|tag|tags|topic|topics|page|pages|author|authors|feed|rss|search|archive|archives|index|all|filter|label|labels)$/i;
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|m?js|json|xml|rss|atom|pdf|woff2?|ttf|mp4|webm|mp3|txt|zip)$/i;
const MAX_PATH = 300;
const LOCALE = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;
// A home page that lists posts has no section of its own; the usual ones are tried.
const HOME_SECTIONS = ["blog", "news", "posts", "articles", "research", "updates", "press", "stories"].map((name) => `/${name}/`);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function harvestUrls(html: string, pageUrl: string, limit = 40): string[] {
  const page = new URL(pageUrl);
  const host = page.hostname.replace(/^www\./, "");
  const segments = page.pathname.split("/").filter(Boolean);
  // A locale prefix is not a section: /en/blog is "blog". A home page has no section at all.
  const rootSegments = segments.length > 1 && LOCALE.test(segments[0]) ? segments.slice(0, 2) : segments.slice(0, 1);
  const roots = rootSegments.length ? [`/${rootSegments.join("/")}/`] : HOME_SECTIONS;
  const index = `/${segments.join("/")}`;
  const text = html.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
  // A quote, parenthesis or equals sign (a backslash may escape the quote), then a path or an absolute URL on this host.
  const pattern = new RegExp(`["'(=]\\\\?(?:https://(?:www\\.)?${escape(host)})?(/[A-Za-z0-9][A-Za-z0-9._~%/-]*)`, "g");
  const found = new Set<string>();
  for (const [, raw] of text.matchAll(pattern)) {
    const path = raw.replace(/\/+$/, "");
    if (path.length > MAX_PATH) continue;
    const root = roots.find((candidate) => path.startsWith(candidate));
    if (!root || path === index || found.has(path)) continue;
    const rest = path.slice(root.length).split("/");
    const slug = rest.at(-1) ?? "";
    if (rest.some((part) => RESERVED.test(part)) || ASSET.test(slug) || /^\d+$/.test(slug) || slug.length < 6) continue;
    found.add(path);
    if (found.size >= limit) break;
  }
  return [...found].map((path) => `${page.origin}${path}`);
}
