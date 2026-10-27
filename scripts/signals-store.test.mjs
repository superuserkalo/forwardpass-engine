import assert from "node:assert/strict";
import test from "node:test";
import { signalId, signalRecordSchema, urlKey } from "../src/lib/signals.ts";
import { at, newStore, record } from "./signals-test-support.mjs";

test("an id is stable under tracking parameters and fragments, and different for different changelog entries", () => {
  assert.match(signalId("https://lab.test/blog/post"), /^g-[a-f0-9]{16}$/);
  assert.equal(signalId("https://lab.test/blog/post?utm_source=x#top"), signalId("https://lab.test/blog/post"));
  assert.notEqual(signalId("https://lab.test/changelog#a"), signalId("https://lab.test/changelog#b"));
  assert.equal(urlKey("https://lab.test/blog/post?utm_source=x"), "https://lab.test/blog/post");
});

test("a record needs at least one fact with a quote and a well-formed id", () => {
  assert.throws(() => record("https://lab.test/a", { facts: [] }));
  assert.throws(() => record("https://lab.test/a", { facts: [{ fact: "x", quote: "", impact: 1 }] }));
  assert.throws(() => record("https://lab.test/a", { id: "g-nothex" }));
  assert.throws(() => record("https://lab.test/a", { topics: ["Agents", "APIs", "Audio", "Benchmarks"] }));
});

test("a claim is atomic: two callers never own the same item, and a lapsed claim can be retaken", () => {
  const store = newStore();
  assert.deepEqual(store.claim(["a", "b"], at(0)), ["a", "b"]);
  assert.deepEqual(store.claim(["b", "c"], at(5)), ["c"]);
  assert.deepEqual(store.claim(["b"], at(29)), [], "still held at 29 minutes");
  assert.deepEqual(store.claim(["b"], at(31)), ["b"], "a crashed run's claim lapses after 30 minutes");
  assert.deepEqual(store.claim(["d", "d", "d"], at(40)), ["d"], "a key is claimed once per call");
});

test("published and recently rejected items are not claimable, and a failure is retried after a pause, at most three times", () => {
  const store = newStore();
  store.claim(["pub", "rej", "bad"], at(0));
  store.publish(record("https://lab.test/pub"));
  store.release("https://lab.test/pub", "published", at(1));
  store.release("rej", "rejected", at(1));
  store.release("bad", "failed", at(1));
  assert.deepEqual(store.claim(["https://lab.test/pub", "rej"], at(60)), [], "published and rejected stay out");
  assert.deepEqual(store.claim(["bad"], at(5)), [], "a failure waits ten minutes");
  assert.deepEqual(store.claim(["bad"], at(12)), ["bad"]);
  store.release("bad", "failed", at(13));
  assert.deepEqual(store.claim(["bad"], at(30)), ["bad"]);
  store.release("bad", "failed", at(31));
  assert.deepEqual(store.claim(["bad"], at(60)), [], "three failures end it");
  assert.deepEqual(store.claim(["rej"], at(60 * 24 * 3 + 5)), ["rej"], "a rejection lapses after three days");
});

test("a published URL is not claimable even when nobody released it, and an item whose runs keep lapsing is given up on", () => {
  const store = newStore();
  store.publish(record("https://lab.test/done"));
  assert.deepEqual(store.claim([urlKey("https://lab.test/done?utm_source=x")], at(0)), [], "published, whatever the caller did afterwards");
  // A run that crashes never releases its claim. The item comes back after each lapse, but not forever.
  assert.deepEqual(store.claim(["poison"], at(0)), ["poison"]);
  assert.deepEqual(store.claim(["poison"], at(31)), ["poison"], "second attempt");
  assert.deepEqual(store.claim(["poison"], at(62)), ["poison"], "third attempt");
  assert.deepEqual(store.claim(["poison"], at(93)), [], "a fourth is not made");
});

