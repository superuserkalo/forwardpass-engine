import assert from "node:assert/strict";
import test from "node:test";
import { SIGNAL_SERVICE_METHODS, localSignalService } from "../src/lib/signal-service.ts";
import { signalId, urlKey } from "../src/lib/signals.ts";
import { stubCloudflareWorkers } from "./cloudflare-workers-stub.mjs";
import { at, newStorage, newStore, record } from "./signals-test-support.mjs";

stubCloudflareWorkers();
const { SignalsIndex } = await import("../src/signals-index.ts");

// The pipeline and the API see the signal store through one async interface, so a Durable Object stub and a local
// store are interchangeable. These run the same scenario through both and require the same answers.
const implementations = {
  "the local service": () => localSignalService(newStore()),
  "the Durable Object": () => new SignalsIndex({ storage: newStorage() }, {}),
};

test("both implementations name every method of the interface", () => {
  assert.equal(SIGNAL_SERVICE_METHODS.length, 14);
  for (const [name, make] of Object.entries(implementations)) {
    const service = make();
    for (const method of SIGNAL_SERVICE_METHODS) assert.equal(typeof service[method], "function", `${name}.${method}`);
  }
});

for (const [name, make] of Object.entries(implementations)) {
  test(`${name} answers a whole run: claim, publish, read, correct, count`, async () => {
    const service = make();
    const first = record("https://lab.test/one", { publishedAt: "2026-10-03T10:20:00.000Z" });
    const second = record("https://lab.test/two", { publishedAt: "2026-10-03T11:40:00.000Z", type: "repos", topics: ["Agents"], headline: "Acme ships an agent memory library" });

    const claims = service.claim([urlKey(first.url), urlKey(second.url)], at(0));
    assert.ok(claims instanceof Promise, "every method is async");
    assert.deepEqual(await claims, [urlKey(first.url), urlKey(second.url)]);
    assert.deepEqual(await service.claim([urlKey(first.url)], at(5)), [], "held by the first caller");
    assert.deepEqual(await service.unavailable([urlKey(first.url), "never-seen"], at(5)), [urlKey(first.url)], "the same question, answered without claiming");
    assert.deepEqual(await service.claim(["never-seen"], at(5)), ["never-seen"]);
    assert.deepEqual(await service.claim(["short"], at(0), 1_000), ["short"], "the lifetime argument is passed on");
    assert.deepEqual(await service.claim(["short"], at(1)), ["short"], "and it lapsed after one second");

    assert.deepEqual(await service.published([urlKey(first.url)]), [], "nothing is published yet, though it is claimed");
    assert.equal(await service.publish(first), "created");
    assert.deepEqual(await service.published([urlKey(first.url), urlKey(second.url)]), [urlKey(first.url)], "the one that has a signal");
    assert.equal(await service.publish(first), "exists");
    assert.equal(await service.publish(second), "created");
    await service.release(urlKey(first.url), "published", at(21));
    await service.release("dropped", "rejected", at(21));
    assert.deepEqual(await service.claim(["dropped"], at(22)), [], "a rejection stays out");
    await service.release("parked", "skipped", at(21));
    assert.deepEqual(await service.claim(["parked"], at(21)), ["parked"], "a skipped item is free at once");
    await service.release("flaky", "failed", at(21));
    assert.deepEqual(await service.claim(["flaky"], at(22)), [], "a failure waits ten minutes");
    assert.deepEqual(await service.claim(["flaky"], at(32)), ["flaky"], "and is then retried, so the outcome reached the store as a failure, not as published or rejected");

    assert.equal((await service.get(first.id)).headline, first.headline);
    assert.equal(await service.get("g-0000000000000000"), null);
    const page = await service.list({ limit: 1 });
    assert.deepEqual(page.signals.map((signal) => signal.id), [second.id]);
    assert.ok(page.next, "a cursor for the rest");
    assert.deepEqual((await service.list({ limit: 1, before: page.next })).signals.map((signal) => signal.id), [first.id]);
    assert.deepEqual((await service.list({ type: "repos", topic: "Agents", minImportance: 7, q: "MEMORY" })).signals.map((signal) => signal.id), [second.id], "every filter is passed on");

    assert.equal(await service.publishedToday("2026-10-03"), 2);
    assert.equal((await service.recentHeadlines("2026-10-03T11:00:00.000Z")).length, 1);
    assert.equal(await service.getValue("cursor"), null);
    await service.setValue("cursor", "abc");
    assert.equal(await service.getValue("cursor"), "abc");

    assert.equal(await service.correct(first.id, "correction", "The score was misread.", at(60), { summary: "Embed 5 is in preview." }), true, "the patch is passed on");
    assert.equal((await service.get(first.id)).summary, "Embed 5 is in preview.");
    assert.deepEqual((await service.corrections(5)).map((entry) => [entry.kind, entry.signalId, entry.before]), [["correction", first.id, { summary: first.summary }]]);
    // Published 40 and 120 minutes after the source's own 09:40 time.
    assert.deepEqual(await service.stats("2026-10-03T00:00:00.000Z"), { published: 2, medianLatencyMinutes: 80, pageVerifiedShare: 1, corrections: 1 });
  });
}

test("a Durable Object error reaches the caller and does not change what is stored", async () => {
  const index = new SignalsIndex({ storage: newStorage() }, {});
  await assert.rejects(index.list({ before: "not-a-cursor" }), /cursor/i);
  await assert.rejects(index.publish({ ...record("https://lab.test/a"), id: signalId("https://lab.test/other") }), /id/i);
  assert.deepEqual((await index.list()).signals, []);
});
