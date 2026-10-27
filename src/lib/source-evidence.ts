import { createHash } from "node:crypto";
import { load } from "cheerio/slim";
import { z } from "zod";
import { createPrivateJson, readPrivateJson } from "./private-store.js";
import { decodeBody } from "./body-text.js";
import { visibleText } from "./visible-text.js";

const passageSchema = z.object({ id: z.string(), text: z.string() });
export const documentSchema = z.object({
  id: z.string(), url: z.string(), resolvedUrl: z.string(), fetchedAt: z.string(),
  hash: z.string(), text: z.string(), passages: z.array(passageSchema),
  links: z.array(z.string()), truncated: z.boolean(),
});
export type SourceDocument = z.infer<typeof documentSchema>;

export const evidenceId = (value: string): string => createHash("sha256").update(value).digest("hex");

export function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Evidence requires a public HTTPS URL without credentials or a custom port.");
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  // Google serves the same page in every display language; hl= only picks the locale.
  if (/(^|\.)(google\.dev|google\.com|googleblog\.com|android\.com|withgoogle\.com)$/.test(url.hostname)) url.searchParams.delete("hl");
  url.searchParams.sort();
  return url.toString();
}

export type PageResponse = { status: number; location?: string; contentType: string; body: string };
export type PageLoader = (url: string) => Promise<PageResponse>;

// Cloudflare Workers cannot reach private or reserved addresses, so the platform fetch is
// safe there. Node callers pass publicPageLoader (src/node/public-fetch.ts), which checks DNS.
type Loader = (url: string, signal?: AbortSignal, maxBytes?: number) => Promise<PageResponse>;
let defaultLoader: Loader | null = null;

/** Node runs install the DNS-checked loader here; the Worker keeps the platform fetch. */
export function setDefaultPageLoader(loader: Loader | null): void {
  defaultLoader = loader;
}

// Names under these suffixes are internal by convention, not on the public internet.
const INTERNAL_SUFFIX = /\.(?:localhost|local|localdomain|internal|intranet|lan|corp|private|home\.arpa|onion)$/;

/**
 * Whether a URL's host name could be a public host: not an address literal (the URL parser has
 * already turned decimal, hex and short forms into dotted quads), not a bare label, not a
 * trailing-dot form such as "localhost.", and not under an internal-only suffix. Address ranges
 * behind a real name are checked at connection time by the Node loader.
 */
export function isPublicHostName(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host.endsWith(".") || !host.includes(".")) return false;
  if (/^\[.*\]$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return !INTERNAL_SUFFIX.test(host);
}

/** One page, one request: redirects are the caller's. `maxBytes` bounds the read itself (default 5 MB). */
export async function requestPage(value: string, signal?: AbortSignal, maxBytes = 5_000_000): Promise<PageResponse> {
  if (defaultLoader) return defaultLoader(value, signal, maxBytes);
  const url = new URL(canonicalSourceUrl(value));
  if (!isPublicHostName(url.hostname)) throw new Error("Evidence URL must use a public host name.");
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: PAGE_HEADERS,
  });
  return { status: response.status, location: response.headers.get("location") ?? undefined,
    contentType: response.headers.get("content-type") ?? "", body: await readCapped(response, maxBytes) };
}

export const PAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, application/json;q=0.6",
};