test("unavailable names exactly what claim would refuse, and changes nothing", () => {
  const store = newStore();
  store.publish(record("https://lab.test/done"));
  store.claim(["held", "rejected", "failedOld", "spent"], at(0));
  store.release("rejected", "rejected", at(1));
  store.release("failedOld", "failed", at(1));
  store.release("spent", "failed", at(1));
  store.claim(["spent"], at(12)); store.release("spent", "failed", at(13));
  store.claim(["spent"], at(24)); store.release("spent", "failed", at(25));
  store.claim(["failedFresh"], at(20)); store.release("failedFresh", "failed", at(24));
  store.claim(["lapsed"], at(-40));
  const keys = [urlKey("https://lab.test/done"), "held", "rejected", "failedOld", "failedFresh", "spent", "lapsed", "new"];
  assert.deepEqual(store.unavailable(keys, at(26)), [urlKey("https://lab.test/done"), "held", "rejected", "failedFresh", "spent"],
    "published, held by a live claim, rejected lately, failed lately and out of attempts; not a failure from long ago, a lapsed claim or something never seen");
  assert.deepEqual(store.unavailable(["new", "new", urlKey("https://lab.test/done?utm_source=x")], at(26)), [urlKey("https://lab.test/done")], "each key once, as claim treats it");
  assert.deepEqual(store.claim(["failedOld", "lapsed", "new"], at(26)), ["failedOld", "lapsed", "new"], "asking changed no state");
  assert.deepEqual(store.unavailable(["new"], at(27)), ["new"], "and claiming did");
});

test("published names which of these URLs already have a signal, whatever else is known of them", () => {
  const store = newStore();
  store.publish(record("https://lab.test/done"));
  store.claim(["held", "rejected"], at(0)); store.release("rejected", "rejected", at(1));
  assert.deepEqual(store.published([urlKey("https://lab.test/done?utm_source=x"), "held", "rejected", "unseen", urlKey("https://lab.test/done")]), [urlKey("https://lab.test/done")], "only a published signal, each once");
  assert.deepEqual(store.published([]), []);
  assert.equal(store.published(Array.from({ length: 2500 }, (_, i) => `https://lab.test/k${i}`)).length, 0, "any number of keys, however many a query may take");
  store.publish(record("https://lab.test/k2499"));
  assert.deepEqual(store.published(Array.from({ length: 2500 }, (_, i) => `https://lab.test/k${i}`)), [urlKey("https://lab.test/k2499")]);
});

test("a skipped item is free at once, charges no attempt, and keeps the attempts it had", () => {
  const store = newStore();
  store.claim(["k"], at(0)); store.release("k", "failed", at(1));          // one attempt used
  assert.deepEqual(store.claim(["k"], at(12)), ["k"]);
  store.release("k", "skipped", at(13));                                  // not looked at: a cap, not a failure
  assert.deepEqual(store.unavailable(["k"], at(13)), [], "no ten-minute pause after a skip");
  assert.deepEqual(store.claim(["k"], at(13)), ["k"]);
  store.release("k", "failed", at(14));                                   // attempt two
  assert.deepEqual(store.claim(["k"], at(25)), ["k"]);
  store.release("k", "failed", at(26));                                   // attempt three: if the skip had charged one, this would be four
  assert.deepEqual(store.unavailable(["k"], at(60)), ["k"], "given up on after exactly three failures");
  store.claim(["fresh"], at(0)); store.release("fresh", "skipped", at(1));
  for (let i = 0; i < 5; i++) { assert.deepEqual(store.claim(["fresh"], at(2 + 3 * i)), ["fresh"]); store.release("fresh", "skipped", at(3 + 3 * i)); }
  assert.deepEqual(store.claim(["fresh"], at(30)), ["fresh"], "skipping any number of times never gives an item up");
});

test("an outcome the store does not know is refused, not stored as something claimable", () => {
  const store = newStore();
  store.claim(["k"], at(0));
  assert.throws(() => store.release("k", "skiped", at(1)), /outcome/i);
  assert.throws(() => store.release("k", "claimed", at(1)), /outcome/i, "claimed is what claim sets, not something to release into");
  assert.deepEqual(store.unavailable(["k"], at(2)), ["k"], "the claim is as it was");
});

