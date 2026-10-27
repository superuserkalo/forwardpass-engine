import { createHash } from "node:crypto";
import { load } from "cheerio/slim";
import { harvestUrls } from "./url-harvest.js";
import type { SourceStream } from "./source-streams.js";
import { isVagueTitle } from "./vague-title.js";

export type IndexRecord = Record<string, unknown>;
const object = (v: unknown): IndexRecord | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as IndexRecord : undefined;
const text = (v: unknown): string => typeof v === "string" ? v.trim() : Array.isArray(v) ? text(v[0]) : "";
const hash = (v: string): string => createHash("sha256").update(v).digest("hex").slice(0, 20);
const clean = (v: string): string => v.replace(/\s+/g, " ").trim();
function link(value: string, base: string): string | null {
  try { const u = new URL(value, base); return u.protocol === "https:" ? u.href : null; } catch { return null; }
}
function dateFromPath(url: string): string | undefined {
  const match = /\/(20\d{2})\/(\d{2})\/(\d{2})(?:\/|$)/.exec(url);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

// Item-level dates only: never assign the listing page's updated date to its cards.
export function htmlIndex(stream: SourceStream, body: string): IndexRecord[] {
  const $ = load(body);
  const found = new Map<string, IndexRecord>();
  if (new URL(stream.url).hostname === "github.com" && new URL(stream.url).pathname.split("/").filter(Boolean).length === 2) {
    const readme = clean($("article.markdown-body,article[itemprop=text],.markdown-body").first().text());
    if (!readme) throw new Error("Repository README not present in response");
    return [{ link: stream.url, guid: stream.url, title: `${stream.publisher}: ${stream.section} README changed`, description: readme.slice(0, 1500), revision: hash(readme), undated: true, watch: true }];
  }
  function add(title: string, href: string, date: unknown, description = "") {
    const url = link(href, stream.url);
    if (!url) return;
    if (new URL(url).hostname.replace(/^www\./, "") !== new URL(stream.url).hostname.replace(/^www\./, "")) return;
    if (url.split("#")[0] === stream.url.split("#")[0] && !url.includes("#")) return;
    const previous = found.get(url);
    // A card often links its page twice, by its title and by a button ("View details"), and the button must not replace the title.
    // A label with no title beside it stands for the address, which at least says what the page is called.
    const text = isVagueTitle(title) ? String(previous?.title ?? slugTitle(url)) : title;
    if (clean(text).length < 8) return;
    found.set(url, { link: url, guid: url, title: clean(text).slice(0, 400), description: clean(description).slice(0, 1000) || previous?.description || "", pubDate: previous?.pubDate || date || dateFromPath(url), undated: true });
  }
  function schema(value: unknown, depth = 0): void {
    if (depth > 12) return;
    if (Array.isArray(value)) { value.forEach((v) => schema(v, depth + 1)); return; }
    const row = object(value);
    if (!row) return;
    if (/Article|Posting|NewsArticle|ScholarlyArticle/.test(String(row["@type"]))) {
      const entity = object(row.mainEntityOfPage);
      add(text(row.headline || row.name), text(row.url || entity?.["@id"] || row["@id"]), row.datePublished, text(row.description));
    }
    for (const child of Object.values(row)) if (typeof child === "object") schema(child, depth + 1);
  }
  $('script[type="application/ld+json"]').each((_, el) => { try { schema(JSON.parse($(el).text())); } catch { /* Invalid publisher JSON is not evidence. */ } });
  $("nav,header,footer,aside,script,style,noscript").remove();
  $("a[href]").each((_, el) => {
    const a = $(el);
    const card = a.closest('article,li,[class*="card"],[class*="Card"],[class*="post"],[class*="Post"],[class*="item"],[class*="Item"]');
    const title = a.find('h1,h2,h3,h4,[class*="title"],[class*="Title"]').first().text()
      || (a.parent().is('h1,h2,h3,h4') || a.is('[class*="heading"],[class*="Heading"],[class*="title"],[class*="Title"]') ? a.text() : "")
      || (card.length && card.find("a").first().get(0) === el ? card.find("h1,h2,h3,h4").first().text() || a.text() : "");
    if (!title) return;
    const scope = a.find("time").length ? a : card;
    const time = scope.find("time").first();
    const date = time.attr("datetime") || time.text() || scope.find('[itemprop="datePublished"]').attr("content");
    add(title, a.attr("href") || "", date, scope.find("p").first().text());
  });
  // Changelogs often have dated section headings with anchors instead of cards.
  $("h2[id],h3[id]").each((_, el) => {
    const heading = $(el);
    const title = clean(heading.text());
    if (!/20\d{2}/.test(title) || !Number.isFinite(Date.parse(title))) return;
    const id = heading.attr("id");
    const content = clean(heading.nextUntil("h2,h3").text());
    if (id && content) add(`${title}: ${content.slice(0, 120)}`, `#${id}`, title, content);
  });
  if (found.size) return [...found.values()];
  // An undated publication surface is a change monitor, never a fake release.
  const main = $("main,article,[role=main]").first();
  const content = clean((main.length ? main : $("body")).text());
  if (content.length < 180 || /enable javascript|checking your browser|verify you are human|just a moment/i.test(content.slice(0, 600))) {
    throw new Error("No publication records; rendering or an access challenge prevents collection");
  }
  return [{ link: stream.url, guid: stream.url, title: `${stream.publisher}: ${stream.section} page changed`, description: content.slice(0, 1500), undated: true, revision: hash(content), watch: true }];
}

// A malformed percent sequence in a link must not fail the whole route.
function slugTitle(url: string): string {
  const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  let text = slug;
  try { text = decodeURIComponent(slug); } catch { /* keep the raw slug */ }
  return text.replace(/[-_]+/g, " ").replace(/\.\w+$/, "").trim().slice(0, 200);
}

/**
 * Cards from the page's HTML, or, when it has none (a page rendered in the browser), the article URLs
 * it links. Those have no title or date yet; the collector reads them from each article's page.
 * A repository page stays a README monitor.
 */
export function htmlRecords(stream: SourceStream, body: string): IndexRecord[] {
  const harvest = () => new URL(stream.url).hostname === "github.com" ? [] : harvestUrls(body, stream.url);
  let records: IndexRecord[];
  try { records = htmlIndex(stream, body); } catch (error) {
    // A shell with almost no text can still list its articles in the JSON it embeds.
    const urls = harvest();
    if (!urls.length) throw error;
    return urls.map((url) => ({ link: url, guid: url, title: slugTitle(url), description: "", undated: true, harvested: true }));
  }
  if (!(records.length === 1 && records[0].watch === true)) return records;
  const urls = harvest();
  return urls.length ? urls.map((url) => ({ link: url, guid: url, title: slugTitle(url), description: "", undated: true, harvested: true })) : records;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function markdownIndex(stream: SourceStream, body: string): IndexRecord[] {
  const sections = body.split(/(?=^#{1,3} .+$)/m);
  const dated: IndexRecord[] = [];
  // Changelogs that group days under a month heading ("## September, 2026" then "### Sep 29").
  let year: string | undefined;
  for (const section of sections) {
    const heading = section.split("\n")[0].replace(/^#+\s*/, "");
    year = /^[A-Za-z]+,?\s+(20\d{2})$/.exec(heading.trim())?.[1] ?? year;
    const day = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})$/.exec(heading.trim());
    const month = day ? MONTHS.indexOf(day[1].toLowerCase()) : -1;
    const date = /\b20\d{2}-\d{2}-\d{2}\b/.exec(heading)?.[0]
      ?? (day && month >= 0 && year ? `${year}-${String(month + 1).padStart(2, "0")}-${day[2].padStart(2, "0")}` : undefined);
    if (!date) continue;
    // A day heading alone is not a title: use the entry's first prose line, without links.
    const lines = section.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
    const prose = lines.find((line) => line.split(/\s+/).length >= 6 && !line.includes(" · ")) ?? lines[0] ?? heading;
    const title = day ? prose.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").split(/(?<=\.)\s/)[0].slice(0, 160) : heading;
    // Each entry links to its own anchor on the readable page, so entries stay distinct items.
    const entry = `${stream.url.replace(/\.md$/, "")}#${date}-${hash(section).slice(0, 8)}`;
    dated.push({ guid: entry, link: day ? entry : stream.url, title, description: section.slice(0, 1500), pubDate: date });
  }
  return dated.length ? dated : [{ link: stream.url, guid: stream.url, title: `${stream.publisher}: ${stream.section} changed`, description: body.slice(0, 1500), revision: hash(body), undated: true, watch: true }];
}

// Sites that render their news index in the browser still list every article in their
// sitemap, usually without useful per-article dates. Each URL under the stream's path
// pattern becomes an undated record; the collector reports the ones it has not seen before.
export function sitemapIndex(stream: SourceStream, body: string): IndexRecord[] {
  const match = stream.match ? new RegExp(stream.match) : null;
  const records: IndexRecord[] = [];
  for (const [, raw] of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = link(raw.replace(/&amp;/g, "&"), stream.url);
    if (!url) continue;
    const path = new URL(url).pathname.replace(/\/$/, "");
    if (match && !match.test(path)) continue;
    const slug = path.split("/").pop() ?? "";
    const title = slug.split("-").filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    if (title) records.push({ guid: url, link: url, title: `${stream.publisher}: ${title}`, undated: true });
  }
  return records;
}

export function indexRequest(stream: SourceStream): RequestInit {
  const url = stream.url;
  let body: unknown;
  if (url.includes("research.samsung.com/newsMain")) body = { startIndex: 0, endIndex: 100 };
  if (url.includes("research.samsung.com/blogMain")) body = { startIndex: 1, currentPageNo: 1, endIndex: 100, searchText: "", categoryCd: "" };
  if (url.includes("research.samsung.com/research-papers/paper")) body = { currentPageNo: 0, searchCategory: "SR.PAPER.SEARCH.ALL", searchText: "", yearVal: [], researchAreaVal: [], collectionVal: [] };
  if (url.includes("micron.com/") && url.includes(".search.json/search")) body = { filters: { contentType: ["micron:document type-categories-subcategories/blog"] }, locale: "en_US", searchText: "", numOfResult: 100, startOffset: 0, sortBy: "Date" };
  return body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
}

export function jsonIndex(stream: SourceStream, body: string): IndexRecord[] {
  const value: unknown = JSON.parse(body);
  const root = object(value);
  if (stream.url.includes("pypi.org/pypi/")) {
    const releases = object(root?.releases) || {};
    const info = object(root?.info);
    return Object.entries(releases).flatMap(([version, files]) => {
      const file = Array.isArray(files) ? object(files[0]) : undefined;
      return file ? [{ guid: version, link: `https://pypi.org/project/${text(info?.name)}/${version}/`, title: `${text(info?.name)} ${version}`, pubDate: file.upload_time_iso_8601, description: text(info?.summary) }] : [];
    });
  }
  if (stream.url.includes("api.github.com/orgs/")) {
    if (!Array.isArray(value)) throw new Error("Expected GitHub repository array");
    return value.flatMap((v) => { const r = object(v); return r && !r.fork ? [{ guid: String(r.id), link: r.html_url, title: r.full_name, description: r.description, undated: true, revision: r.pushed_at, watch: true }] : []; });
  }
  if (stream.url.includes("huggingface.co/api/models")) {
    if (!Array.isArray(value)) throw new Error("Expected model array");
    return value.flatMap((v) => { const r = object(v); return r ? [{ guid: r.id, link: `https://huggingface.co/${r.id}`, title: r.id, description: text(r.pipeline_tag), undated: true, revision: r.lastModified, watch: true }] : []; });
  }
  const rows: IndexRecord[] = [];
  function visit(v: unknown, depth = 0): void {
    if (depth > 12) return;
    if (Array.isArray(v)) { v.forEach((r) => visit(r, depth + 1)); return; }
    const r = object(v); if (!r) return;
    const title = text(r.title || r.name || r.subject || r.paperTitle || r.newsTitle || r.blogTitle || r.ss_title || r.suggested_text_en);
    const href = text(r.url || r.link || r.path || r.uri || r.ss_url || r.doi || r.linkUrl || r.urlLink || r.pageurl || (r.uuid ? `/research-papers/${r.uuid}` : ""));
    if (title && href) {
      const normalizedHref = href.replace(/^\/content\/public\/us\/en\/engineering/, "/public/us/en/engineering").replace(/^\/content\/micron\/us\/en/, "");
      const url = link(normalizedHref.startsWith("10.") ? `https://doi.org/${normalizedHref}` : normalizedHref, stream.url);
      if (url) rows.push({ guid: url, link: url, title, description: text(r.description || r.summary || r.abstract || r.detail || r.tm_X3b_en_field_teaser_text || r.description_en), pubDate: (/Published:\s*(\d{2}\/\d{2}\/\d{4})/.exec(text(r.content_en))?.[1]) || r.datePublished || r.published_at || r.publicationDate || r.ds_field_publication_date || r.publishdate || (typeof r.newsDts === "number" ? new Date(r.newsDts).toISOString() : null) || text(r.publicationDtsStr).replace(/^On /, "") || text(r.publicationDateFormat).replaceAll(".", "-"), undated: true });
    }
    for (const child of Object.values(r)) if (typeof child === "object") visit(child, depth + 1);
  }
  visit(value);
  if (!rows.length) throw new Error("JSON index schema did not expose publication records");
  return rows;
}
