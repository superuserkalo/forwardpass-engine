import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";

// Some publishers block plain HTTP clients (403, bot challenges) or render their index in the
// browser. Every four hours those routes are re-read through Cloudflare Browser Rendering. One
// browser, one page at a time: ~60 routes take a few minutes, so six passes a day are about half
// an hour of browser time. They were twice a day, and a post on a blocked first-party page then
// waited up to twelve hours.

export const BROWSER_HOURS = new Set(["00", "04", "08", "12", "16", "20"]);
export const MAX_BROWSER_ROUTES = 60;
const BLOCKED = /HTTP 403|HTTP 401|HTTP 406|access challenge|No publication records|rendering/i;

export const needsBrowser = (status: string, error: string | undefined) => status === "failed" && !!error && BLOCKED.test(error);

/** A collector-compatible fetcher that loads each URL in a real browser and returns the raw body. */
export async function withBrowserFetcher<T>(binding: BrowserWorker, run: (fetcher: typeof fetch) => Promise<T>): Promise<T> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36");
    // The collector runs requests in parallel; one page means they take turns.
    let queue: Promise<unknown> = Promise.resolve();
    const fetcher: typeof fetch = (input) => {
      const next = queue.then(() => load(input));
      queue = next.catch(() => undefined);
      return next;
    };
    const load = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
      if (!response) return new Response("", { status: 502 });
      const type = response.headers()["content-type"] ?? "text/html";
      // Rendered HTML for pages built in the browser; the raw body for feeds and JSON.
      const body = /html/i.test(type) ? await page.content() : await response.text();
      return new Response(body, { status: response.status() === 304 ? 200 : response.status(), headers: { "content-type": type } });
    };
    return await run(fetcher);
  } finally {
    await browser.close();
  }
}