test("publish is idempotent on the id and on the URL key", () => {
  const store = newStore();
  assert.equal(store.publish(record("https://lab.test/a")), "created");
  assert.equal(store.publish(record("https://lab.test/a")), "exists");
  assert.equal(store.publish(record("https://lab.test/a?utm_source=x")), "exists", "the same page under another spelling");
  assert.equal(store.get(signalId("https://lab.test/a")).headline, "Cohere releases Embed 5 with 85.8 on ViDoRe V3");
  assert.equal(store.get("g-0000000000000000"), null);
  assert.throws(() => store.publish(record("https://lab.test/b", { id: signalId("https://lab.test/other") })), /id/i, "an id that is not the URL's would break idempotence");
});

test("list pages by (published_at, id), so equal timestamps neither repeat nor skip", () => {
  const store = newStore();
  const ids = [];
  for (let i = 0; i < 5; i++) { const r = record(`https://lab.test/p${i}`, { publishedAt: "2026-10-03T10:20:00.000Z" }); store.publish(r); ids.push(r.id); }
  store.publish(record("https://lab.test/older", { publishedAt: "2026-10-03T09:00:00.000Z" }));
  const seen = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const result = store.list({ limit: 2, before: cursor });
    seen.push(...result.signals.map((s) => s.id));
    if (!result.next) break;
    cursor = result.next;
  }
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6, "no row repeats");
  assert.deepEqual(seen.slice(0, 5).sort(), [...ids].sort(), "the five rows sharing a timestamp come before the older one");
  assert.throws(() => store.list({ before: "not-a-cursor" }), /cursor/i);
});

test("list filters by type, topic, importance, time and text, and returns summaries without facts", () => {
  const store = newStore();
  store.publish(record("https://lab.test/model", { type: "models", topics: ["Retrieval"], importance: 8, headline: "Cohere ships Embed 5 for retrieval" }));
  store.publish(record("https://lab.test/repo", { type: "repos", topics: ["Agents", "Open source"], importance: 5, headline: "Acme releases an agent memory library", publishedAt: "2026-10-03T11:00:00.000Z" }));
  store.publish(record("https://lab.test/paper", { type: "papers", topics: ["Reasoning"], importance: 6, headline: "A paper on 100% reasoning accuracy", publishedAt: "2026-10-03T12:00:00.000Z" }));
  assert.deepEqual(store.list({ type: "repos" }).signals.map((s) => s.headline), ["Acme releases an agent memory library"]);
  assert.deepEqual(store.list({ topic: "Open source" }).signals.map((s) => s.type), ["repos"]);
  assert.deepEqual(store.list({ minImportance: 6 }).signals.map((s) => s.type), ["papers", "models"]);
  assert.deepEqual(store.list({ since: "2026-10-03T11:30:00.000Z" }).signals.map((s) => s.type), ["papers"]);
  assert.deepEqual(store.list({ q: "MEMORY" }).signals.map((s) => s.type), ["repos"]);
  assert.equal(store.list({ q: "100%" }).signals.length, 1, "a percent sign in the query is literal");
  assert.equal(store.list({ q: "%" }).signals.length, 1, "and not a wildcard");
  const [first] = store.list().signals;
  assert.equal("facts" in first, false);
  assert.equal(first.evidenceCount, 1);
  assert.equal(store.list({ limit: 1000 }).signals.length, 3, "the limit is clamped, not rejected");
});

