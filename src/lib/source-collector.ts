import { XMLParser } from "fast-xml-parser";
import { htmlRecords, markdownIndex, jsonIndex, indexRequest, sitemapIndex } from "./source-index.js";
import { resolveArticle, type Resolution } from "./resolve-items.js";
import { createPacedRunner, mapOrigins } from "./concurrency.js";
import type { Candidate } from "./schemas.js";
import { SOURCE_STREAMS, type SourceStream } from "./source-streams.js";
import { decodeBody } from "./body-text.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
});
const MAX_BODY_BYTES = 8_000_000;
// What the state remembers is bounded by what the collector can still use, since the state is read whole to commit each run and cut into the
// shards, in a Worker with 128 MB: a dated item older than the backfill window is never reported again, so it is forgotten after ten days;
// an undated card is remembered for as long as it is listed, and forgotten thirty days after it was last seen.
const RETAIN_MS = 10 * 86_400_000;
const UNDATED_RETAIN_MS = 30 * 86_400_000;
// Runs start a few seconds off their schedule. A route whose interval is a whole number of runs
// must not be skipped because this run began slightly early.
const DUE_SLACK_MS = 10 * 60_000;
// Undated items are read from their own page for a date and a headline. Bounded per route and per
// run so a large index cannot turn one poll into hundreds of requests; the first read of a route
// resolves fewer, since most of what it lists is old.
const STREAM_RESOLVES = 8;
const BASELINE_RESOLVES = 5;
const RUN_RESOLVES = 200;
// Counts bound the requests; this bounds the time. A slow or hostile site cannot hold a run: once
// the budget is spent no new article read starts, and every card is still reported.
const RUN_RESOLVE_MS = 60_000;
const MAX_RETRIES = 2;
const INITIAL_LOOKBACK_MS = 72 * 3_600_000;
const MAX_BACKFILL_MS = 7 * 86_400_000;
// arXiv's legacy API policy also covers RSS. Share one queue across arXiv
// origins and collector calls in this process, not one queue per category.
const runArxivRequest = createPacedRunner(3_000);
const ARXIV_HOSTS = new Set(["arxiv.org", "export.arxiv.org", "rss.arxiv.org"]);

export interface StreamState {
  etag?: string;
  lastModified?: string;
  lastSucceededAt?: string;
  seen: Record<string, string>;
  revisions?: Record<string, string>;
  undatedIds?: string[];
}

export interface CollectorState {
  version: 1;
  streams: Record<string, StreamState>;
}

export interface SourceItem extends Candidate {
  id: string;
  streamId: string;
  publisherId: string;
  scoreReasons: string[];
  firstSeenAt: string;
  publicationCategory?: string;
  score: number;
}

export interface SourceHealth {
  streamId: string;
  section: string;
  status: "ok" | "unchanged" | "partial" | "failed" | "not-due" | "permission-required" | "reference" | "delegated";
  itemCount: number;
  newCount: number;
  invalidCount: number;
  bytes: number;
  backfillLimited: boolean;
  possiblyTruncated: boolean;
  error?: string;
  baselineCount?: number;
  monitorCount?: number;
}

export interface CollectionResult {
  collectedAt: string;
  items: SourceItem[];
  shortlist: SourceItem[];
  health: SourceHealth[];
  state: CollectorState;
  duplicateCount: number;
}

type FeedRecord = Record<string, unknown>;
type Fetcher = typeof fetch;

function record(value: unknown): FeedRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as FeedRecord
    : null;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  const object = record(value);
  return object ? asText(object["#text"]) : "";
}

function arrayOfRecords(value: unknown): FeedRecord[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.flatMap((item) => {
    const object = record(item);
    return object ? [object] : [];
  });
}

