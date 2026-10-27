import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createPrivateJson, useStore } from "../src/lib/private-store.ts";
import { r2BindingStore } from "../src/lib/store-r2.ts";
import { stubCloudflareWorkers } from "./cloudflare-workers-stub.mjs";
import { EDITION } from "./weekly-compute-fixture.mjs";

stubCloudflareWorkers();
const worker = await import("../src/worker.ts");

// The wiring of the weekly Compute report: which cron starts it, under which flag, which workflows do what, and the admin routes that start them.
// Deploying changes nothing until the owner turns the flag on.
const TOKEN = "t".repeat(40);
const SUNDAY = Date.parse("2026-10-11T07:45:00Z");
const DATE = "2026-10-11";

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
function workflow() {
  const created = [];
  return { created, async create({ id, params }) { if (created.some((instance) => instance.id === id)) throw new Error("Instance already exists"); created.push({ id, params }); return {}; }, async get() { return { status: async () => ({ status: "running" }) }; } };
}
const makeEnv = (flags = {}) => ({ BUCKET: bucket(), COLLECT: workflow(), COLLECT_FAST: workflow(), ISSUE: workflow(), DELIVER: workflow(), WEEKLY: workflow(), WEEKLY_DELIVER: workflow(), WEEKLY_COMPUTE: workflow(), WEEKLY_COMPUTE_DELIVER: workflow(), ADMIN_TOKEN: TOKEN, ...flags });
const cron = (expression, at = SUNDAY) => ({ cron: expression, scheduledTime: at });
const stepper = (names = []) => ({ do: async (name, config, callback) => { names.push(name); return callback(); }, sleep: async () => {} });
const runFlow = (Flow, env, payload, names) => new Flow({}, env).run({ payload, timestamp: new Date(SUNDAY) }, stepper(names));
const admin = (env, path, body, token = TOKEN) => worker.default.fetch(new Request(`https://api.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });

async function publishReport(env, date = DATE) {
  useStore(r2BindingStore(env.BUCKET));
  await createPrivateJson(`weekly-compute/${date}.json`, { ...EDITION(), date });
  await createPrivateJson(`published/weekly-compute/${date}.json`, { version: 2, kind: "weekly-compute", date, publishedAt: `${date}T07:45:00.000Z` });
}

test("the 07:45 Sunday cron starts the report only when the owner turned it on, once a week, and no other cron does", async () => {
  for (const flags of [{}, { FORWARDPASS_COMPUTE_WEEKLY_ENABLED: "false" }, { FORWARDPASS_COMPUTE_WEEKLY_ENABLED: "yes" }, { FORWARDPASS_COMPUTE_WEEKLY_ENABLED: "TRUE" }, { FORWARDPASS_WEEKLY_ENABLED: "true", FORWARDPASS_COMPUTE_ENABLED: "true" }]) {
    const env = makeEnv(flags);
    await worker.default.scheduled(cron("45 7 * * SUN"), env);
    assert.deepEqual(env.WEEKLY_COMPUTE.created, [], JSON.stringify(flags));
  }
  const on = makeEnv({ FORWARDPASS_COMPUTE_WEEKLY_ENABLED: "true" });
  await worker.default.scheduled(cron("45 7 * * SUN"), on);
  assert.deepEqual(on.WEEKLY_COMPUTE.created, [{ id: `weekly-compute-${DATE}`, params: { date: DATE, publish: true, deliver: true } }]);
  assert.deepEqual([on.WEEKLY.created.length, on.ISSUE.created.length, on.COLLECT.created.length], [0, 0, 0]);
  await worker.default.scheduled(cron("45 7 * * SUN"), on);
  assert.equal(on.WEEKLY_COMPUTE.created.length, 1, "a repeated trigger of the same Sunday is a no-op");
  for (const expression of ["30 7 * * SUN", "30 5 * * *", "0 */2 * * *", "*/15 * * * *"]) {
    const env = makeEnv({ FORWARDPASS_COMPUTE_WEEKLY_ENABLED: "true", FORWARDPASS_WEEKLY_ENABLED: "true" });
    await worker.default.scheduled(cron(expression), env);
    assert.equal(env.WEEKLY_COMPUTE.created.length, 0, `${expression} does not start it`);
  }
  const weekly = makeEnv({ FORWARDPASS_COMPUTE_WEEKLY_ENABLED: "true" });
  await worker.default.scheduled(cron("30 7 * * SUN"), weekly);
  assert.equal(weekly.WEEKLY.created.length, 0, "and the weekly research stays under its own flag");
});

test("the workflow writes the report from the issues, and starts delivery only for a report that is published and asked for", async () => {
  const env = makeEnv();
  useStore(r2BindingStore(env.BUCKET));
  const none = await runFlow(worker.WeeklyComputeWorkflow, env, { date: DATE, publish: true, deliver: true });
  assert.deepEqual([none.published, none.reason, none.delivery], [false, "too few compute stories", null]);
  assert.deepEqual(env.WEEKLY_COMPUTE_DELIVER.created, [], "nothing is delivered when nothing is published");

  const done = makeEnv();
  await publishReport(done);
  const result = await runFlow(worker.WeeklyComputeWorkflow, done, { date: DATE, publish: true, deliver: true });
  assert.deepEqual([result.published, result.existing, result.delivery], [true, true, `weekly-compute-deliver-${DATE}`]);
  assert.deepEqual(done.WEEKLY_COMPUTE_DELIVER.created, [{ id: `weekly-compute-deliver-${DATE}`, params: { date: DATE } }]);
  await runFlow(worker.WeeklyComputeWorkflow, done, { date: DATE, publish: true, deliver: true });
  assert.equal(done.WEEKLY_COMPUTE_DELIVER.created.length, 1, "starting it twice is a no-op");

  const held = makeEnv();
  await publishReport(held);
  assert.equal((await runFlow(worker.WeeklyComputeWorkflow, held, { date: DATE, publish: true, deliver: false })).delivery, null);
  assert.deepEqual(held.WEEKLY_COMPUTE_DELIVER.created, [], "published, but nobody asked for it to be sent");
});

test("the delivery workflow sends what is saved, and fails loudly when nothing is", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const names = [];
  const env = makeEnv();
  useStore(r2BindingStore(env.BUCKET));
  await assert.rejects(runFlow(worker.WeeklyComputeDeliveryWorkflow, env, { date: DATE }, names), /No weekly Compute report saved for 2026-10-11/);
  assert.deepEqual(names, ["edition"]);
});

test("the admin routes preview, publish and send the report as asked, and say how it went", async () => {
  const env = makeEnv();
  for (const [path, body] of [["/admin/weekly-compute", {}], ["/admin/weekly-compute-deliver", {}]]) assert.equal((await admin(env, path, body, "wrong".repeat(10))).status, 401, path);
  assert.equal((await admin(env, "/admin/weekly-compute", { date: DATE })).status, 200);
  assert.deepEqual(env.WEEKLY_COMPUTE.created.at(-1).params, { date: DATE, publish: false, deliver: false }, "a preview is the default");
  assert.match(env.WEEKLY_COMPUTE.created.at(-1).id, /^weekly-compute-2026-10-11-preview-\d+$/);
  await admin(env, "/admin/weekly-compute", { date: DATE, publish: true, deliver: true });
  assert.deepEqual(env.WEEKLY_COMPUTE.created.at(-1), { id: `weekly-compute-${DATE}`, params: { date: DATE, publish: true, deliver: true } });
  assert.equal((await admin(env, "/admin/weekly-compute", { date: DATE, deliver: true })).status, 400, "delivering needs publishing");
  assert.equal((await admin(env, "/admin/weekly-compute", { date: "nonsense" })).status, 400);

  await admin(env, "/admin/weekly-compute-deliver", { date: DATE, test: ["editor@example.com"] });
  assert.deepEqual(env.WEEKLY_COMPUTE_DELIVER.created.at(-1).params, { date: DATE, test: ["editor@example.com"] });
  assert.match(env.WEEKLY_COMPUTE_DELIVER.created.at(-1).id, /^weekly-compute-deliver-2026-10-11-test-\d+$/);
  await admin(env, "/admin/weekly-compute-deliver", { date: DATE });
  assert.equal(env.WEEKLY_COMPUTE_DELIVER.created.at(-1).id, `weekly-compute-deliver-${DATE}`);
  assert.equal((await admin(env, "/admin/weekly-compute-deliver", { date: DATE, test: ["not an address"] })).status, 400);
  assert.equal((await admin(env, `/admin/weekly-compute/weekly-compute-${DATE}`)).status, 200, "the status of a run");

  const status = await (await admin(makeEnv({ FORWARDPASS_COMPUTE_WEEKLY_ENABLED: "true" }), `/admin/editions/status?date=${DATE}`)).json();
  assert.equal(status.computeWeeklyEnabled, true);
  assert.deepEqual(status.computeWeekly, { date: DATE, published: false, run: null, delivery: null });
});

test("the Worker is configured for it, with the flag off", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"name": "forwardpass-example-weekly-compute", "binding": "WEEKLY_COMPUTE", "class_name": "WeeklyComputeWorkflow"/);
  assert.match(config, /"name": "forwardpass-example-weekly-compute-deliver", "binding": "WEEKLY_COMPUTE_DELIVER", "class_name": "WeeklyComputeDeliveryWorkflow"/);
  assert.match(config, /"crons": \[[^\]]*"45 7 \* \* SUN"/);
  assert.match(config, /"FORWARDPASS_COMPUTE_WEEKLY_ENABLED": "false"/);
});