test("a correction is logged and can replace the text; a retraction removes the signal from the list", () => {
  const store = newStore();
  const r = record("https://lab.test/a");
  store.publish(r);
  assert.equal(store.correct(r.id, "correction", "The score is 85.8, not 85.", at(60), { headline: "Cohere releases Embed 5 with 85.8 on ViDoRe V3 (corrected)" }), true);
  assert.equal(store.get(r.id).status, "corrected");
  assert.match(store.get(r.id).headline, /corrected/);
  assert.equal(store.list().signals.length, 1);
  assert.equal(store.correct(r.id, "retraction", "The source retracted the post.", at(90)), true);
  assert.equal(store.get(r.id).status, "retracted");
  assert.equal(store.list().signals.length, 0);
  assert.deepEqual(store.corrections().map((c) => [c.kind, c.signalId]), [["retraction", r.id], ["correction", r.id]]);
  assert.equal(store.correct("g-0000000000000000", "correction", "x", at(91)), false);
});

test("a correction records the text it replaced, needs a note, and a retraction is final", () => {
  const store = newStore();
  const r = record("https://lab.test/a");
  store.publish(r);
  assert.throws(() => store.correct(r.id, "correction", "  ", at(5), { summary: "Embed 5 is available." }), /note/i);
  assert.equal(store.get(r.id).status, "live", "a refused correction changes nothing");
  assert.throws(() => store.correct(r.id, "correction", "Shorter.", at(5), { headline: "" }), "a patch must still be a valid record");
  assert.equal(store.correct(r.id, "correction", "The summary overstated availability.", at(6), { summary: "Embed 5 is in preview on the Cohere API." }), true);
  assert.equal(store.get(r.id).summary, "Embed 5 is in preview on the Cohere API.");
  assert.equal(store.get(r.id).headline, r.headline, "fields the patch leaves out are kept");
  assert.deepEqual(store.corrections()[0].before, { summary: r.summary });
  assert.equal(store.correct(r.id, "retraction", "Withdrawn by the publisher.", at(7), { headline: "ignored" }), true);
  assert.equal(store.get(r.id).headline, r.headline, "a retraction changes the status, not the text");
  assert.equal(store.correct(r.id, "correction", "Too late.", at(8), { summary: "x" }), false, "a retracted signal is not revived");
});

test("the daily count, recent headlines, key-value state and stats reflect what was published", () => {
  const store = newStore();
  store.publish(record("https://lab.test/a", { publishedAt: "2026-10-03T10:20:00.000Z", sourcePublishedAt: "2026-10-03T10:00:00.000Z" }));
  store.publish(record("https://lab.test/b", { publishedAt: "2026-10-03T11:40:00.000Z", sourcePublishedAt: "2026-10-03T11:00:00.000Z", evidence: { documentIds: [], capturedAt: "2026-10-03T11:30:00.000Z", basis: "feed-summary", grounding: { evaluator: "code", verdicts: [] } } }));
  store.publish(record("https://lab.test/c", { publishedAt: "2026-10-02T23:50:00.000Z" }));
  assert.equal(store.publishedToday("2026-10-03"), 2);
  assert.equal(store.recentHeadlines("2026-10-03T00:00:00.000Z").length, 2);
  assert.deepEqual(store.recentHeadlines("2026-10-03T11:00:00.000Z"), [{ id: signalId("https://lab.test/b"), headline: "Cohere releases Embed 5 with 85.8 on ViDoRe V3", url: "https://lab.test/b" }], "each with the address it is published for, so a caller can tell whose it is");
  assert.equal(store.getValue("cursor"), null);
  store.setValue("cursor", "2026-10-03T10:00:00Z");
  assert.equal(store.getValue("cursor"), "2026-10-03T10:00:00Z");
  const stats = store.stats("2026-10-03T00:00:00.000Z");
  assert.equal(stats.published, 2);
  assert.equal(stats.medianLatencyMinutes, 30, "median of 20 and 40 minutes from the source's own time");
  assert.equal(stats.pageVerifiedShare, 0.5, "one of two was checked against the captured page, the other against a feed summary");
  assert.equal(stats.corrections, 0);
  assert.deepEqual(store.stats("2026-10-04T00:00:00.000Z"), { published: 0, medianLatencyMinutes: null, pageVerifiedShare: null, corrections: 0 }, "an empty window has no latency or share, not a zero one");
});
