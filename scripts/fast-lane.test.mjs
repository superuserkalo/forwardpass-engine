import assert from "node:assert/strict";
import test from "node:test";
import { memoryStore, readPrivateJson, listPrivateJsonKeys, useStore } from "../src/lib/private-store.ts";
import { candidateSchema } from "../src/lib/schemas.ts";
import { localSignalService } from "../src/lib/signal-service.ts";
import { FAST_STATE_KEY, collectFast, isFastStream } from "../src/collect/fast.ts";
import { nextCandidates } from "../src/pipeline/signal-candidates.ts";
import { newStore } from "./signals-test-support.mjs";

// The main lane polls everything every two hours. The fast lane polls the tier-1 feeds every fifteen minutes, with the
// same collector, its own state, and snapshots the main lane's readers pick up.
const NOW = "2026-10-03T10:15:00.000Z";
const stream = (id, url, extra = {}) => ({ id, publisher: "Lab", publisherId: "lab", section: "news", category: "primary announcement", kind: "rss", url, ...extra });
const OPENAI = stream("openai-news", "https://openai.com/news/rss.xml", { intervalHours: 24 });
const ANTHROPIC = stream("anthropic-feed", "https://www.anthropic.com/news/rss.xml", { intervalHours: 12 });
const rss = (items) => `<rss><channel>${items.map(([guid, title, link, date]) => `<item><guid>${guid}</guid><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate></item>`).join("")}</channel></rss>`;
const FEEDS = {
  "https://openai.com/news/rss.xml": rss([["o1", "OpenAI launches a new agent platform for building production agents", "https://openai.com/index/agent-platform/", "Sat, 03 Oct 2026 10:05:00 GMT"]]),
  "https://www.anthropic.com/news/rss.xml": rss([["a1", "Anthropic releases a model with a longer context window for engineers", "https://www.anthropic.com/news/long-context/", "Sat, 03 Oct 2026 09:58:00 GMT"]]),
};
const etag = (url) => `"v-${url.length}"`;
function fetcher(feeds = FEEDS, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), conditional: init.headers?.["If-None-Match"] ?? null });
    const body = feeds[String(url)];
    if (body === undefined) return new Response("missing", { status: 404 });
    if (body === "boom") return new Response("error", { status: 500 });
    if (init.headers?.["If-None-Match"] === etag(String(url))) return new Response(null, { status: 304 });
    return new Response(body, { status: 200, headers: { etag: etag(String(url)), "content-type": "application/rss+xml" } });
  };
}
const steps = () => ({ run: async (name, config, callback) => JSON.parse(JSON.stringify(await callback())), sleep: async () => {} });
const fast = (options = {}, job = {}) => collectFast(steps(), { now: NOW, ...job }, { streams: [OPENAI, ANTHROPIC], fetcher: fetcher(), ...options });

test("a stream is fast when it is public, a feed kind, and a tier-1 publisher's", () => {
  assert.equal(isFastStream(OPENAI), true);
  assert.equal(isFastStream(stream("a", "https://www.anthropic.com/news/atom.xml", { kind: "atom" })), true);
  assert.equal(isFastStream(stream("g", "https://api.github.com/repos/openai/openai-python/releases?per_page=100", { kind: "github-releases" })), true, "a releases API is judged by the repository's organisation");
  assert.equal(isFastStream(stream("j", "https://openai.com/index.json", { kind: "json-index" })), true);
  assert.equal(isFastStream(stream("s", "https://www.anthropic.com/sitemap.xml", { kind: "sitemap" })), true);
  assert.equal(isFastStream(stream("b", "https://blog.example.com/feed.xml")), false, "not a tier-1 publisher");
  assert.equal(isFastStream(stream("g2", "https://api.github.com/repos/someone/some-repo/releases?per_page=100", { kind: "github-releases" })), false, "nor is a stranger's repository");
  assert.equal(isFastStream(stream("h", "https://www.anthropic.com/news", { kind: "html-news" })), false, "a page needs its articles read; the main lane does that");
  assert.equal(isFastStream(stream("p", "https://openai.com/private.xml", { access: "permission-required" })), false);
  assert.equal(isFastStream(stream("r", "https://openai.com/ref.xml", { access: "reference" })), false);
  assert.equal(isFastStream(stream("n", "https://news.ycombinator.com/rss", { kind: "hn-list" })), false);
});

test("every fast stream is polled whatever its interval, and nothing else is", async () => {
  useStore(memoryStore({ [FAST_STATE_KEY]: { version: 1, streams: { "openai-news": { lastSucceededAt: "2026-10-03T10:14:00.000Z", seen: {} } } } }));
  const calls = [];
  await fast({ streams: [OPENAI, ANTHROPIC, stream("outsider", "https://blog.example.com/feed.xml"), stream("page", "https://www.anthropic.com/news", { kind: "html-news" })], fetcher: fetcher(FEEDS, calls) });
  assert.deepEqual(calls.map(({ url }) => url).sort(), ["https://openai.com/news/rss.xml", "https://www.anthropic.com/news/rss.xml"], "the 24-hour feed polled a minute after its last success is still read");
});

