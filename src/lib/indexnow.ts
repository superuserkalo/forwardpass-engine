import { isSignalId } from "./signals.js";

// Tells Bing (and through it ChatGPT search and Copilot), Yandex and the other IndexNow
// engines about new public pages the moment they publish. The key is public by design: the
// website serves it at /<key>.txt so the engines can confirm the site sent the ping.

const ENDPOINT = "https://api.indexnow.org/indexnow";

/** How long an engine has to answer. A ping is a courtesy, so it must never hold a run for as long as the network would. */
const PING_TIMEOUT_MS = 10_000;

export async function pingIndexNow(paths: string[], { timeoutMs = PING_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<{ status: number } | { skipped: string }> {
  const key = process.env.INDEXNOW_KEY;
  const site = process.env.PUBLIC_SITE_URL;
  if (!key || !site) return { skipped: "INDEXNOW_KEY or PUBLIC_SITE_URL is not set" };
  const base = new URL(site);
  const response = await fetch(ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: base.host,
      key,
      keyLocation: new URL(`/${key}.txt`, base).href,
      urlList: paths.map((path) => new URL(path, base).href),
    }),
  });
  // 200 and 202 both mean accepted; anything else is logged by the caller and never blocks publishing.
  if (response.status !== 200 && response.status !== 202) throw new Error(`IndexNow answered ${response.status}`);
  return { status: response.status };
}

export const issuePaths = (date: string, storySlugs: string[] = []) => [
  `/archive/daily/${date}`, `/archive/daily/${date}.md`, ...storySlugs.map((slug) => `/archive/daily/${date}/${slug}`), "/archive", "/feed.xml",
];
export const articlePaths = (slug: string) => [`/archive/editorial/${slug}`, `/archive/editorial/${slug}.md`, "/archive?section=editorial", "/feed.xml"];

/**
 * What a new signal changes: its own page, then the list and the feed it appears in. A signal has one page whatever its
 * headline says, so a correction that rewrites the headline never moves it. Anything that is not a signal id is left out,
 * and with no signal there is nothing to announce, not even the list.
 */
export function signalPaths(ids: string[]): string[] {
  const valid = [...new Set(ids.filter(isSignalId))];
  return valid.length ? [...valid.map((id) => `/signals/${id}`), "/signals", "/signals.xml"] : [];
}
