import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stubCloudflareWorkers } from "./cloudflare-workers-stub.mjs";

stubCloudflareWorkers();
const worker = await import("../src/worker.ts");

// The Compute lane is off until the owner turns it on: a deploy changes nothing about the issue until FORWARDPASS_COMPUTE_ENABLED is "true".
const TOKEN = "t".repeat(40);
function bucket() {
  const objects = new Map();
  return {
    objects,
    async get(key) { return objects.has(key) ? { text: async () => objects.get(key) } : null; },
    async put(key, body) { objects.set(key, String(body)); return { key }; },
    async list({ prefix = "" } = {}) { return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }; },
    async delete(key) { objects.delete(key); },
  };
}
const status = async (vars = {}) => (await worker.default.fetch(new Request("https://api.test/admin/editions/status", { headers: { authorization: `Bearer ${TOKEN}` } }), { BUCKET: bucket(), ADMIN_TOKEN: TOKEN, ...vars }, { waitUntil() {} })).json();
const source = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"));

test("the editions status says whether the Compute lane is on, and only the exact word turns it on", async () => {
  assert.equal((await status()).computeEnabled, false);
  for (const value of ["false", "yes", "TRUE", "1", ""]) assert.equal((await status({ FORWARDPASS_COMPUTE_ENABLED: value })).computeEnabled, false, JSON.stringify(value));
  assert.equal((await status({ FORWARDPASS_COMPUTE_ENABLED: "true" })).computeEnabled, true);
});

test("the daily issue is built with the lane exactly when the flag is on", () => {
  assert.match(source, /produceIssue\(steps, \{ date: event\.payload\.date, now, publish: event\.payload\.publish, compute: computeEnabled\(this\.env\) \}/);
});

test("wrangler.jsonc declares the flag in words the Worker reads", () => {
  // It was shipped off, and turned on on 10 October once the lane had been run on real data and in the Workers runtime. Only the exact word
  // "true" turns it on (the status test above), so a slip such as "True" or "yes" would silently leave the block out.
  assert.match(config.vars.FORWARDPASS_COMPUTE_ENABLED, /^(true|false)$/);
});