function atomLink(value: unknown): string {
  const links = arrayOfRecords(value);
  const alternate = links.find((link) => !link["@rel"] || link["@rel"] === "alternate");
  return asText(alternate?.["@href"]);
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (match, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const code = decimal ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}
// Tags that are tags. A title such as "Understanding Vec<T>" has angle brackets and is not markup.
const HTML_TAG = /<\/?(?:p|br|div|span|a|b|i|u|em|strong|small|sup|sub|code|pre|time|font|center|h[1-6]|ul|ol|li|img|table|thead|tbody|tr|td|th|figure|figcaption|blockquote|section|article|header|footer)\b[^>]*>/gi;

/** A title as plain text: entities decoded (twice, for a feed that escaped its HTML twice), real tags removed, one line. */
export function plainTitle(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeEntities(current).replace(HTML_TAG, " ");
    if (next === current) break;
    current = next;
  }
  return current.replace(/\s+/g, " ").trim();
}

function summary(value: unknown): string {
  const raw = asText(value);
  return plainTitle(raw).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function isoDate(value: unknown): string | null {
  const raw = asText(value);
  if (!raw) return null;
  const timestamp = Date.parse(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(raw) ? `${raw} 00:00:00 GMT` : raw);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function safeUrl(value: unknown, base?: string): string | null {
  try {
    if (!asText(value)) return null;
    const url = new URL(asText(value), base);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function feedItems(stream: SourceStream, body: string): FeedRecord[] {
  const document: unknown = parser.parse(body);
  const root = record(document);
  if (!root) throw new Error("Invalid XML document");
  const atom = record(root.feed);
  const channel = record(record(root.rss)?.channel);
  const rdf = record(root.RDF);
  if (atom) return arrayOfRecords(atom.entry).map((row) => ({ ...row, feedFormat: "atom", undated: true }));
  if (channel) return arrayOfRecords(channel.item).map((row) => ({ ...row, feedFormat: "rss", undated: true }));
  if (rdf) return arrayOfRecords(rdf.item).map((row) => ({ ...row, feedFormat: "rss", undated: true }));
  throw new Error("Missing RSS, Atom, or RDF feed");
}

function releaseItems(body: string): FeedRecord[] {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("GitHub releases response was not an array");
  return arrayOfRecords(parsed).filter((release) => release.draft !== true);
}

function normalizeRecord(stream: SourceStream, item: FeedRecord): Omit<SourceItem, "firstSeenAt" | "score" | "scoreReasons"> | null {
  const isAtom = item.feedFormat ? item.feedFormat === "atom" : stream.kind === "atom";
  const isRelease = stream.kind === "github-releases";
  const url = safeUrl(isRelease ? item.html_url : isAtom ? atomLink(item.link) : item.link ?? item.guid, stream.url);
  const publishedAt = isoDate(isRelease ? item.published_at : isAtom ? item.published ?? item.updated : item.pubDate ?? item.date);
  const rawTitle = plainTitle(asText(item.title ?? item.name ?? item.tag_name));
  if (!url || (!publishedAt && !item.undated) || !rawTitle) return null;
  const title = isRelease ? `${stream.section}: ${asText(item.name) || asText(item.tag_name)}` : rawTitle;
  const stableId = asText(isRelease ? item.id : isAtom ? item.id : item.guid) || url;
  return {
    id: `${stream.id}:${stableId}`,
    streamId: stream.id,
    publisherId: stream.publisherId,
    title,
    summary: summary(isRelease ? item.body : isAtom ? item.summary ?? item.content : item.description ?? item.encoded),
    url,
    publishedAt,
    dateKind: publishedAt
      ? (isAtom && !item.published && item.updated) || (stream.url.includes("rss.arxiv.org") && /Announce Type: (?:replace|cross|withdraw)/i.test(asText(item.description))) ? "changed" : "published"
      : item.watch ? "changed" : "first-seen",
    source: stream.publisher,
    category: stream.category,
    publicationCategory: asText(item.category) || undefined,
  };
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  // On a changelog page the anchor is the entry, so it stays part of the identity.
  if (!/changelog/i.test(url.pathname)) url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${url.search}${url.hash}`;
}

// Cheap discovery priority, not a verdict on whether a claim is true or important.
// Publisher names, feed categories and publication labels deliberately do not score.
export function scoreSourceItem(
  item: Pick<SourceItem, "title" | "summary" | "publishedAt">,
  now: Date,
): Pick<SourceItem, "score" | "scoreReasons"> {
  const text = `${item.title} ${item.summary}`;
  let score = 0;
  const scoreReasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    scoreReasons.push(`${points > 0 ? "+" : ""}${points}: ${reason}`);
  };
  const technical = /\b(?:ai|ml|llms?|language models?|models?|prompt|caching|tokens?|multimodal|text.to.speech|machine learning|neural|inference|serving|training|fine.tuning|agents?|agentic|retrieval|embeddings?|transformers?|gpu|mcp|sdk|api|software engineering|coding)\b/i.test(text);
  if (technical) {
    add(3, "AI or engineering relevance");
    if (/\b(?:benchmark|evaluation|experiment|ablation|baseline|reproducib|dataset)\w*\b/i.test(text)) add(2, "Evaluation or reproducibility detail");
    if (/\b(?:latency|throughput|memory|cost|reliability|failure|incident|outage|postmortem|post-mortem|deployment|production|scaling|trade.off)\w*\b/i.test(text)) add(2, "Operational results or constraints");
    if (/\b(?:open.source|source code|model weights|checkpoint|repository|implementation)\b/i.test(text)) add(1, "Inspectable artifact mentioned");
  }
  // Do not penalize a paper, a versioned release, an industry, or a how-to format.
  if (/\b(?:funding|series [a-f]|hiring|webinar|podcast|roundup)\b/i.test(item.title)) add(-3, "Promotional or recap format");
  const ageHours = (now.getTime() - Date.parse(item.publishedAt ?? "")) / 3_600_000;
  if (ageHours >= 0 && ageHours < 24) add(2, "Published within 24 hours");
  return { score, scoreReasons };
}

function compareSourceItems(a: SourceItem, b: SourceItem): number {
  return b.score - a.score
    || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")
    || a.id.localeCompare(b.id);
}

export function shortlistSourceItems(items: SourceItem[], limit = 20): SourceItem[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Shortlist limit must be a non-negative integer");
  // One publisher receives at most 20% of slots, rounded up, across all its streams.
  // Leave slots empty when coverage is narrow rather than silently lifting the cap.
  const publisherCap = Math.max(1, Math.ceil(limit / 5));
  const perPublisher = new Map<string, number>();
  const releaseStreams = new Set<string>();
  const shortlist: SourceItem[] = [];
  for (const item of [...items].sort(compareSourceItems)) {
    if (shortlist.length >= limit) break;
    // Package monorepos may publish dozens of related versions in one batch.
    if (item.category === "software release" && releaseStreams.has(item.streamId)) continue;
    const count = perPublisher.get(item.publisherId) ?? 0;
    if (count >= publisherCap) continue;
    perPublisher.set(item.publisherId, count + 1);
    if (item.category === "software release") releaseStreams.add(item.streamId);
    shortlist.push(item);
  }
  return shortlist;
}

async function fetchBody(response: Response, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const sizeHeader = Number(response.headers.get("content-length"));
  if (sizeHeader > maxBytes) { await response.body?.cancel(); throw new Error(`Response exceeds ${maxBytes / 1_000_000} MB limit`); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty HTTP response");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Response exceeds ${maxBytes / 1_000_000} MB limit`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return decodeBody(Buffer.concat(chunks), response.headers.get("content-type") ?? "");
}

async function fetchSourcePage(url: URL, init: RequestInit, fetcher: Fetcher): Promise<{ response: Response; body: string }> {
  const run = async () => {
    // Start the network timeout after waiting for the provider's request slot.
    const response = await fetcher(url.href, { ...init, signal: AbortSignal.timeout(30_000) });
    if (response.status === 304 || !response.ok) {
      await response.body?.cancel();
      return { response, body: "" };
    }
    const body = await fetchBody(response, url.hostname === "metr.org" ? 32_000_000 : MAX_BODY_BYTES);
    return { response, body };
  };
  return ARXIV_HOSTS.has(url.hostname) ? runArxivRequest(run) : run();
}

export async function collectSourceStreams(
  previous: CollectorState = { version: 1, streams: {} },
  options: { now?: Date; streams?: readonly SourceStream[]; fetcher?: Fetcher; clock?: () => number; resolveBudgetMs?: number } = {},
): Promise<CollectionResult> {
  const now = options.now ?? new Date();
  const streams = options.streams ?? SOURCE_STREAMS;
  const fetcher = options.fetcher ?? fetch;
  const state: CollectorState = { version: 1, streams: { ...previous.streams } };
  const collectedAt = now.toISOString();
  let runResolved = 0;
  const clock = options.clock ?? Date.now;
  const resolveDeadline = clock() + (options.resolveBudgetMs ?? RUN_RESOLVE_MS);
  const results = await mapOrigins(streams, (stream) => new URL(stream.url).origin, async (stream): Promise<{ items: SourceItem[]; health: SourceHealth }> => {
    const prior = state.streams[stream.id] ?? { seen: {} };
    const oldestAllowed = now.getTime() - MAX_BACKFILL_MS;
    const lastSuccess = prior.lastSucceededAt ? Date.parse(prior.lastSucceededAt) : NaN;
    const windowStart = Number.isNaN(lastSuccess)
      ? now.getTime() - INITIAL_LOOKBACK_MS
      : Math.max(oldestAllowed, lastSuccess - 24 * 3_600_000);
    const health: SourceHealth = {
      streamId: stream.id, section: stream.section, status: "failed", itemCount: 0,
      newCount: 0, invalidCount: 0, bytes: 0,
      backfillLimited: !Number.isNaN(lastSuccess) && lastSuccess < oldestAllowed,
      possiblyTruncated: false,
    };
    if (stream.kind === "hn-list") { health.status = "delegated"; health.error = "Collected with item records and metric history by the attention collector"; return { items: [], health }; }
    if (stream.access && stream.access !== "public") {
      health.status = stream.access; health.error = stream.accessReason;
      return { items: [], health };
    }
    if (stream.intervalHours && Number.isFinite(lastSuccess) && now.getTime() - lastSuccess < stream.intervalHours * 3_600_000 - DUE_SLACK_MS) {
      health.status = "not-due"; return { items: [], health };
    }
    try {
      const headers: Record<string, string> = {
        "User-Agent": "ForwardPassSourceCollector/1.0 (+https://theforwardpass.net)",
        Accept: ["github-releases", "json-index"].includes(stream.kind) ? "application/json" : stream.kind === "html-news" ? "text/html, application/xhtml+xml;q=0.9, */*;q=0.1" : stream.kind === "markdown" ? "text/plain" : "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      };
      if (prior.etag) headers["If-None-Match"] = prior.etag;
      if (prior.lastModified) headers["If-Modified-Since"] = prior.lastModified;
      const request = indexRequest(stream);
      const requestUrl = new URL(stream.url);
      if (requestUrl.origin === "https://api.github.com" && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      if (requestUrl.origin === "https://huggingface.co" && requestUrl.pathname.startsWith("/api/") && process.env.HF_TOKEN) {
        headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
      }
      if (requestUrl.hostname === "www.csail.mit.edu" && requestUrl.searchParams.has("rows")) requestUrl.searchParams.set("rows", "1000");
      if (requestUrl.hostname === "api.github.com" && requestUrl.pathname.includes("/orgs/")) requestUrl.searchParams.set("per_page", "100");
      if (requestUrl.hostname === "huggingface.co" && requestUrl.pathname === "/api/models") requestUrl.searchParams.set("limit", "100");
      const { response, body } = await fetchSourcePage(requestUrl, { ...request, headers: { ...headers, ...request.headers } }, fetcher);
      if (response.status === 304) {
        health.status = "unchanged";
        state.streams[stream.id] = { ...prior, lastSucceededAt: collectedAt };
        return { items: [], health };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      health.bytes = Buffer.byteLength(body);
      const parse = (body: string) => stream.kind === "github-releases" ? releaseItems(body) : stream.kind === "html-news" ? htmlRecords(stream, body) : stream.kind === "json-index" ? jsonIndex(stream, body) : stream.kind === "markdown" ? markdownIndex(stream, body) : stream.kind === "sitemap" ? sitemapIndex(stream, body) : feedItems(stream, body);
      const raw = parse(body);
      const nextLink = (response: Response) => /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
      let next = nextLink(response);
      let pageCount = 1;
      let lastPage = raw;
      // Bounded backfill follows provider pagination; never calls a search service.
      while (next && pageCount < 3 && ["github-releases", "json-index"].includes(stream.kind)) {
        const nextUrl = new URL(next);
        if (nextUrl.origin !== requestUrl.origin || nextUrl.protocol !== "https:") throw new Error("Cross-origin pagination rejected");
        if (stream.kind === "github-releases" && lastPage.length && lastPage.every((row) => Date.parse(String(row.published_at)) < windowStart)) { next = undefined; break; }
        // Pagination has independent cache validators. Reusing page-one ETags is unsafe.
        const pageHeaders = { ...headers };
        delete pageHeaders["If-None-Match"]; delete pageHeaders["If-Modified-Since"];
        const { response: page, body: pageBody } = await fetchSourcePage(nextUrl, { headers: pageHeaders }, fetcher);
        if (!page.ok) { health.error = `Pagination HTTP ${page.status}`; break; }
        health.bytes += Buffer.byteLength(pageBody);
        lastPage = parse(pageBody); raw.push(...lastPage); pageCount++; next = nextLink(page);
      }
      health.itemCount = raw.length;
      health.possiblyTruncated = Boolean(next);
      if (stream.kind === "json-index") {
        const document: unknown = JSON.parse(body);
        const root = record(document);
        const total = record(root?.response)?.numFound;
        if (typeof total === "number" && total > raw.length) health.possiblyTruncated = true;
        // Website POST indexes expose bounded pages; report that boundary even when a date window is covered.
        if (request.body) health.possiblyTruncated = true;
      }
      const seen = { ...prior.seen };
      const revisions = { ...prior.revisions };
      const undatedIds = new Set(prior.undatedIds ?? []);
      const items: SourceItem[] = [];
      let streamResolved = 0;
      for (const item of raw) {
        const normalized = normalizeRecord(stream, item);
        if (!normalized) { health.invalidCount++; continue; }
        if (!normalized.publishedAt) {
          undatedIds.add(normalized.id);
          const changed = Boolean(item.revision && revisions[normalized.id] && item.revision !== revisions[normalized.id]);
          const baseline = !prior.lastSucceededAt;
          const previousSighting = seen[normalized.id];
          const retries = previousSighting?.startsWith("retry:") ? Number(previousSighting.slice(6)) : 0;
          const isNew = !previousSighting || previousSighting.startsWith("retry:");
          // A page monitor reports changes. Every other undated record is an article whose own page can say more.
          const resolvable = isNew && !item.watch && typeof item.revision !== "string" && new URL(normalized.url).origin === requestUrl.origin;
          let resolution: Resolution | "skip" | null = null;
          let attempted = false;
          if (resolvable && streamResolved < (baseline ? BASELINE_RESOLVES : STREAM_RESOLVES) && runResolved < RUN_RESOLVES && clock() < resolveDeadline) {
            attempted = true; streamResolved++; runResolved++;
            // Only a custom fetcher (the browser pass, tests) is passed on; by default the page goes through the evidence loader, which checks every address in Node.
            resolution = await resolveArticle(normalized.url, { fetcher: options.fetcher, now, indexBody: body });
          }
          // An error page or a non-article is not an item.
          if (resolution === "skip") { seen[normalized.id] = collectedAt; continue; }
          // The article's own date decides: inside the window it is news (even on a route's first read), older it is not.
          if (resolution?.publishedAt) {
            const published = Date.parse(resolution.publishedAt);
            seen[normalized.id] = resolution.publishedAt;
            if (published >= windowStart && published <= now.getTime() + 3_600_000) {
              const dated = { ...normalized, title: item.harvested || stream.kind === "sitemap" ? resolution.title ?? normalized.title : normalized.title,
                summary: normalized.summary || resolution.description || "", publishedAt: resolution.publishedAt, dateKind: "published" as const };
              items.push({ ...dated, firstSeenAt: collectedAt, observedAt: collectedAt, ...scoreSourceItem(dated, now) });
            }
            continue;
          }
          // A harvested link has no title of its own, so it is an item only once its page has been read.
          if (item.harvested && !resolution) {
            if (baseline) { seen[normalized.id] = collectedAt; health.baselineCount = (health.baselineCount ?? 0) + 1; }
            else if (attempted) seen[normalized.id] = retries >= MAX_RETRIES ? collectedAt : `retry:${retries + 1}`;
            continue;
          }
          const enriched = resolution
            ? { ...normalized, title: item.harvested || stream.kind === "sitemap" ? resolution.title ?? normalized.title : normalized.title, summary: normalized.summary || resolution.description || "" }
            : normalized;
          if (prior.lastSucceededAt && (isNew || changed)) {
            // A changed page is news from the change, not from the day the monitor first read it.
            items.push({ ...enriched, firstSeenAt: collectedAt, observedAt: collectedAt, ...scoreSourceItem(enriched, now) });
          } else if (isNew) health.baselineCount = (health.baselineCount ?? 0) + 1;
          if (item.watch) health.monitorCount = (health.monitorCount ?? 0) + 1;
          // Seen again, or for the first time: remembered from now.
          seen[normalized.id] = collectedAt;
          if (typeof item.revision === "string") revisions[normalized.id] = item.revision;
          continue;
        }
        const published = Date.parse(normalized.publishedAt);
        if (published > now.getTime() + 3_600_000 || published < oldestAllowed) continue;
        if ((!seen[normalized.id] || seen[normalized.id] !== normalized.publishedAt) && published >= windowStart) {
          items.push({ ...normalized, dateKind: seen[normalized.id] ? "changed" : normalized.dateKind, firstSeenAt: collectedAt, observedAt: collectedAt, ...scoreSourceItem(normalized, now) });
        }
        seen[normalized.id] = normalized.publishedAt ?? collectedAt;
      }
      if (raw.length > 0 && health.invalidCount === raw.length) {
        throw new Error("Source returned no items with a valid title, URL, and publication date");
      }
      for (const [id, date] of Object.entries(seen)) {
        if (Date.parse(date) < now.getTime() - (undatedIds.has(id) ? UNDATED_RETAIN_MS : RETAIN_MS)) { delete seen[id]; undatedIds.delete(id); }
      }
      health.status = health.possiblyTruncated || health.invalidCount > 0 ? "partial" : "ok";
      health.newCount = items.length;
      state.streams[stream.id] = {
        seen, revisions, undatedIds: [...undatedIds], lastSucceededAt: collectedAt,
        etag: response.headers.get("etag") ?? prior.etag,
        lastModified: response.headers.get("last-modified") ?? prior.lastModified,
      };
      return { items, health };
    } catch (error) {
      health.error = error instanceof Error ? error.message : String(error);
      return { items: [], health };
    }
  // A Worker holds at most six requests waiting for headers; more would queue and time out.
  }, 6, 2);
  const health = results.map((result) => result.health);
  const all = results.flatMap((result) => result.items);
  all.sort(compareSourceItems);
  const urls = new Set<string>();
  const items: SourceItem[] = [];
  for (const item of all) {
    const key = canonicalUrl(item.url);
    if (urls.has(key)) continue;
    urls.add(key);
    items.push(item);
  }
  return { collectedAt, items, shortlist: shortlistSourceItems(items), health, state, duplicateCount: all.length - items.length };
}
