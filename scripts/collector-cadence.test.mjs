import assert from "node:assert/strict";
import test from "node:test";
import { collectSourceStreams } from "../src/lib/source-collector.ts";

// Every route was effectively polled every 4 hours: the catalog said 4, and a 2-hour run that started a
// few seconds early counted its routes as "not due" (docs/route-miss-research-2026-10-03.md).

const rss = { id: "rss", publisher: "Lab", publisherId: "lab", section: "blog", category: "news", kind: "rss", url: "https://lab.test/rss.xml", intervalHours: 2 };
const body = `<rss><channel><item><guid>a</guid><title>New agent API</title><link>https://lab.test/a</link><pubDate>Thu, 24 Sep 2026 11:00:00 GMT</pubDate></item></channel></rss>`;
const state = (lastSucceededAt) => ({ version: 1, streams: { rss: { lastSucceededAt, seen: {} } } });
const poll = (lastSucceededAt, now) => collectSourceStreams(state(lastSucceededAt), { now: new Date(now), streams: [rss], fetcher: async () => new Response(body) });

test("a two-hour route is polled by the next two-hour run even when that run starts early", async () => {
  const result = await poll("2026-09-24T10:02:30.000Z", "2026-09-24T12:00:08.000Z");
  assert.equal(result.health[0].status, "ok");
});

test("a route is not polled again while its interval is clearly still running", async () => {
  const result = await poll("2026-09-24T11:00:00.000Z", "2026-09-24T12:00:00.000Z");
  assert.equal(result.health[0].status, "not-due");
});
