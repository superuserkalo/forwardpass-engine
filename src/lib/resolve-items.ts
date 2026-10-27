import { articleMeta } from "./article-meta.js";
import { fetchSameSite, type PageFetcher } from "./safe-fetch.js";

// Reads an article's own page for what its index did not say: a headline, a summary and above
// all when it was published. A page we cannot read or that is not an article says nothing, and
// the caller decides what that means for the item.

export type Resolution = { publishedAt: string | null; title: string | null; description: string | null };

const MAX_BYTES = 2_000_000;
const PAGE_TIMEOUT_MS = 10_000;
// Error pages, challenges and login walls that answer 200.
const NOT_AN_ARTICLE = /^(?:error|404|not found|page not found|access denied|just a moment|attention required|forbidden|sign in|log in)\b/i;

/**
 * The article's metadata, "skip" when the page is an error page or not an article, or null when
 * it could not be read (see fetchSameSite, or the index page served in its place).
 */
export async function resolveArticle(url: string, options: { fetcher?: PageFetcher; now: Date; indexBody: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<Resolution | "skip" | null> {
  const page = await fetchSameSite(url, { fetcher: options.fetcher, headers: options.headers, timeoutMs: options.timeoutMs ?? PAGE_TIMEOUT_MS, maxBytes: MAX_BYTES });
  // A broken link that lands on the index page would hand the index's own dates to an article.
  if (!page || page.body === options.indexBody) return null;
  const meta = articleMeta(page.body, page.url, options.now);
  if (meta.title && NOT_AN_ARTICLE.test(meta.title)) return "skip";
  return { publishedAt: meta.publishedAt, title: meta.title, description: meta.description };
}
