import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { localSignalService } from "../src/lib/signal-service.ts";
import { signalId } from "../src/lib/signals.ts";
import { stubCloudflareWorkers } from "./cloudflare-workers-stub.mjs";
import { newStore, record } from "./signals-test-support.mjs";

stubCloudflareWorkers();
const worker = await import("../src/worker.ts");

// The wiring: which cron starts what, under which flag; the public routes with their cache and limiter; the admin routes; and
// that wrangler.jsonc declares exactly what the worker exports. Deploying changes nothing until the owner turns a flag on.
const TOKEN = "t".repeat(40);
const AT = Date.parse("2026-10-03T10:15:00Z");

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
function makeEnv(flags = {}, service = localSignalService(newStore())) {
  const calls = [];
  const spy = Object.fromEntries(Object.entries(service).map(([name, method]) => [name, async (...args) => { calls.push(name); return method(...args); }]));
  return { BUCKET: bucket(), COLLECT: workflow(), COLLECT_FAST: workflow(), ISSUE: workflow(), DELIVER: workflow(), SIGNALS: { getByName: () => spy }, SIGNALS_RATE_LIMITER: { limit: async () => ({ success: true }) }, ADMIN_TOKEN: TOKEN, calls, service, ...flags };
}
const cron = (expression) => ({ cron: expression, scheduledTime: AT });
const fetchAs = (env, path, init = {}) => worker.default.fetch(new Request(`https://api.test${path}`, init), env, { waitUntil() {} });
const admin = (env, path, body, token = TOKEN) => fetchAs(env, path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// The Cache API, in memory.
const cached = new Map();
globalThis.caches = { default: { async match(request) { const hit = cached.get(request.url); return hit ? hit.clone() : undefined; }, async put(request, response) { cached.set(request.url, response); } } };

test("the fifteen-minute cron starts the fast workflow only when the fast lane is on, and never the main collection", async () => {
  for (const flags of [{}, { FORWARDPASS_FAST_LANE_ENABLED: "false" }, { FORWARDPASS_FAST_LANE_ENABLED: "yes" }, { FORWARDPASS_FAST_LANE_ENABLED: "TRUE" }, { FORWARDPASS_SIGNALS_ENABLED: "true" }]) {
    const env = makeEnv(flags);
    await worker.default.scheduled(cron("*/15 * * * *"), env);
    assert.deepEqual([env.COLLECT_FAST.created, env.COLLECT.created, env.ISSUE.created], [[], [], []], `nothing starts with ${JSON.stringify(flags)}`);
  }
  const on = makeEnv({ FORWARDPASS_FAST_LANE_ENABLED: "true" });
  await worker.default.scheduled(cron("*/15 * * * *"), on);
  assert.deepEqual(on.COLLECT_FAST.created, [{ id: "fast-2026-10-03-10-15", params: { now: "2026-10-03T10:15:00.000Z", collect: true, signals: "off", lane: "fast" } }], "collection only, until signals are switched on");
  assert.deepEqual([on.COLLECT.created.length, on.ISSUE.created.length], [0, 0]);
  await worker.default.scheduled(cron("*/15 * * * *"), on);
  assert.equal(on.COLLECT_FAST.created.length, 1, "a repeated trigger of the same minute is a no-op, not an error");
  const both = makeEnv({ FORWARDPASS_FAST_LANE_ENABLED: "true", FORWARDPASS_SIGNALS_ENABLED: "true" });
  await worker.default.scheduled(cron("*/15 * * * *"), both);
  assert.equal(both.COLLECT_FAST.created[0].params.signals, "publish");
});

test("the two-hour and daily crons are as they were", async () => {
  const env = makeEnv({ FORWARDPASS_FAST_LANE_ENABLED: "true", FORWARDPASS_SIGNALS_ENABLED: "true" });
  await worker.default.scheduled(cron("0 */2 * * *"), env);
  assert.deepEqual(env.COLLECT.created, [{ id: "collect-2026-10-03T10", params: { now: "2026-10-03T10:15:00.000Z" } }]);
  await worker.default.scheduled(cron("30 5 * * *"), env);
  assert.equal(env.ISSUE.created.length, 1);
  assert.equal(env.COLLECT_FAST.created.length, 0, "neither starts the fast lane");
});

test("the fast workflow collects only when asked, and runs signals as off, preview or publish", async () => {
  const run = async (params, flags = {}) => {
    const env = makeEnv(flags);
    const instance = new worker.FastCollectWorkflow({}, env);
    const result = await instance.run({ payload: { now: "2026-10-03T10:15:00.000Z", ...params }, timestamp: new Date(AT) }, { do: async (name, config, callback) => callback(), sleep: async () => {} });
    return { env, result };
  };
  const off = await run({ collect: false, signals: "off", lane: "fast" });
  assert.deepEqual([off.result.collection, off.result.signals], [null, null]);
  assert.deepEqual([...off.env.BUCKET.objects.keys()], [], "nothing is written, and the signal service is never touched");
  assert.deepEqual(off.env.calls, []);
  const preview = await run({ collect: false, signals: "preview", lane: "fast" });
  assert.equal(preview.result.signals.preview, true);
  const report = JSON.parse(preview.env.BUCKET.objects.get("signals/runs/2026-10-03/1015.json"));
  assert.deepEqual([report.preview, report.lane, report.considered], [true, "fast", 0]);
  assert.ok(!preview.env.calls.some((name) => ["claim", "publish", "release", "setValue"].includes(name)), "a preview only reads");
  const publish = await run({ collect: false, signals: "publish", lane: "main" });
  assert.deepEqual([publish.result.signals.preview, JSON.parse(publish.env.BUCKET.objects.get("signals/runs/2026-10-03/1015.json")).lane], [false, "main"]);
});

test("a main-lane collection runs signals after it only when they are enabled", () => {
  const source = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
  const body = /export class CollectWorkflow[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
  assert.ok(body.includes("collectSources("), "it still collects");
  assert.match(body, /signalsEnabled\(this\.env\)/, "and asks whether signals are on");
  assert.ok(body.indexOf("signalsEnabled(this.env)") > body.indexOf("collectSources("), "after collecting, not before");
  assert.match(body, /catch/, "a signals failure is logged and never fails the collection");
});

test("new signal pages are announced to the search engines, and the daily issue's recall counts signals, only where signals are enabled", () => {
  const source = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
  const runSignals = /function runSignals[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
  assert.match(runSignals, /announce: pingIndexNow/, "every run that publishes tells the engines");
  const issue = /export class IssueWorkflow[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
  assert.match(issue, /produceIssue\(steps, \{[^}]*\}, \{ signals: signalsEnabled\(this\.env\) \? signalService\(this\.env\) : undefined \}\)/, "the recall reads the signal store when signals are on, and does not touch it when they are off");
});

test("the public routes are served from the edge cache, limited when they would reach the store, and labelled", async () => {
  cached.clear();
  const service = localSignalService(newStore());
  await service.publish(record("https://lab.test/model"));
  const env = makeEnv({}, service);
  const first = await fetchAs(env, "/signals?limit=1");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("X-AI-Generated"), "true");
  assert.equal(env.calls.filter((name) => name === "list").length, 1);
  const second = await fetchAs(env, "/signals?limit=1");
  assert.equal(second.status, 200);
  assert.equal(env.calls.filter((name) => name === "list").length, 1, "the second is answered from the cache");
  assert.equal(second.headers.get("X-AI-Generated"), "true");
  assert.equal((await (await fetchAs(env, `/signals/${signalId("https://lab.test/model")}`)).json()).headline, record("https://lab.test/model").headline);
  assert.equal((await fetchAs(env, "/signals/stats")).status, 200);
  assert.equal((await fetchAs(env, "/corrections")).status, 200);
  const beforeErrors = env.calls.length;
  for (const bad of ["/signals?type=gossip", "/signals/not-an-id", "/signals?before=nope"]) assert.ok([400, 404].includes((await fetchAs(env, bad)).status), bad);
  assert.equal(env.calls.length, beforeErrors, "a malformed request never reaches the store");
  assert.equal((await fetchAs(env, "/signals?limit=1", { method: "POST", body: "{}" })).status, 405);
  assert.equal(cached.has("https://api.test/signals?limit=1"), true);
  assert.equal([...cached.keys()].some((url) => /gossip|not-an-id|nope/.test(url)), false, "errors are not cached");

  // A request that would reach the store is counted against the caller, and a cached one is not.
  cached.clear();
  const limited = makeEnv({}, service);
  let asked = null;
  limited.SIGNALS_RATE_LIMITER = { limit: async ({ key }) => { asked = key; return { success: false }; } };
  const refused = await fetchAs(limited, "/signals?q=x", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("X-AI-Generated"), "true");
  assert.ok(Number(refused.headers.get("Retry-After")) > 0);
  assert.equal(asked, "203.0.113.9", "limited per caller");
  assert.equal(limited.calls.length, 0, "and the store is never reached");
  assert.equal((await fetchAs(env, "/signals?limit=1")).status, 200, "a cached answer needs no allowance");
  assert.equal((await fetchAs(env, "/health")).status, 200, "other routes are untouched");
});

test("the admin routes need the token, report the flags and the day, and start runs only as asked", async () => {
  const env = makeEnv({ FORWARDPASS_FAST_LANE_ENABLED: "true" });
  for (const [path, body] of [["/admin/signals/status"], ["/admin/signals/run", {}], ["/admin/signals/correct", {}]]) assert.equal((await admin(env, path, body, "wrong".repeat(10))).status, 401, path);
  await env.service.publish(record("https://lab.test/model", { publishedAt: new Date().toISOString() }));
  const day = new Date().toISOString().slice(0, 10);
  env.BUCKET.objects.set(`signals/runs/${day}/0915.json`, JSON.stringify({ now: `${day}T09:15:00.000Z`, lane: "fast", preview: false, considered: 3, published: 1, failed: 0, rejected: 2, skippedCap: 0, cost: 0.01, outcomes: [{ urlKey: "x" }] }));
  const status = await (await admin(env, "/admin/signals/status")).json();
  assert.deepEqual([status.signalsEnabled, status.fastLaneEnabled, status.publishedToday], [false, true, 1]);
  assert.equal(status.last7days.published, 1);
  assert.deepEqual(status.recentRuns, [{ at: `${day}T09:15:00.000Z`, lane: "fast", preview: false, considered: 3, published: 1, failed: 0, rejected: 2, skippedCap: 0, cost: 0.01 }], "a summary, not every outcome");

  const preview = await admin(env, "/admin/signals/run", { preview: true, lane: "fast" });
  assert.equal(preview.status, 200);
  assert.deepEqual(env.COLLECT_FAST.created.at(-1).params, { collect: false, signals: "preview", lane: "fast" });
  assert.equal((await admin(env, "/admin/signals/run", {})).status, 200, "a preview is the default");
  assert.equal(env.COLLECT_FAST.created.at(-1).params.signals, "preview");
  const refused = await admin(env, "/admin/signals/run", { preview: false });
  assert.equal(refused.status, 409, "publishing needs the flag");
  assert.match((await refused.json()).error, /FORWARDPASS_SIGNALS_ENABLED/);
  const enabled = makeEnv({ FORWARDPASS_SIGNALS_ENABLED: "true" });
  await admin(enabled, "/admin/signals/run", { preview: false, lane: "main", now: "2026-10-03T10:00:00.000Z", collect: true });
  assert.deepEqual(enabled.COLLECT_FAST.created[0].params, { now: "2026-10-03T10:00:00.000Z", collect: true, signals: "publish", lane: "main" });
  for (const bad of [{ lane: "slow" }, { preview: "yes" }, { now: "tomorrow" }]) assert.equal((await admin(env, "/admin/signals/run", bad)).status, 400, JSON.stringify(bad));
  const instance = await admin(env, `/admin/fast/${env.COLLECT_FAST.created[0].id}`);
  assert.equal(instance.status, 200, "a fast run's status can be read like the others'");
});

test("a correction or retraction goes through the admin route, and says what was wrong", async () => {
  const env = makeEnv();
  const row = record("https://lab.test/model");
  await env.service.publish(row);
  const fix = await admin(env, "/admin/signals/correct", { id: row.id, kind: "correction", note: "The score was misread.", summary: "Embed 5 is in preview." });
  assert.equal(fix.status, 200);
  assert.deepEqual(await fix.json(), { ok: true, id: row.id, kind: "correction" });
  assert.equal((await env.service.get(row.id)).summary, "Embed 5 is in preview.");
  const missing = await admin(env, "/admin/signals/correct", { id: "g-0000000000000000", kind: "retraction", note: "Gone." });
  assert.equal(missing.status, 404);
  for (const bad of [{ id: row.id, kind: "correction" }, { id: row.id, kind: "correction", note: "  " }, { id: "nope", kind: "retraction", note: "x" }, { id: row.id, kind: "erase", note: "x" }, { id: row.id, kind: "correction", note: "x", headline: "h".repeat(300) }]) {
    assert.equal((await admin(env, "/admin/signals/correct", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin(env, "/admin/signals/correct", { id: row.id, kind: "retraction", note: "The source withdrew it." })).status, 200);
  assert.equal((await env.service.get(row.id)).status, "retracted");
  assert.equal((await admin(env, "/admin/signals/correct", { id: row.id, kind: "correction", note: "Too late." })).status, 404, "a retracted signal is final");
});

test("the public signals' allowance is counted per /64 for an IPv6 caller, as the MCP server's is, and an IPv4 caller is counted by address", async () => {
  cached.clear();
  const env = makeEnv({}, localSignalService(newStore()));
  const keys = [];
  env.SIGNALS_RATE_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
  await fetchAs(env, "/signals?q=a", { headers: { "cf-connecting-ip": "2001:db8:1234:5678::1" } });
  await fetchAs(env, "/signals?q=b", { headers: { "cf-connecting-ip": "2001:db8:1234:5678:ffff::9" } });
  await fetchAs(env, "/signals?q=c", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  await fetchAs(env, "/signals?q=d");
  assert.deepEqual(keys, ["2001:db8:1234:5678::/64", "2001:db8:1234:5678::/64", "203.0.113.9", "anonymous"]);
});

function wrangler() {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  return JSON.parse(text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"));
}

test("wrangler.jsonc declares what the worker exports and starts, with every flag off", () => {
  const config = wrangler();
  assert.ok(config.triggers.crons.includes("*/15 * * * *") && config.triggers.crons.includes("0 */2 * * *") && config.triggers.crons.includes("30 5 * * *"));
  assert.ok(config.durable_objects.bindings.some((binding) => binding.name === "SIGNALS" && binding.class_name === "SignalsIndex"));
  assert.ok(config.migrations.some((migration) => migration.tag === "signals-v1" && migration.new_sqlite_classes?.includes("SignalsIndex")), "a SQLite-backed class needs its migration");
  assert.ok(config.workflows.some((flow) => flow.binding === "COLLECT_FAST" && flow.class_name === "FastCollectWorkflow"));
  assert.deepEqual([config.vars.FORWARDPASS_FAST_LANE_ENABLED, config.vars.FORWARDPASS_SIGNALS_ENABLED], ["false", "false"], "a deploy changes nothing until the owner turns them on");
  const limiter = config.ratelimits.find((limit) => limit.name === "SIGNALS_RATE_LIMITER");
  assert.ok(limiter, "the public reads are limited");
  assert.ok(limiter.simple.limit >= 300, "with room for the website's own server, which builds a page for each signal a crawler asks for and reads through a few addresses");
  const unique = (values, label) => assert.equal(new Set(values).size, values.length, `${label} are unique`);
  unique(config.migrations.map(({ tag }) => tag), "migration tags");
  unique(config.workflows.map(({ binding }) => binding), "workflow bindings");
  unique(config.workflows.map(({ name }) => name), "workflow names");
  unique(config.ratelimits.map(({ namespace_id: id }) => id), "rate limit namespaces");
  unique(config.durable_objects.bindings.map(({ name }) => name), "Durable Object bindings");
  for (const { class_name: name } of [...config.workflows, ...config.durable_objects.bindings]) assert.equal(typeof worker[name], "function", `${name} is exported by the worker`);
  for (const name of config.migrations.flatMap((migration) => migration.new_sqlite_classes ?? [])) assert.equal(typeof worker[name], "function", `${name} has a class behind its migration`);
});