test("what is new is written as a snapshot of its own, in the shape the readers already take, and becomes a candidate", async () => {
  useStore(memoryStore({}));
  const result = await fast();
  assert.deepEqual([result.snapshot, result.items, result.routes, result.failed], ["collection/fast/2026-10-03/1015.json", 2, 2, 0]);
  const snapshot = await readPrivateJson(result.snapshot);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.collectedAt, NOW);
  assert.deepEqual(snapshot.attention, { measurements: [], candidates: [], health: [] }, "no attention measurements: the main lane adds those");
  for (const item of snapshot.items) assert.doesNotThrow(() => candidateSchema.parse(item));
  assert.deepEqual(snapshot.items.map((item) => item.url).sort(), ["https://openai.com/index/agent-platform/", "https://www.anthropic.com/news/long-context/"]);
  const candidates = (await nextCandidates(localSignalService(newStore()), new Date("2026-10-03T10:20:00Z"))).candidates;
  assert.deepEqual(candidates.map(({ cluster }) => cluster.lead.url).sort(), ["https://openai.com/index/agent-platform/", "https://www.anthropic.com/news/long-context/"], "a signal run a few minutes later finds them");
});

test("its state is its own: the main lane's is never written, and the first run starts from what the main lane has seen", async () => {
  const main = { version: 1, streams: { "openai-news": { seen: { "openai-news:o1": "2026-10-03T10:05:00.000Z" }, lastSucceededAt: "2026-10-03T08:00:00.000Z" }, sentinel: { seen: {} } } };
  useStore(memoryStore({ "collection/state.json": main }));
  const before = JSON.stringify(await readPrivateJson("collection/state.json"));
  const result = await fast();
  assert.equal(JSON.stringify(await readPrivateJson("collection/state.json")), before, "collection/state.json is untouched");
  const own = await readPrivateJson(FAST_STATE_KEY);
  assert.deepEqual(Object.keys(own.streams).sort(), ["anthropic-feed", "openai-news"], "only the streams it polls");
  assert.equal(result.items, 1, "the item the main lane already saw is not emitted again, the other is");
  assert.ok(own.streams["openai-news"].etag, "and the conditional-request validators are kept");
});

test("a poll that finds nothing new writes no snapshot but keeps its state, and the next poll is conditional", async () => {
  useStore(memoryStore({}));
  await fast();
  const calls = [];
  const quiet = await fast({ fetcher: fetcher(FEEDS, calls) }, { now: "2026-10-03T10:30:00.000Z" });
  assert.deepEqual([quiet.snapshot, quiet.items], [null, 0], "nothing new, nothing written");
  assert.deepEqual((await listPrivateJsonKeys("collection/fast/")).sort(), ["collection/fast/2026-10-03/1015.json"]);
  assert.ok(calls.every(({ conditional }) => conditional !== null), "each stream asked whether it had changed, and was told it had not");
  assert.equal((await readPrivateJson(FAST_STATE_KEY)).streams["openai-news"].lastSucceededAt, "2026-10-03T10:30:00.000Z", "the state moved on");
});

test("a second call in the same minute is a no-op", async () => {
  useStore(memoryStore({}));
  await fast();
  const calls = [];
  const again = await fast({ fetcher: fetcher(FEEDS, calls) });
  assert.equal(calls.length, 0, "nothing was fetched");
  assert.deepEqual([again.snapshot, again.items], ["collection/fast/2026-10-03/1015.json", 0]);
});

test("a failing stream is reported and does not stop the others; the snapshot lists only routes that failed or returned something new", async () => {
  // A third route that answered "unchanged" last time and is asked again with its validator.
  const QUIET = stream("quiet", "https://openai.com/quiet.xml");
  useStore(memoryStore({ [FAST_STATE_KEY]: { version: 1, streams: { quiet: { etag: etag(QUIET.url), lastSucceededAt: "2026-10-03T10:00:00.000Z", seen: {} } } } }));
  const result = await fast({ streams: [OPENAI, ANTHROPIC, QUIET, stream("broken", "https://openai.com/broken.xml")], fetcher: fetcher({ ...FEEDS, [QUIET.url]: rss([]), "https://openai.com/broken.xml": "boom" }) });
  assert.deepEqual([result.items, result.failed, result.routes], [2, 1, 4]);
  const health = (await readPrivateJson(result.snapshot)).health;
  assert.deepEqual(health.map((row) => [row.streamId, row.status]).sort(), [["anthropic-feed", "ok"], ["broken", "failed"], ["openai-news", "ok"]], "the route that was unchanged is not listed");
  // The next quiet poll lists nothing at all rather than every route that said "unchanged".
  const quiet = await fast({ streams: [OPENAI, ANTHROPIC], fetcher: fetcher() }, { now: "2026-10-03T10:30:00.000Z" });
  assert.equal(quiet.snapshot, null);
});

test("an entry both feeds carry is one item, and the work files are cleared when the snapshot is written", async () => {
  useStore(memoryStore({}));
  const twin = stream("openai-twin", "https://openai.com/news/atom.xml");
  const result = await fast({ streams: [OPENAI, twin], fetcher: fetcher({ "https://openai.com/news/rss.xml": FEEDS["https://openai.com/news/rss.xml"], "https://openai.com/news/atom.xml": FEEDS["https://openai.com/news/rss.xml"] }) });
  assert.equal(result.items, 1);
  assert.deepEqual(await listPrivateJsonKeys("collection/fast-work/"), []);
});
