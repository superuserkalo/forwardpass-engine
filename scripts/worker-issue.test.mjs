import assert from "node:assert/strict";
import test from "node:test";
import { stubCloudflareWorkers } from "./cloudflare-workers-stub.mjs";

stubCloudflareWorkers();
const worker = await import("../src/worker.ts");

// On 8 October every collection ran out of memory, and the daily issue, which began with a collection of its own, failed with it: no issue,
// nothing to deliver. The issue is written from the snapshots the two-hourly runs have taken whether or not its own collection succeeds.
function bucket() {
  const objects = new Map();
  return {
    objects,
    async get(key) { return objects.has(key) ? { text: async () => objects.get(key) } : null; },
    async put(key, body, options = {}) { if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null; objects.set(key, String(body)); return { key }; },
    async list({ prefix = "" } = {}) { return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }; },
    async delete(key) { objects.delete(key); },
  };
}
const run = (env, steps) => new worker.IssueWorkflow({}, env).run({ payload: { date: "2026-10-08", publish: true, deliver: true }, timestamp: new Date("2026-10-08T05:30:00.000Z") }, { do: async (name, config, callback) => { steps.push(name); if (name.startsWith("collect/")) throw new Error("Worker exceeded memory limit."); return callback(); }, sleep: async () => {} });

test("the daily issue goes ahead when its own collection fails, and the failure is told", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  const steps = [];
  try {
    // The issue's own steps run: there are no snapshots in this store, so it stops at its first need of them, with its own message.
    await assert.rejects(run({ BUCKET: bucket(), BROWSER: {} }, steps), /No fresh candidates/);
  } finally {
    console.error = original;
  }
  assert.ok(steps.some((name) => name.startsWith("collect/")), "the collection was tried");
  assert.ok(steps.includes("existing-issue") && steps.includes("candidates"), "and the issue went on to its own steps");
  assert.match(logged.join("\n"), /forwardpass\.issue_collection_failed.*Worker exceeded memory limit/);
});
