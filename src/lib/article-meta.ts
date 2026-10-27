import { load } from "cheerio/slim";

// What an article page says about itself: headline, summary, type and, above all, when it was
// published. Index pages often give a link and nothing else, and some give not even that.

export type ArticleMeta = { title: string | null; description: string | null; publishedAt: string | null; type: string | null };

const clean = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

function validDate(value: unknown, now: Date): string | null {
  const raw = clean(value);
  const time = raw ? Date.parse(raw) : NaN;
  // Not before 2000 and not more than a day ahead: a parse of junk or a template placeholder.
  if (!Number.isFinite(time) || time < Date.parse("2000-01-01T00:00:00Z") || time > now.getTime() + 86_400_000) return null;
  return new Date(time).toISOString();
}

const ARTICLE_TYPE = /(?:^|\b)(?:Article|NewsArticle|BlogPosting|TechArticle|Report|ScholarlyArticle|SocialMediaPosting)$/;

type Node = Record<string, unknown>;
function articleNode(value: unknown, depth = 0): Node | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) { for (const child of value) { const found = articleNode(child, depth + 1); if (found) return found; } return null; }
  const node = value as Node;
  const types = ([] as unknown[]).concat(node["@type"] ?? []).map(String);
  if (types.some((type) => ARTICLE_TYPE.test(type))) return node;
  for (const child of Object.values(node)) { const found = articleNode(child, depth + 1); if (found) return found; }
  return null;
}

const DATE_META = ["article:published_time", "og:article:published_time", "datePublished", "pubdate", "publishdate", "publish_date", "date", "dc.date.issued", "dc.date", "citation_publication_date", "parsely-pub-date", "sailthru.date", "article.published"];

/** The headline without a trailing site name: "Embed 5 is faster | Cohere" becomes "Embed 5 is faster". */
function headline(raw: string): string {
  const parts = raw.split(/\s+[|·–—-]\s+/);
  const last = parts.at(-1) ?? "";
  return parts.length > 1 && last.length <= 30 && last.split(" ").length <= 4 && parts.slice(0, -1).join(" - ").length >= 12 ? parts.slice(0, -1).join(" - ") : raw;
}

export function articleMeta(html: string, url: string, now = new Date()): ArticleMeta {
  const $ = load(html);
  const meta = (names: string[]) => {
    for (const name of names) {
      const value = clean($(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`).first().attr("content"));
      if (value) return value;
    }
    return "";
  };
  let ld: Node | null = null;
  $('script[type="application/ld+json"]').each((_, element) => {
    if (ld) return;
    try { ld = articleNode(JSON.parse($(element).text())); } catch { /* Invalid publisher JSON is not evidence. */ }
  });
  const node: Node = ld ?? {};

  let publishedAt = validDate(node.datePublished, now);
  for (const name of publishedAt ? [] : DATE_META) { publishedAt = validDate(meta([name]), now); if (publishedAt) break; }
  if (!publishedAt) {
    const times = [...$('time[itemprop="datePublished"]').toArray(), ...$("article time, main time, header time").toArray(), ...$("time").toArray()];
    for (const element of times) { publishedAt = validDate($(element).attr("datetime"), now); if (publishedAt) break; }
  }
  if (!publishedAt) {
    const match = /\/(20\d{2})\/(\d{2})\/(\d{2})(?:\/|$)/.exec(new URL(url).pathname);
    publishedAt = match ? validDate(`${match[1]}-${match[2]}-${match[3]}`, now) : null;
  }

  const title = clean(node.headline) || clean(node.name) || meta(["og:title", "twitter:title"]) || headline(clean($("title").first().text()));
  const description = clean(node.description) || meta(["og:description", "twitter:description", "description"]);
  const type = meta(["og:type"]).toLowerCase() || ([] as unknown[]).concat(node["@type"] ?? []).map(String)[0]?.toLowerCase() || "";
  return { title: title || null, description: description.slice(0, 600) || null, publishedAt, type: type || null };
}
