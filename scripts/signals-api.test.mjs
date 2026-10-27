import assert from "node:assert/strict";
import test from "node:test";
import { localSignalService } from "../src/lib/signal-service.ts";
import { signalId } from "../src/lib/signals.ts";
import { handleSignalsRequest } from "../src/api/signals.ts";
import { handleReaderRequest } from "../src/api/reader.ts";
import { newStore, record } from "./signals-test-support.mjs";

// The public face of the signal corpus: free, cacheable, and labelled as AI-generated on every response.
const NOW = new Date("2026-10-03T12:00:00.000Z");
const get = (url, service, init = {}) => handleSignalsRequest(new Request(`https://api.test${url}`, init), new URL(`https://api.test${url}`).pathname, service, { now: () => NOW });
const json = async (response) => JSON.parse(await response.text());

async function seeded() {
  const service = localSignalService(newStore());
  const rows = [
    ["https://lab.test/model", { type: "models", topics: ["Retrieval"], importance: 8, headline: "Cohere ships Embed 5 with 85.8 on ViDoRe V3", publishedAt: "2026-10-03T10:20:00.000Z" }],
    ["https://lab.test/repo", { type: "repos", topics: ["Agents", "Open source"], importance: 5, headline: "Acme releases an agent memory library", publishedAt: "2026-10-03T11:00:00.000Z" }],
    ["https://lab.test/paper", { type: "papers", topics: ["Reasoning"], importance: 6, headline: "A paper on reasoning accuracy", publishedAt: "2026-10-03T11:30:00.000Z" }],
    ["https://lab.test/old", { type: "news", topics: ["Agents"], importance: 7, headline: "Lab announces an older agent result", publishedAt: "2026-09-10T09:00:00.000Z", sourcePublishedAt: "2026-09-10T08:00:00.000Z" }],
  ];
  for (const [url, extra] of rows) await service.publish(record(url, extra));
  return service;
}
const every = (response, label) => assert.equal(response.headers.get("X-AI-Generated"), "true", `${label}: every response is labelled`);

test("the list returns summaries, newest first, without facts, cacheable and labelled", async () => {
  const response = await get("/signals", await seeded());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, s-maxage=60");
  assert.match(response.headers.get("Content-Type"), /application\/json/);
  every(response, "list");
  const body = await json(response);
  assert.deepEqual(body.signals.map((signal) => signal.type), ["papers", "repos", "models", "news"]);
  assert.equal(body.next, null);
  for (const signal of body.signals) {
    assert.equal("facts" in signal, false, "summaries carry no facts");
    assert.deepEqual(Object.keys(signal).sort(), ["evidenceCount", "headline", "id", "importance", "publishedAt", "publisher", "sourcePublishedAt", "status", "summary", "topics", "traction", "type", "url"]);
  }
});

test("limit, cursor, filters and search are honoured, and a malformed one is a 400 that never reaches the service", async () => {
  const service = await seeded();
  const ids = async (query) => (await json(await get(`/signals${query}`, service))).signals.map((signal) => signal.type);
  assert.deepEqual(await ids("?limit=1"), ["papers"]);
  assert.equal((await ids("?limit=0")).length, 1, "a limit below one is one");
  assert.equal((await ids("?limit=5000")).length, 4, "and above fifty is fifty");
  assert.equal((await ids("?limit=abc")).length, 4, "and not a number is the default");
  const page = await json(await get("/signals?limit=2", service));
  assert.equal(page.signals.length, 2);
  assert.ok(page.next);
  assert.deepEqual((await json(await get(`/signals?limit=2&before=${encodeURIComponent(page.next)}`, service))).signals.map((signal) => signal.type), ["models", "news"]);
  assert.deepEqual(await ids("?type=repos"), ["repos"]);
  assert.deepEqual(await ids("?topic=Open%20source"), ["repos"]);
  assert.deepEqual(await ids("?min_importance=7"), ["models", "news"]);
  assert.deepEqual(await ids("?since=2026-10-03T11:15:00Z"), ["papers"]);
  assert.deepEqual(await ids("?q=MEMORY"), ["repos"]);

  const touched = [];
  const spy = Object.fromEntries(Object.entries(service).map(([name, method]) => [name, async (...args) => { touched.push(name); return method(...args); }]));
  for (const query of ["?before=not-a-cursor", "?type=gossip", "?topic=Astrology", "?min_importance=lots", "?min_importance=11", "?since=yesterday"]) {
    const response = await get(`/signals${query}`, spy);
    assert.equal(response.status, 400, query);
    every(response, query);
    assert.equal(response.headers.get("Cache-Control"), "no-store", "an error is not cached");
    assert.ok((await json(response)).error, "and says why");
  }
  assert.deepEqual(touched, [], "none of them reached the service");
});

test("what the handler asks the service for is bounded by the handler, not left to the store", async () => {
  const service = await seeded();
  const asked = { list: [], corrections: [] };
  const spy = { ...service, list: async (query) => { asked.list.push(query); return service.list(query); }, corrections: async (limit) => { asked.corrections.push(limit); return service.corrections(limit); } };
  for (const limit of ["5000", "51", "50", "0", "-3", "abc", "", "2.9"]) await get(`/signals?limit=${limit}`, spy);
  assert.deepEqual(asked.list.map((query) => query.limit), [50, 50, 50, 1, 1, 20, 20, 2], "no more than fifty, whatever the store would allow");
  for (const limit of ["99999", "201", "200", "0", "abc"]) await get(`/corrections?limit=${limit}`, spy);
  assert.deepEqual(asked.corrections, [200, 200, 200, 1, 50], "and no more than two hundred corrections");
  asked.list.length = 0;
  await get("/signals?q=%20%20&type=models&topic=Retrieval&min_importance=3&since=2026-10-03T00:00:00Z", spy);
  assert.deepEqual(asked.list[0], { limit: 20, type: "models", topic: "Retrieval", minImportance: 3, since: "2026-10-03T00:00:00.000Z" }, "a blank search is no search, and the time is normalised");
  await get(`/signals?q=${"x".repeat(500)}`, spy);
  assert.equal(asked.list[1].q.length, 100, "a search is cut at a hundred characters");
});

