import assert from "node:assert/strict";
import test from "node:test";
import { pingIndexNow, signalPaths } from "../src/lib/indexnow.ts";
import { signalId } from "../src/lib/signals.ts";

// The engines are told about a page the moment it exists, and an engine that is slow or down must never hold anything up.
const A = signalId("https://lab.test/a");
const B = signalId("https://lab.test/b");

async function withNetwork(env, fetchStub, body) {
  const saved = { fetch: globalThis.fetch, key: process.env.INDEXNOW_KEY, site: process.env.PUBLIC_SITE_URL };
  for (const [name, value] of [["INDEXNOW_KEY", env.key], ["PUBLIC_SITE_URL", env.site]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  globalThis.fetch = fetchStub;
  try { return await body(); } finally {
    globalThis.fetch = saved.fetch;
    for (const [name, value] of [["INDEXNOW_KEY", saved.key], ["PUBLIC_SITE_URL", saved.site]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

test("a signal's pages are its own page, then the list and the feed, and an id that is not one names nothing", () => {
  assert.deepEqual(signalPaths([A, B]), [`/signals/${A}`, `/signals/${B}`, "/signals", "/signals.xml"]);
  assert.deepEqual(signalPaths([]), [], "nothing new, nothing to announce, not even the list");
  assert.deepEqual(signalPaths(["../archive", "g-123", `${A}/x`, `${A.toUpperCase()}`, "", `${A}?x=1`]), [], "an id is exactly g- and sixteen hex digits, so no path can be smuggled in through one");
  assert.deepEqual(signalPaths([A, "../x", A]), [`/signals/${A}`, "/signals", "/signals.xml"], "a bad one is dropped and a repeated one is listed once");
});

test("a ping is one POST naming the host, the public key, where the engines can read it, and every page as an absolute address", async () => {
  const seen = [];
  const result = await withNetwork({ key: "k".repeat(32), site: "https://forwardpass.example" }, async (url, init) => { seen.push({ url: String(url), init }); return new Response(null, { status: 202 }); },
    () => pingIndexNow(signalPaths([A])));
  assert.deepEqual(result, { status: 202 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.indexnow.org/indexnow");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(seen[0].init.body), { host: "forwardpass.example", key: "k".repeat(32), keyLocation: `https://forwardpass.example/${"k".repeat(32)}.txt`, urlList: [`https://forwardpass.example/signals/${A}`, "https://forwardpass.example/signals", "https://forwardpass.example/signals.xml"] });
});

test("without a key or a site nothing is sent, and any answer but 200 or 202 is an error", async () => {
  let sent = 0;
  const count = async () => { sent++; return new Response(null, { status: 200 }); };
  assert.deepEqual(await withNetwork({ key: undefined, site: "https://forwardpass.example" }, count, () => pingIndexNow(["/x"])), { skipped: "INDEXNOW_KEY or PUBLIC_SITE_URL is not set" });
  assert.deepEqual(await withNetwork({ key: "k".repeat(32), site: undefined }, count, () => pingIndexNow(["/x"])), { skipped: "INDEXNOW_KEY or PUBLIC_SITE_URL is not set" });
  assert.equal(sent, 0);
  assert.deepEqual(await withNetwork({ key: "k".repeat(32), site: "https://forwardpass.example" }, count, () => pingIndexNow(["/x"])), { status: 200 });
  for (const status of [400, 403, 422, 429, 500]) {
    await assert.rejects(withNetwork({ key: "k".repeat(32), site: "https://forwardpass.example" }, async () => new Response(null, { status }), () => pingIndexNow(["/x"])), new RegExp(`answered ${status}`));
  }
});

test("an engine that never answers is given up on, so the caller is not held for as long as the network would hold it", async () => {
  const silent = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const started = Date.now();
  await assert.rejects(withNetwork({ key: "k".repeat(32), site: "https://forwardpass.example" }, silent, () => pingIndexNow(["/x"], { timeoutMs: 30 })), /timed? ?out|abort/i);
  assert.ok(Date.now() - started < 2000);
  // And the default leaves an engine time to answer: its signal is still open well after the call began.
  let waited = null;
  await withNetwork({ key: "k".repeat(32), site: "https://forwardpass.example" }, async (url, init) => { waited = init.signal; await new Promise((resolve) => setTimeout(resolve, 50)); return new Response(null, { status: 200 }); }, () => pingIndexNow(["/x"]));
  assert.ok(waited instanceof AbortSignal && !waited.aborted, "a signal is always passed");
});