export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Source exceeds ${maxBytes / 1_000_000} MB capture limit`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return decodeBody(Buffer.concat(chunks), response.headers.get("content-type") ?? "");
}

export async function fetchSourceDocument(url: string, loader?: PageLoader, signal?: AbortSignal): Promise<SourceDocument> {
  const original = canonicalSourceUrl(url);
  let resolvedUrl = original;
  let response: PageResponse | undefined;
  for (let redirect = 0; redirect <= 5; redirect++) {
    response = await (loader ? loader(resolvedUrl) : requestPage(resolvedUrl, signal));
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (!response.location || redirect === 5) throw new Error("Source redirect limit or missing location");
    resolvedUrl = canonicalSourceUrl(new URL(response.location, resolvedUrl).toString());
  }
  if (!response || response.status < 200 || response.status >= 300) throw new Error(`Source HTTP ${response?.status}`);
  if (!/text\/|application\/(json|xml|xhtml)/i.test(response.contentType)) {
    throw new Error(`Unsupported source type: ${response.contentType}. A text/HTML primary page is needed.`);
  }
  let text = response.body;
  const links = new Set<string>();
  if (/html/i.test(response.contentType)) {
    const $ = load(text);
    const title = $("title").text();
    if (/access (?:denied|to this page)|just a moment|verify you are human|attention required/i.test(title)
      || $("#challenge-form, #cf-challenge-running, .cf-error-details").length) {
      throw new Error("Source returned an access challenge, not article evidence");
    }
    $("script,style,nav,footer,header,aside,noscript,svg,form").remove();
    let main: ReturnType<typeof $> = $("body");
    // Some community layouts use <article> for tiny recommendation cards while
    // the actual post lives in a separate article-body container.
    for (const selector of ["[itemprop='articleBody']", ".lia-message-body-content", "article", "main", "body"]) {
      const element = $(selector).toArray().sort((a, b) => $(b).text().trim().length - $(a).text().trim().length)[0];
      if (element && $(element).text().trim().length >= 200) { main = $(element); break; }
    }
    main.find("a[href]").each((_, element) => {
      try { links.add(canonicalSourceUrl(new URL($(element).attr("href") ?? "", resolvedUrl).toString())); } catch { /* Not a fetchable source. */ }
    });
    main.find("p,li,h1,h2,h3,h4,tr,pre,blockquote,section,div,br").each((_, element) => { $(element).append("\n\n"); });
    text = main.text();
  }
  text = visibleText(text).replace(/\r/g, "").split(/\n\s*\n/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");
  if (text.length < 80 || /^(?:access denied|just a moment|verify you are human)/i.test(text)) {
    throw new Error("Source did not contain readable article evidence");
  }
  const truncated = text.length > 160_000;
  text = text.slice(0, 160_000);
  const hash = evidenceId(text);
  const id = evidenceId(`${original}\n${hash}`);
  const passages: SourceDocument["passages"] = [];
  // Keep paragraph context, splitting exceptionally long paragraphs without losing text.
  for (const paragraph of text.split("\n\n")) {
    for (let start = 0; start < paragraph.length; start += 1800) {
      passages.push({ id: `${id}:${passages.length}`, text: paragraph.slice(start, start + 1800) });
    }
  }
  return { id, url: original, resolvedUrl, fetchedAt: new Date().toISOString(), hash, text, passages, links: [...links], truncated };
}

export async function readSourceDocument(id: string): Promise<SourceDocument> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid source snapshot ID");
  return documentSchema.parse(await readPrivateJson(`evidence/documents/${id}.json`));
}

// This is the only live article capture entry point for collection, research and
// verification. Successful snapshots are immutable and shared for the issue day.
export async function captureSourceDocument(date: string, value: string, loader?: PageLoader, signal?: AbortSignal): Promise<SourceDocument> {
  z.iso.date().parse(date);
  const url = canonicalSourceUrl(value);
  const key = `evidence/captures/v3/${date}/${evidenceId(url)}.json`;
  const saved = await readPrivateJson(key);
  if (saved !== null) return readSourceDocument(z.object({ documentId: z.string() }).parse(saved).documentId);
  const document = await fetchSourceDocument(url, loader, signal);
  await createPrivateJson(`evidence/documents/${document.id}.json`, document);
  // Concurrent fetches converge on the first stored snapshot; never return a
  // different revision from the one that verification will read later.
  await createPrivateJson(key, { documentId: document.id });
  const winner = z.object({ documentId: z.string() }).parse(await readPrivateJson(key));
  return readSourceDocument(winner.documentId);
}