test("one signal is returned in full with its quotes, sources, evidence and corrections", async () => {
  const service = await seeded();
  const id = signalId("https://lab.test/model");
  await service.correct(id, "correction", "The score was misread.", "2026-10-03T11:00:00.000Z", { summary: "Embed 5 is in preview." });
  const response = await get(`/signals/${id}`, service);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, s-maxage=60");
  every(response, "one");
  const body = await json(response);
  assert.equal(body.id, id);
  assert.equal(body.summary, "Embed 5 is in preview.");
  assert.equal(body.status, "corrected");
  assert.ok(body.facts.every((fact) => fact.fact && fact.quote), "facts with their quotes");
  assert.ok(body.sources.length && body.evidence.basis);
  assert.deepEqual(body.corrections.map(({ kind, note }) => [kind, note]), [["correction", "The score was misread."]]);
  assert.equal("signalId" in body.corrections[0], false, "the log entries are this signal's, so they need not say so");
});

test("an unknown id is a 404, a malformed one is a 404 that never reaches the service, and a retracted one is a 410 with the reason", async () => {
  const service = await seeded();
  assert.equal((await get("/signals/g-0000000000000000", service)).status, 404);
  const touched = [];
  const spy = Object.fromEntries(Object.entries(service).map(([name, method]) => [name, async (...args) => { touched.push(name); return method(...args); }]));
  for (const bad of ["/signals/nothing", "/signals/g-123", "/signals/G-0000000000000000", "/signals/g-0000000000000000/extra", "/signals/stats/x"]) {
    const response = await get(bad, spy);
    assert.equal(response.status, 404, bad);
    every(response, bad);
  }
  assert.deepEqual(touched, []);
  const id = signalId("https://lab.test/paper");
  await service.correct(id, "retraction", "The source withdrew the paper.", "2026-10-03T11:45:00.000Z");
  const gone = await get(`/signals/${id}`, service);
  assert.equal(gone.status, 410);
  every(gone, "retracted");
  assert.deepEqual(await json(gone), { id, status: "retracted", note: "The source withdrew the paper.", retractedAt: "2026-10-03T11:45:00.000Z" });
  assert.ok(!(await json(await get("/signals", service))).signals.some((signal) => signal.id === id), "and it is gone from the list");
});

test("stats give the scorecard's numbers for the last seven and thirty days", async () => {
  const response = await get("/signals/stats", await seeded());
  assert.equal(response.status, 200);
  every(response, "stats");
  const body = await json(response);
  assert.deepEqual(Object.keys(body).sort(), ["last30days", "last7days"]);
  assert.deepEqual([body.last7days.published, body.last30days.published], [3, 4]);
  assert.equal(body.last7days.medianLatencyMinutes, 80, "published 40, 80 and 110 minutes after the source's own 09:40");
  assert.equal(body.last7days.pageVerifiedShare, 1);
  assert.equal(body.last7days.corrections, 0);
});

test("the corrections log is public, newest first, and its limit is clamped", async () => {
  const service = await seeded();
  await service.correct(signalId("https://lab.test/model"), "correction", "First fix.", "2026-10-03T11:00:00.000Z", { summary: "Embed 5 is in preview." });
  await service.correct(signalId("https://lab.test/repo"), "retraction", "Second, a retraction.", "2026-10-03T11:10:00.000Z");
  const response = await get("/corrections", service);
  assert.equal(response.status, 200);
  every(response, "corrections");
  assert.equal(response.headers.get("Cache-Control"), "public, s-maxage=60");
  const body = await json(response);
  assert.deepEqual(body.corrections.map(({ note }) => note), ["Second, a retraction.", "First fix."]);
  assert.equal((await json(await get("/corrections?limit=1", service))).corrections.length, 1);
  assert.equal((await json(await get("/corrections?limit=99999", service))).corrections.length, 2);
});

test("only reading is allowed, HEAD answers with the headers alone, and other paths are not this handler's", async () => {
  const service = await seeded();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await get("/signals", service, { method, body: method === "DELETE" ? undefined : "{}" });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
    every(response, method);
  }
  const head = await get("/signals", service, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("X-AI-Generated"), "true");
  for (const other of ["/", "/feed", "/signalsfoo", "/correctionsx", "/archive"]) assert.equal(await get(other, service), null, other);
});

test("a service that fails is a 503, labelled, and the reader API passes signals paths to the handler", async () => {
  const broken = new Proxy({}, { get: () => async () => { throw new Error("storage unavailable"); } });
  const down = await get("/signals", broken);
  assert.equal(down.status, 503);
  every(down, "503");
  assert.equal(down.headers.get("Cache-Control"), "no-store");
  assert.ok(!/storage unavailable/.test(await down.text()), "the reason stays in the log");
  const service = await seeded();
  const viaReader = await handleReaderRequest(new Request("https://api.test/signals?limit=1"), "/signals", service);
  assert.equal(viaReader.status, 200);
  assert.equal((await json(viaReader)).signals.length, 1);
  assert.equal((await handleReaderRequest(new Request("https://api.test/signals"), "/signals")).status, 404, "without a service the reader API is as it was");
});
