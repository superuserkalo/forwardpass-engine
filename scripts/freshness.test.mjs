import assert from "node:assert/strict";
import test from "node:test";
import { memoryStore, useStore } from "../src/lib/private-store.ts";
import { uniqueByEntry } from "../src/collect/collect.ts";
import { entryKey } from "../src/lib/entry-key.ts";
import { collectSourceStreams } from "../src/lib/source-collector.ts";
import { clusterCandidates, freshCandidates } from "../src/pipeline/candidates.ts";
import { candidateTime, isFreshCandidate } from "../src/pipeline/freshness.ts";

// Regressions found by replaying the recall misses of 28 Sep to 3 Oct (docs/route-miss-research-2026-10-03.md).

const candidate = (extra = {}) => ({ title: "A release", summary: "", url: "https://lab.test/a", publishedAt: "2026-09-30T10:00:00Z", source: "Lab", category: "changelog", dateKind: "published", firstSeenAt: "2026-09-30T16:05:00Z", observedAt: "2026-09-30T16:05:00Z", ...extra });

test("a page-change event is fresh from the moment it changed, not from the page's first sighting", () => {
  const reference = Date.parse("2026-10-01T05:30:00Z");
  const since = Date.parse("2026-09-28T05:30:00Z");
  // Zed's releases page was baselined on 26 Sep and changed on 30 Sep (Zed 1.22).
  const changed = candidate({ title: "Zed: releases page changed", publishedAt: null, dateKind: "changed", firstSeenAt: "2026-09-26T00:31:00Z", observedAt: "2026-09-30T16:05:00Z" });
  assert.equal(isFreshCandidate(changed, reference, since), true);
  // An undated item that merely appeared long ago stays old (guard: behaviour that must not change).
  const old = candidate({ publishedAt: null, dateKind: "first-seen", firstSeenAt: "2026-09-26T00:31:00Z", observedAt: "2026-09-26T00:31:00Z" });
  assert.equal(isFreshCandidate(old, reference, since), false);
});

test("a date-only stamp does not age an item out of a window that opens later the same day", () => {
  const reference = Date.parse("2026-09-28T05:30:00Z");
  const since = Date.parse("2026-09-25T05:30:00Z");
  // Anthropic's post carries 2026-09-25 and was first seen at 00:31 the next morning.
  const dateOnly = candidate({ publishedAt: "2026-09-25T00:00:00.000Z", firstSeenAt: "2026-09-26T00:31:00Z" });
  assert.equal(candidateTime(dateOnly), Date.parse("2026-09-25T23:59:59.999Z"));
  assert.equal(isFreshCandidate(dateOnly, reference, since), true);
  // Guards: an old date-only item and a precise stamp before the window stay out.
  assert.equal(isFreshCandidate(candidate({ publishedAt: "2026-09-20T00:00:00.000Z", firstSeenAt: "2026-09-26T00:31:00Z" }), reference, since), false);
  assert.equal(isFreshCandidate(candidate({ publishedAt: "2026-09-25T03:00:00.000Z", firstSeenAt: "2026-09-26T00:31:00Z" }), reference, since), false);
  // First seen the same day, before the window opened: it belonged to the previous issue.
  assert.equal(isFreshCandidate(candidate({ publishedAt: "2026-09-25T00:00:00.000Z", firstSeenAt: "2026-09-25T02:00:00Z" }), reference, since), false);
});

test("the collector stamps a changed page with the time of the change", async () => {
  const page = { id: "zed", publisher: "Zed", publisherId: "zed", section: "releases", category: "releases", kind: "html-news", url: "https://zed.test/releases/stable" };
  const body = (version) => `<main><p>${`Release notes for Zed version ${version}. `.repeat(12)}</p></main>`;
  const first = new Date("2026-09-26T00:31:00Z");
  const second = new Date("2026-09-30T16:05:00Z");
  const baseline = await collectSourceStreams(undefined, { now: first, streams: [page], fetcher: async () => new Response(body("1.21"), { headers: { "content-type": "text/html" } }) });
  assert.equal(baseline.items.length, 0, "the first sighting of an undated page is a baseline");
  const changed = await collectSourceStreams(baseline.state, { now: second, streams: [page], fetcher: async () => new Response(body("1.22"), { headers: { "content-type": "text/html" } }) });
  assert.equal(changed.items.length, 1);
  assert.equal(changed.items[0].dateKind, "changed");
  assert.equal(changed.items[0].firstSeenAt, second.toISOString());
});

test("changelog entries on one page keep distinct identities, ordinary fragments do not", () => {
  assert.notEqual(entryKey("https://developers.test/api/changelog#2026-09-30-a"), entryKey("https://developers.test/api/changelog#2026-09-30-b"));
  assert.notEqual(entryKey("https://docs.test/release-notes/overview#september-24-2026"), entryKey("https://docs.test/release-notes/overview#september-23-2026"));
  assert.notEqual(entryKey("https://github.com/acme/tool/releases#hd-1"), entryKey("https://github.com/acme/tool/releases#hd-2"));
  // The fragment is only identity where the page lists many entries (guards: unchanged behaviour).
  assert.equal(entryKey("https://lab.test/blog/post#comments"), entryKey("https://lab.test/blog/post"));
  assert.equal(entryKey("https://lab.test/blog/post?utm_source=x"), entryKey("https://lab.test/blog/post"));
  assert.equal(entryKey("https://developers.test/api/changelog"), "https://developers.test/api/changelog");
});

test("a snapshot keeps every changelog entry from one page", () => {
  const entries = ["a", "b", "c"].map((id) => ({ title: `Entry ${id}`, summary: "", url: `https://developers.test/api/changelog#entry-${id}`, publishedAt: "2026-09-30T10:00:00Z", source: "Lab", category: "changelog" }));
  assert.equal(uniqueByEntry([...entries, { ...entries[0], title: "Same entry again" }]).length, 3);
});

test("the daily pool keeps every changelog entry that landed since the last issue", async () => {
  const entries = ["a", "b"].map((id) => candidate({ title: `Entry ${id} ships`, url: `https://developers.test/api/changelog#entry-${id}` }));
  useStore(memoryStore({ "collection/runs/2026-09-30/16.json": { version: 2, collectedAt: "2026-09-30T16:00:00Z", items: entries, attention: { measurements: [], candidates: [], health: [] }, health: [] } }));
  const fresh = await freshCandidates("2026-10-01", new Date("2026-10-01T05:30:00Z"));
  assert.equal(fresh.candidates.length, 2);
});

test("distinct changelog entries from one page are separate stories", () => {
  const clusters = clusterCandidates([
    candidate({ title: "Plugins gain lifecycle hooks", url: "https://developers.test/api/changelog#plugins" }),
    candidate({ title: "Billing API adds a pricing field", url: "https://developers.test/api/changelog#billing" }),
  ]);
  assert.equal(clusters.length, 2);
});
