import assert from "node:assert/strict";
import test from "node:test";
import { collectBeforeIssue, collectSources } from "../src/collect/collect.ts";
import { createPrivateJson, memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";

// The collection runs its eight shards at once in one Worker, which has 128 MB for all of them. The collector's state grows with every
// route and every item it has seen (8 MB of JSON in production by 8 October), so a shard that reads the whole of it holds a copy of its
// own: eight copies were about 100 MB before a single page was fetched, and on 8 October every collection and the day's issue ran out of
// memory. A shard now reads only the part of the state that is its own.
const NOW = "2026-10-08T06:00:00.000Z";
const WORK = "collection/work/2026-10-08/06";
const rss = (n) => ({ id: `s${n}`, publisher: `Publisher ${n}`, publisherId: `p${n}`, section: "blog", category: "primary announcement", kind: "rss", url: `https://feed${n}.test/rss.xml` });
const streams = Array.from({ length: 20 }, (_, n) => rss(n));
const body = (n) => `<rss><channel><item><guid>g${n}</guid><title>Item ${n} ships a new agent API</title><link>https://feed${n}.test/post-${n}</link><pubDate>Thu, 08 Oct 2026 05:00:00 GMT</pubDate></item></channel></rss>`;

function steps(names = []) {
  return { run: async (name, config, callback) => { names.push(name); return JSON.parse(JSON.stringify(await callback())); }, sleep: async () => {} };
}

async function run(extra = {}) {
  const base = memoryStore();
  const reads = [];
  useStore({ ...base, get: async (key) => { reads.push(key); return base.get(key); } });
  // What the previous runs left: state for most streams, and for one that has since left the catalog.
  const state = { version: 1, streams: { ...Object.fromEntries(streams.slice(0, 15).map((s, n) => [s.id, { lastSucceededAt: "2026-10-08T04:00:00.000Z", etag: `"e${n}"`, seen: { [`${s.id}:old`]: "2026-10-07T10:00:00.000Z" } }])), retired: { lastSucceededAt: "2026-10-01T04:00:00.000Z", seen: { "retired:x": "2026-10-01T04:00:00.000Z" } } } };
  await createPrivateJson("collection/state.json", state);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { const n = /feed(\d+)\.test/.exec(String(url))?.[1]; return n ? new Response(body(Number(n)), { status: 200, headers: { etag: `"new${n}"` } }) : new Response("", { status: 404 }); };
  const names = [];
  try {
    const result = await collectSources(steps(names), { now: NOW }, { streams, ...extra });
    return { result, names, reads, state };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the state is read once, to be cut into the shards' parts, and by no shard and not again to commit", async () => {
  const { names, reads } = await run();
  assert.ok(names.includes("state"), "a step of its own cuts the state into the shards' parts");
  assert.ok(names.indexOf("state") < names.indexOf("sources-0"), "before any shard starts");
  assert.equal(reads.filter((key) => key === "collection/state.json").length, 1, "once: the commit is built from the parts the shards hand back, not from the whole of the old state beside them");
});

test("the streams that have left the catalog are set aside when the state is cut, and come back with the rest when it is committed", async () => {
  await run();
  const aside = await readPrivateJson(`${WORK}/state-retired.json`);
  assert.deepEqual(Object.keys(aside.streams), ["retired"]);
  assert.equal(aside.streams.retired.seen["retired:x"], "2026-10-01T04:00:00.000Z");
  const committed = await readPrivateJson("collection/state.json");
  assert.deepEqual(committed.streams.retired, aside.streams.retired);
});

test("each shard is given the part of the state that is its own, and only that", async () => {
  await run();
  const parts = await Promise.all(Array.from({ length: 8 }, async (_, shard) => readPrivateJson(`${WORK}/state-${shard}.json`)));
  for (const [shard, part] of parts.entries()) {
    assert.equal(part.version, 1);
    const expected = streams.filter((_, i) => i % 8 === shard).map((s) => s.id).filter((id) => Number(id.slice(1)) < 15);
    assert.deepEqual(Object.keys(part.streams).sort(), expected.sort(), `shard ${shard} has its own streams that have a state`);
  }
  assert.equal(parts.some((part) => "retired" in part.streams), false, "a stream that is not in the catalog is in no shard's part");
});

test("what the shards learn is committed with everything the state already held", async () => {
  const { result } = await run();
  const state = await readPrivateJson("collection/state.json");
  assert.equal(Object.keys(state.streams).length, 21, "twenty streams, and the one that left the catalog, which is kept");
  assert.ok(state.streams.retired, "a stream that left the catalog keeps its state");
  assert.equal(state.streams.s3.etag, '"new3"', "a stream that answered has what it answered with");
  assert.ok(state.streams.s17.lastSucceededAt, "a stream with no state before has one now");
  assert.deepEqual(state.streams.s0.seen["s0:old"], "2026-10-07T10:00:00.000Z", "and keeps what it had seen");
  assert.equal(result.routes, 20);
  assert.equal(result.items, 20, "the item each of them published");
});

test("the shards run two at a time, not all at once, since what a shard holds while it runs is most of the memory the collection uses", async () => {
  useStore(memoryStore());
  await createPrivateJson("collection/state.json", { version: 1, streams: {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { await new Promise((resolve) => setTimeout(resolve, 5)); const n = /feed(\d+)\.test/.exec(String(url))?.[1]; return n ? new Response(body(Number(n)), { status: 200 }) : new Response("", { status: 404 }); };
  const order = [];
  let active = 0, peak = 0;
  const counting = { run: async (name, config, callback) => {
    if (!name.startsWith("sources-")) return JSON.parse(JSON.stringify(await callback()));
    order.push(name); active++; peak = Math.max(peak, active);
    try { return JSON.parse(JSON.stringify(await callback())); } finally { active--; }
  }, sleep: async () => {} };
  try {
    const result = await collectSources(counting, { now: NOW }, { streams });
    assert.equal(peak, 2, "two at once, never more");
    assert.deepEqual(order, ["sources-0", "sources-1", "sources-2", "sources-3", "sources-4", "sources-5", "sources-6", "sources-7"], "all eight, in order");
    assert.equal(result.routes, 20, "and every route was read");
    assert.equal(result.items, 20);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a stored state that is not one is refused at its edges, and what is inside it is passed through untouched", async () => {
  for (const bad of [{ version: 2, streams: {} }, { version: 1 }, { version: 1, streams: [] }, "text"]) {
    useStore(memoryStore());
    await createPrivateJson("collection/state.json", bad);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(body(0), { status: 200 });
    try {
      await assert.rejects(collectSources(steps(), { now: NOW }, { streams: streams.slice(0, 2) }), undefined, JSON.stringify(bad));
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  // A stream that left the catalog keeps whatever it had, in whatever shape it had it, since it is only read to be written back.
  useStore(memoryStore());
  const odd = { lastSucceededAt: "2026-10-01T04:00:00.000Z", seen: { "gone:x": "2026-10-01T04:00:00.000Z" }, note: "kept as it was" };
  await createPrivateJson("collection/state.json", { version: 1, streams: { gone: odd } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { const n = /feed(\d+)\.test/.exec(String(url))?.[1]; return n ? new Response(body(Number(n)), { status: 200 }) : new Response("", { status: 404 }); };
  try {
    await collectSources(steps(), { now: NOW }, { streams: streams.slice(0, 2) });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual((await readPrivateJson("collection/state.json")).streams.gone, odd);
});

test("what a browser pass recovered is merged at the commit: its state, its row in place of the failed one, and its items after the rest", async () => {
  // What an item looks like is learned from a run in a store of its own.
  const first = await run();
  const shape = (await readPrivateJson("collection/runs/2026-10-08/06.json")).items[0];
  useStore(memoryStore());
  await createPrivateJson("collection/state.json", { version: 1, streams: { retired: { lastSucceededAt: "2026-10-01T04:00:00.000Z", seen: {} } } });
  const row = { streamId: "s2", section: "blog", status: "ok", itemCount: 1, newCount: 1, invalidCount: 0, bytes: 10, backfillLimited: false, possiblyTruncated: false, via: "browser" };
  await createPrivateJson(`${WORK}/browser.json`, { items: [{ ...shape, url: "https://feed2.test/browser-post", title: "Item found only through the browser" }], health: [row, { ...row, streamId: "s3", status: "failed", itemCount: 0, newCount: 0 }], streams: { s2: { lastSucceededAt: NOW, etag: '"from-browser"', seen: { "s2:browser": NOW } } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { const n = /feed(\d+)\.test/.exec(String(url))?.[1]; return n && n !== "2" && n !== "3" ? new Response(body(Number(n)), { status: 200 }) : new Response("", { status: 403 }); };
  try {
    await collectSources(steps(), { now: NOW }, { streams });
  } finally {
    globalThis.fetch = realFetch;
  }
  const snapshot = await readPrivateJson("collection/runs/2026-10-08/06.json");
  const s2 = snapshot.health.filter((h) => h.streamId === "s2");
  assert.deepEqual(s2.map((h) => [h.status, h.via]), [["ok", "browser"]], "the failed row is replaced by the one the browser recovered, once");
  const s3 = snapshot.health.filter((h) => h.streamId === "s3");
  assert.deepEqual(s3.map((h) => [h.status, h.via]), [["failed", undefined]], "and a route the browser could not read keeps the row it had");
  assert.equal(snapshot.items.at(-1).title, "Item found only through the browser", "its items follow the shards' and the trending ones");
  assert.equal(snapshot.items.filter((item) => item.url === "https://feed2.test/browser-post").length, 1);
  const state = await readPrivateJson("collection/state.json");
  assert.equal(state.streams.s2.etag, '"from-browser"');
  assert.ok(state.streams.retired, "and the stream that left the catalog is still there");
  assert.equal(first.result.items, 20);
});

test("a shard whose part of the state is missing fails, and does not read its streams as new", async () => {
  const base = memoryStore();
  useStore(base);
  await createPrivateJson("collection/state.json", { version: 1, streams: { s0: { lastSucceededAt: "2026-10-08T04:00:00.000Z", seen: { "s0:old": "2026-10-07T10:00:00.000Z" } } } });
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return new Response(body(0), { status: 200 }); };
  const skipping = { run: async (name, config, callback) => name === "state" ? true : JSON.parse(JSON.stringify(await callback())), sleep: async () => {} };
  try {
    await assert.rejects(collectSources(skipping, { now: NOW }, { streams }), /state for shard \d is missing/);
    assert.equal(fetched, 0, "nothing was fetched, so nothing could be announced as new");
    assert.equal(await readPrivateJson(`${WORK}/sources-0.json`), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the issue goes ahead with the snapshots it has when the fresh collection fails, and says why", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const failed = await collectBeforeIssue(async () => { throw new Error("Worker exceeded memory limit."); });
    assert.deepEqual(failed, { collection: null, failure: "Worker exceeded memory limit." });
    assert.match(logged.join("\n"), /forwardpass\.issue_collection_failed.*Worker exceeded memory limit/);
    const fine = await collectBeforeIssue(async () => ({ snapshot: "collection/runs/2026-10-08/05.json", items: 3, routes: 9, failed: 0, trending: 1, attention: [] }));
    assert.deepEqual([fine.failure, fine.collection.items], [null, 3]);
    assert.equal((await collectBeforeIssue(async () => { throw "not an error object"; })).failure, "not an error object");
    assert.equal((await collectBeforeIssue(async () => { throw new Error("x".repeat(1000)); })).failure.length, 300, "what is kept of a long message is bounded");
  } finally {
    console.error = original;
  }
});
