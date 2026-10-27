import { load } from "cheerio/slim";
import { canonicalSourceUrl, PAGE_HEADERS, requestPage } from "./source-evidence.js";

// The picture a story's own source publishes: its share image, a paper's teaser figure, a
// README screenshot. That is what AlphaSignal shows on every story, re-hosted, and it fits
// because it is the real thing. Generic platform cards and logos are skipped.

export type SourceImage = { bytes: Uint8Array; mediaType: string; sourceUrl: string; imageUrl: string; credit: string };

const MAX_BYTES = 4_000_000;
// GIFs on forums and READMEs are mostly reactions and screen recordings, so stills only.
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// Share cards that every page on a platform gets, so they say nothing about the story.
const GENERIC = [
  /opengraph\.githubassets\.com/,
  /github\.blog\/wp-content\/themes\//,
  /cdn-thumbnails\.huggingface\.co\/social-thumbnails/,
  /arxiv\.org\/static\//,
  /\/(?:logo|favicon|icon|avatar|default|placeholder|social-share|og-default)[\w.-]*\.(?:png|jpe?g|webp|gif)/i,
  /shields\.io|badge|gravatar|emoji/i,
  /\.svg(?:$|\?)/i,
];

const isGeneric = (url: string) => GENERIC.some((pattern) => pattern.test(url));

/** arXiv abstracts carry no figures; the HTML rendering of the paper does. */
function pageFor(url: string): string {
  const arxiv = /^https:\/\/arxiv\.org\/(?:abs|pdf)\/([\w.]+?)(?:v\d+)?(?:\.pdf)?\/?$/.exec(url);
  return arxiv ? `https://arxiv.org/html/${arxiv[1]}` : url;
}

const decode = (value: string) => load(`<i>${value}</i>`)("i").text();

/** Image URLs a page offers, best first: its declared share image, then images in the article body. */
export function imageCandidates(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const found: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    try {
      const url = new URL(decode(value.trim()), pageUrl);
      // Image CDNs that wrap the original (Astro, Next.js) pass it in a query parameter.
      const inner = url.searchParams.get("href") ?? (url.pathname.endsWith("/_next/image") ? url.searchParams.get("url") : null);
      const resolved = inner ? new URL(inner, pageUrl) : url;
      if (resolved.protocol === "https:" && !isGeneric(resolved.href) && !found.includes(resolved.href)) found.push(resolved.href);
    } catch { /* Not a URL. */ }
  };
  for (const name of ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]) {
    add($(`meta[property="${name}"]`).attr("content") ?? $(`meta[name="${name}"]`).attr("content"));
  }
  const container = [".markdown-body", ".ltx_page_main", "[itemprop='articleBody']", ".blog-content", ".prose", "article", "main"].map((selector) => $(selector).first()).find((element) => element.length > 0);
  (container ?? $("body")).find("img").each((_, element) => {
    const width = Number($(element).attr("width") ?? 0);
    if (width && width < 300) return;
    // GitHub proxies README images through camo and keeps the original in data-canonical-src.
    add($(element).attr("data-canonical-src") ?? $(element).attr("src") ?? $(element).attr("data-src"));
  });
  return found.slice(0, 8);
}

/** Width and height from the PNG, JPEG, GIF or WebP header, without decoding the image. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length > 24 && ascii(1, 3) === "PNG") return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && ascii(0, 3) === "GIF") return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      const length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/** Big enough for a 21:9 hero and not a tall infographic or a thin banner. */
export function usableSize(size: { width: number; height: number } | null): boolean {
  if (!size) return false;
  const ratio = size.width / size.height;
  return size.width >= 600 && size.height >= 300 && ratio >= 0.9 && ratio <= 3.2;
}

// Image URLs come from third-party pages, so every hop must be a public HTTPS host. Workers
// cannot reach private addresses at all; in Node this keeps redirects from reaching them.
function publicImageUrl(value: string): URL | null {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  if (/^(localhost|\[.*\]|\d+\.\d+\.\d+\.\d+)$/.test(host) || /\.(local|localhost|internal|lan|home|corp)$/.test(host) || !host.includes(".")) return null;
  return url;
}

async function download(value: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  let url = publicImageUrl(value);
  for (let hop = 0; url && hop <= 3; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": PAGE_HEADERS["User-Agent"], Accept: "image/webp,image/png,image/jpeg" },
      signal: AbortSignal.timeout(20_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      url = location ? publicImageUrl(new URL(location, url).href) : null;
      continue;
    }
    const mediaType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!response.ok || !TYPES.has(mediaType)) return null;
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= MAX_BYTES ? { bytes, mediaType } : null;
  }
  return null;
}

/** The first usable image from the story's sources, primary source first. */
export async function findSourceImage(urls: string[]): Promise<SourceImage | null> {
  for (const url of [...new Set(urls)].slice(0, 4)) {
    try {
      let page = pageFor(canonicalSourceUrl(url));
      let response = await requestPage(page);
      for (let hop = 0; hop < 3 && [301, 302, 303, 307, 308].includes(response.status) && response.location; hop++) {
        page = canonicalSourceUrl(new URL(response.location, page).href);
        response = await requestPage(page);
      }
      if (response.status < 200 || response.status >= 300 || !/html/i.test(response.contentType)) continue;
      for (const imageUrl of imageCandidates(response.body, page)) {
        const image = await download(imageUrl).catch(() => null);
        if (!image || !usableSize(imageSize(image.bytes))) continue;
        return { ...image, sourceUrl: url, imageUrl, credit: new URL(url).hostname.replace(/^www\./, "") };
      }
    } catch { /* Try the next source. */ }
  }
  return null;
}
