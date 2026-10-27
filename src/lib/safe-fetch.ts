import { bareHost, sameSite } from "./site-identity.js";
import { canonicalSourceUrl, isPublicHostName, PAGE_HEADERS, readCapped, requestPage, type PageResponse } from "./source-evidence.js";

// One place that reads a page named by untrusted input (an index page's link, a third party's
// article). It builds on the evidence loader: public HTTPS only, redirects handled here and never
// by the platform, and in Node every connection (each hop included) is checked against private
// and reserved addresses. On top of that a redirect may only stay with the same publisher (the same
// site, and on a shared platform the same tenant; see site-identity.ts), the body is read under a
// size cap, and the whole call, hops included, has one deadline.

export type PageFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** A public HTTPS URL without credentials or a custom port, on a public host name. */
function publicUrl(value: string, base?: URL): URL | null {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && isPublicHostName(url.hostname) ? new URL(canonicalSourceUrl(url.href)) : null;
  } catch { return null; }
}

/** The loader for a custom fetch (the browser pass, tests). Without one, the evidence loader is used. */
function viaFetcher(fetcher: PageFetcher, headers: Record<string, string>, maxBytes: number) {
  return async (url: string, signal?: AbortSignal): Promise<PageResponse> => {
    const response = await fetcher(url, { headers: { Accept: "text/html", ...headers }, signal, redirect: "manual" });
    const contentType = response.headers.get("content-type") ?? "";
    const location = response.headers.get("location") ?? undefined;
    if (response.status >= 300 || !response.ok) { await response.body?.cancel(); return { status: response.status, location, contentType, body: "" }; }
    return { status: response.status, location, contentType, body: await readCapped(response, maxBytes) };
  };
}

/**
 * The HTML body and final URL of a page, or null when it cannot be read: not a public HTTPS host, an
 * HTTP error, a redirect to another publisher or too many of them, a content type other than `contentType`
 * (HTML by default), too large, or past the deadline. `trustedHosts` are bare host names a redirect may also
 * land on, for a publisher that moved (docs.factory.ai became docs.factory.com); anything else is ignored.
 */
export async function fetchSameSite(url: string, options: { fetcher?: PageFetcher; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; maxRedirects?: number; contentType?: RegExp; trustedHosts?: string[] } = {}): Promise<{ url: string; body: string } | null> {
  const maxBytes = options.maxBytes ?? 2_000_000;
  const trusted = (options.trustedHosts ?? []).flatMap((host) => bareHost(host) ?? []);
  const load: (url: string, signal: AbortSignal, maxBytes: number) => Promise<PageResponse> = options.fetcher ? viaFetcher(options.fetcher, { "User-Agent": PAGE_HEADERS["User-Agent"], ...options.headers }, maxBytes) : requestPage;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline is enforced here as well as through the signal: a fetcher that ignores abort cannot hold the caller.
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
  const read = async (): Promise<{ url: string; body: string } | null> => {
    const first = publicUrl(url);
    if (!first) return null;
    let current: URL = first;
    for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
      // A fetcher that ignored the abort may answer after the deadline; no further request starts then.
      if (controller.signal.aborted) return null;
      const response = await load(current.href, controller.signal, maxBytes);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next: URL | null = response.location ? publicUrl(response.location, current) : null;
        // The gate is the same one that vouched for the first address, applied to where the redirect leads, before it is requested.
        if (!next || !(sameSite(first, next) || trusted.some((site) => sameSite(site, next)))) return null;
        current = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300 || !(options.contentType ?? /html/i).test(response.contentType || "text/html")) return null;
      return Buffer.byteLength(response.body) > maxBytes ? null : { url: current.href, body: response.body };
    }
    return null;
  };
  try { return await Promise.race([read().catch(() => null), deadline]); } finally { clearTimeout(timer); controller.abort(); }
}
