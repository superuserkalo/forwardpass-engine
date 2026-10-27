import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { saveIssue } from "../src/lib/issue.ts";
import { createPrivateJson, useStore } from "../src/lib/private-store.ts";
import { localSignalService } from "../src/lib/signal-service.ts";
import { r2BindingStore } from "../src/lib/store-r2.ts";
import { ISSUE } from "./email-fixture.mjs";
import { stubCloudflareWorkers } from "./cloudflare-workers-stub.mjs";
import { newStore } from "./signals-test-support.mjs";
import { EDITION } from "./weekly-fixture.mjs";

stubCloudflareWorkers();
const worker = await import("../src/worker.ts");

// The wiring of the two things a paying reader is promised: a daily issue chosen for them, and the weekly research on Sundays. Which
// cron starts what, under which flag; which workflow does what; the admin routes that start them and say how they went. Deploying
// changes nothing until the owner turns a flag on.
const TOKEN = "t".repeat(40);
const SUNDAY = Date.parse("2026-10-11T07:30:00Z");
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
function makeEnv(flags = {}) {
  const calls = [], invocations = [];
  const service = localSignalService(newStore());
  const spy = Object.fromEntries(Object.entries(service).map(([name, method]) => [name, async (...args) => { calls.push(name); invocations.push({ name, args }); return method(...args); }]));
  return { BUCKET: bucket(), COLLECT: workflow(), COLLECT_FAST: workflow(), ISSUE: workflow(), DELIVER: workflow(), WEEKLY: workflow(), WEEKLY_DELIVER: workflow(), SIGNALS: { getByName: () => spy }, SIGNALS_RATE_LIMITER: { limit: async () => ({ success: true }) }, ADMIN_TOKEN: TOKEN, calls, invocations, service, ...flags };
}
const cron = (expression, at = SUNDAY) => ({ cron: expression, scheduledTime: at });
const stepper = (names = []) => ({ do: async (name, config, callback) => { names.push(name); return callback(); }, sleep: async () => {} });
const runFlow = (Flow, env, payload, names) => new Flow({}, env).run({ payload, timestamp: new Date(SUNDAY) }, stepper(names));
const admin = (env, path, body, token = TOKEN) => worker.default.fetch(new Request(`https://api.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });

async function publishWeek(env, date = DATE) {
  useStore(r2BindingStore(env.BUCKET));
  await createPrivateJson(`weekly/${date}.json`, { ...EDITION(), date });
  await createPrivateJson(`published/weekly/${date}.json`, { version: 2, kind: "weekly", date, publishedAt: `${date}T07:30:00.000Z` });
}

test("the Sunday cron starts the weekly research only when the owner turned it on, once a week, and no other cron does", async () => {
  for (const flags of [{}, { FORWARDPASS_WEEKLY_ENABLED: "false" }, { FORWARDPASS_WEEKLY_ENABLED: "yes" }, { FORWARDPASS_WEEKLY_ENABLED: "TRUE" }, { FORWARDPASS_AUTOPUBLISH: "true", FORWARDPASS_SIGNALS_ENABLED: "true", FORWARDPASS_PERSONAL_EDITIONS_ENABLED: "true" }]) {
    const env = makeEnv(flags);
    await worker.default.scheduled(cron("30 7 * * SUN"), env);
    assert.deepEqual([env.WEEKLY.created, env.ISSUE.created, env.COLLECT.created, env.COLLECT_FAST.created], [[], [], [], []], JSON.stringify(flags));
  }
  const on = makeEnv({ FORWARDPASS_WEEKLY_ENABLED: "true" });
  await worker.default.scheduled(cron("30 7 * * SUN"), on);
  assert.deepEqual(on.WEEKLY.created, [{ id: `weekly-${DATE}`, params: { date: DATE, publish: true, deliver: true } }]);
  assert.deepEqual([on.ISSUE.created.length, on.COLLECT.created.length, on.COLLECT_FAST.created.length], [0, 0, 0]);
  await worker.default.scheduled(cron("30 7 * * SUN"), on);
  assert.equal(on.WEEKLY.created.length, 1, "a repeated trigger of the same Sunday is a no-op, not an error");
  for (const expression of ["30 5 * * *", "0 */2 * * *", "*/15 * * * *"]) {
    const env = makeEnv({ FORWARDPASS_WEEKLY_ENABLED: "true", FORWARDPASS_FAST_LANE_ENABLED: "true" });
    await worker.default.scheduled(cron(expression), env);
    assert.equal(env.WEEKLY.created.length, 0, `${expression} does not start it`);
  }
});

test("the weekly workflow reads the signals, and starts delivery only for an edition that is published and asked for", async () => {
  const quiet = makeEnv();
  const none = await runFlow(worker.WeeklyWorkflow, quiet, { date: DATE, publish: true, deliver: true });
  assert.deepEqual([none.published, none.reason, none.delivery], [false, "too few signals", null]);
  assert.ok(quiet.calls.includes("list"), "it reads the week's signals from the signal service");
  const since = (env) => env.invocations.find(({ name }) => name === "list").args[0].since;
  assert.equal(since(quiet), "2026-09-27T07:30:00.000Z", "the fortnight before the moment the workflow started");
  const asOf = makeEnv();
  await runFlow(worker.WeeklyWorkflow, asOf, { date: DATE, publish: false, deliver: false, now: "2026-10-04T07:30:00.000Z" });
  assert.equal(since(asOf), "2026-09-20T07:30:00.000Z", "or before the moment it was asked to be written as of");
  assert.deepEqual(quiet.WEEKLY_DELIVER.created, [], "nothing is delivered when nothing is published");

  const env = makeEnv();
  await publishWeek(env);
  const done = await runFlow(worker.WeeklyWorkflow, env, { date: DATE, publish: true, deliver: true });
  assert.deepEqual([done.published, done.existing, done.delivery], [true, true, `weekly-deliver-${DATE}`]);
  assert.deepEqual(env.WEEKLY_DELIVER.created, [{ id: `weekly-deliver-${DATE}`, params: { date: DATE } }]);
  assert.equal((await runFlow(worker.WeeklyWorkflow, env, { date: DATE, publish: true, deliver: true })).delivery, `weekly-deliver-${DATE}`);
  assert.equal(env.WEEKLY_DELIVER.created.length, 1, "starting it twice is a no-op");

  const held = makeEnv();
  await publishWeek(held);
  assert.equal((await runFlow(worker.WeeklyWorkflow, held, { date: DATE, publish: true, deliver: false })).delivery, null);
  assert.deepEqual(held.WEEKLY_DELIVER.created, [], "published, but nobody asked for it to be sent");
});

test("the weekly delivery workflow sends what is saved for the week, and fails loudly when nothing is", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const names = [];
  const env = makeEnv();
  useStore(r2BindingStore(env.BUCKET));
  await assert.rejects(runFlow(worker.WeeklyDeliveryWorkflow, env, { date: DATE }, names), /No weekly edition saved for 2026-10-11/);
  assert.deepEqual(names, ["edition"], "it asked for the week's edition first");
});

test("personal editions are built only when the owner turned them on", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_SEGMENT_ID = "segment";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ object: "list", data: [], has_more: false });
  try {
    for (const [flags, on] of [[{}, false], [{ FORWARDPASS_PERSONAL_EDITIONS_ENABLED: "false" }, false], [{ FORWARDPASS_PERSONAL_EDITIONS_ENABLED: "yes" }, false], [{ FORWARDPASS_PERSONAL_EDITIONS_ENABLED: "true" }, true]]) {
      const env = makeEnv(flags);
      useStore(r2BindingStore(env.BUCKET));
      await saveIssue({ ...ISSUE, date: DATE });
      const names = [];
      const result = await runFlow(worker.DeliveryWorkflow, env, { date: DATE }, names);
      assert.equal(result.recipients, 0, "no reader in the segment");
      assert.equal(names.includes("pool"), on, `the pool for the editions is built exactly when they are on: ${JSON.stringify(flags)}`);
      assert.equal(env.calls.includes("list"), on, "and it is drawn from the verified signals");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the admin routes start the weekly research and its delivery as asked", async () => {
  const env = makeEnv();
  for (const [path, body] of [["/admin/weekly", {}], ["/admin/weekly-deliver", {}], ["/admin/editions/status"]]) assert.equal((await admin(env, path, body, "wrong".repeat(10))).status, 401, path);

  assert.equal((await admin(env, "/admin/weekly", { date: DATE })).status, 200);
  assert.deepEqual(env.WEEKLY.created.at(-1).params, { date: DATE, publish: false, deliver: false }, "a preview is the default");
  assert.match(env.WEEKLY.created.at(-1).id, /^weekly-2026-10-11-preview-\d+$/);
  await admin(env, "/admin/weekly", { date: DATE, publish: true, deliver: true, now: "2026-10-11T08:00:00.000Z" });
  assert.deepEqual(env.WEEKLY.created.at(-1), { id: `weekly-${DATE}`, params: { date: DATE, publish: true, deliver: true, now: "2026-10-11T08:00:00.000Z" } });
  await admin(env, "/admin/weekly", { date: DATE, publish: true, id: "again" });
  assert.equal(env.WEEKLY.created.at(-1).id, `weekly-${DATE}-again`);
  assert.equal((await admin(env, "/admin/weekly", { date: DATE, deliver: true })).status, 400, "delivering needs publishing");
  for (const bad of [{ date: "tomorrow" }, { publish: "yes" }, { now: "later" }, { id: "Not Valid" }]) assert.equal((await admin(env, "/admin/weekly", bad)).status, 400, JSON.stringify(bad));
  const today = new Date().toISOString().slice(0, 10);
  await admin(env, "/admin/weekly", {});
  assert.equal(env.WEEKLY.created.at(-1).params.date, today, "the day it is asked on, unless told");

  assert.equal((await admin(env, "/admin/weekly-deliver", { date: DATE, test: ["editor@example.com"], topics: ["Retrieval"] })).status, 200);
  assert.deepEqual(env.WEEKLY_DELIVER.created.at(-1).params, { date: DATE, test: ["editor@example.com"], topics: ["Retrieval"] });
  assert.match(env.WEEKLY_DELIVER.created.at(-1).id, /^weekly-deliver-2026-10-11-test-\d+$/, "a preview never takes the real send's id");
  await admin(env, "/admin/weekly-deliver", { date: DATE });
  assert.deepEqual(env.WEEKLY_DELIVER.created.at(-1), { id: `weekly-deliver-${DATE}`, params: { date: DATE } });
  await admin(env, "/admin/weekly-deliver", { date: DATE, id: "retry" });
  assert.equal(env.WEEKLY_DELIVER.created.at(-1).id, `weekly-deliver-${DATE}-retry`);
  const sixth = Array.from({ length: 6 }, (_, i) => `reader${i}@example.com`);
  for (const bad of [{ date: DATE, topics: ["Cooking"] }, { date: DATE, test: ["not an address"] }, { date: DATE, test: sixth }]) assert.equal((await admin(env, "/admin/weekly-deliver", bad)).status, 400, JSON.stringify(bad));

  assert.equal((await admin(env, `/admin/weekly/${env.WEEKLY.created[0].id}`)).status, 200, "a weekly run's status can be read like the others'");
  assert.equal((await admin(env, `/admin/weekly-deliver/${env.WEEKLY_DELIVER.created[0].id}`)).status, 200);
});

test("a preview of a reader's own edition is asked for with a profile and addresses, and is built even while personal editions are off", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.NEWSLETTER_FROM = "The Forward Pass <hello@theforwardpass.net>";
  const env = makeEnv();
  const profile = { firstName: "Ada", topics: ["Security"], content: ["News"], format: "Links only", notes: "skip funding" };
  assert.equal((await admin(env, "/admin/deliver", { date: DATE, test: ["editor@example.com"], profile })).status, 200);
  assert.deepEqual(env.DELIVER.created.at(-1).params, { date: DATE, test: ["editor@example.com"], profile });
  const apart = () => new Promise((resolve) => setTimeout(resolve, 3)); // a preview's id is the millisecond it was asked for
  await apart();
  await admin(env, "/admin/deliver", { date: DATE, test: ["editor@example.com"], profile: { topics: ["Security"] } });
  assert.deepEqual(env.DELIVER.created.at(-1).params.profile, { topics: ["Security"] }, "a profile may name only its topics");
  await apart();
  await admin(env, "/admin/deliver", { date: DATE, test: ["editor@example.com"] });
  assert.equal("profile" in env.DELIVER.created.at(-1).params, false, "and none is none");
  for (const bad of [{ profile }, { test: ["editor@example.com"], profile: { topics: [] } }, { test: ["editor@example.com"], profile: { topics: ["Cooking"] } }, { test: ["editor@example.com"], profile: { topics: ["Security"], format: "Poem" } },
    { test: ["editor@example.com"], profile: { topics: ["Security"], content: ["Gossip"] } }, { test: ["editor@example.com"], profile: { topics: ["Security"], notes: "x".repeat(181) } }, { test: ["editor@example.com"], profile: { topics: ["Security"], unknown: 1 } }]) {
    assert.equal((await admin(env, "/admin/deliver", { date: DATE, ...bad })).status, 400, JSON.stringify(bad).slice(0, 100));
  }

  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }); return Response.json({ id: "email-1" }); };
  try {
    for (const [job, personal] of [[{ date: DATE, test: ["editor@example.com"], profile: { topics: ["Security"] } }, true], [{ date: DATE, test: ["editor@example.com"] }, false]]) {
      const flagOff = makeEnv({ FORWARDPASS_PERSONAL_EDITIONS_ENABLED: "false" });
      useStore(r2BindingStore(flagOff.BUCKET));
      await saveIssue({ ...ISSUE, date: DATE });
      posts.length = 0;
      const result = await runFlow(worker.DeliveryWorkflow, flagOff, job);
      assert.deepEqual([result.recipients, result.sent], [1, 1]);
      assert.equal(flagOff.calls.includes("list"), personal, "the pool is drawn from the signals exactly for a profile");
      const email = posts.find(({ url }) => url.endsWith("/emails"));
      assert.match(email.body.subject, /^\[Preview\] /);
      assert.equal(/Built from your brief/.test(email.body.html), personal, personal ? "it is the reader's own edition" : "it is the shared issue");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the editions status says what is switched on and how the last daily and weekly sends went", async () => {
  const env = makeEnv({ FORWARDPASS_PERSONAL_EDITIONS_ENABLED: "true" });
  const totals = { recipients: 4, sent: 4, alreadySent: 0, skipped: 0, failed: 0, needsReconciliation: 0, personal: 2 };
  env.BUCKET.objects.set(`delivery/${DATE}/status.json`, JSON.stringify({ date: DATE, ...totals, subject: "Today", completedAt: "2026-10-11T06:00:00.000Z" }));
  env.BUCKET.objects.set(`delivery/weekly-${DATE}/status.json`, JSON.stringify({ date: DATE, ...totals, sent: 1, personal: 1, topics: 4, signals: 40, completedAt: "2026-10-11T08:00:00.000Z" }));
  env.BUCKET.objects.set(`weekly/runs/${DATE}.json`, JSON.stringify({ version: 1, now: "2026-10-11T07:30:00.000Z", published: true, topics: 4, overviews: 3, signals: 40, cost: 0.02, evaluator: "judge", usage: [{ step: "weekly", cost: 0.02 }] }));
  env.BUCKET.objects.set(`published/weekly/${DATE}.json`, JSON.stringify({ version: 2, kind: "weekly", date: DATE, publishedAt: "2026-10-11T07:30:00.000Z" }));

  const status = await (await admin(env, `/admin/editions/status?date=${DATE}`)).json();
  assert.deepEqual([status.personalEditionsEnabled, status.weeklyEnabled, status.date], [true, false, DATE]);
  assert.deepEqual(status.daily, { date: DATE, ...totals, subject: "Today", completedAt: "2026-10-11T06:00:00.000Z" });
  assert.deepEqual(status.weekly, {
    date: DATE, published: true,
    run: { at: "2026-10-11T07:30:00.000Z", published: true, topics: 4, overviews: 3, signals: 40, cost: 0.02 },
    delivery: { date: DATE, ...totals, sent: 1, personal: 1, topics: 4, signals: 40, completedAt: "2026-10-11T08:00:00.000Z" },
  }, "a summary, not every model call");

  const monday = await (await admin(env, "/admin/editions/status?date=2026-10-12")).json();
  assert.equal(monday.daily, null, "no daily send that day yet");
  assert.equal(monday.weekly.date, DATE, "the weekly is that of the Sunday before");
  assert.equal(monday.weekly.published, true);

  const empty = await (await admin(makeEnv({ FORWARDPASS_WEEKLY_ENABLED: "true" }), `/admin/editions/status?date=${DATE}`)).json();
  assert.deepEqual([empty.personalEditionsEnabled, empty.weeklyEnabled, empty.daily], [false, true, null]);
  assert.deepEqual(empty.weekly, { date: DATE, published: false, run: null, delivery: null });
  assert.equal((await (await admin(env, "/admin/editions/status?date=soon")).json()).date, new Date().toISOString().slice(0, 10), "a date that is not one is today");
});

const wranglerConfig = () => JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"));

// Cloudflare's cron grammar is not Unix cron's: the day of the week is 1 to 7 or SUN to SAT, and 0 is refused. On 9 October the API
// answered "invalid cron string: 30 7 * * 0 [code: 10100]" after the new version was already live, so the deploy stopped half applied.
function cloudflareCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const spec = [
    [0, 59, []], [0, 23, []], [1, 31, []],
    [1, 12, ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]],
    [1, 7, ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]],
  ];
  return fields.every((field, at) => {
    const [low, high, names] = spec[at];
    const value = (token) => names.includes(token.toUpperCase()) || (/^\d+$/.test(token) && Number(token) >= low && Number(token) <= high);
    return field.split(",").every((part) => {
      const [range, step, ...extra] = part.split("/");
      if (extra.length || (step !== undefined && !/^\d+$/.test(step))) return false;
      return range === "*" || (range.split("-").length <= 2 && range.split("-").every(value));
    });
  });
}

test("every cron wrangler.jsonc declares is one Cloudflare accepts", () => {
  for (const expression of wranglerConfig().triggers.crons) assert.ok(cloudflareCron(expression), `${expression} is not a cron Cloudflare accepts`);
  // The check itself: what the API refused is refused here, and what it takes is taken.
  assert.equal(cloudflareCron("30 7 * * 0"), false, "0 is not a day of the week there");
  assert.equal(cloudflareCron("30 7 * * 8"), false);
  assert.equal(cloudflareCron("60 7 * * SUN"), false);
  assert.equal(cloudflareCron("30 7 * *"), false);
  assert.equal(cloudflareCron("30 7 * * SUN"), true);
  assert.equal(cloudflareCron("30 7 * * 1"), true);
  for (const expression of ["0 */2 * * *", "30 5 * * *", "*/15 * * * *"]) assert.equal(cloudflareCron(expression), true, expression);
});

test("wrangler.jsonc declares the Sunday cron, the two workflows and both flags, off", () => {
  const config = wranglerConfig();
  assert.ok(config.triggers.crons.includes("30 7 * * SUN"));
  assert.ok(config.workflows.some((flow) => flow.binding === "WEEKLY" && flow.class_name === "WeeklyWorkflow"));
  assert.ok(config.workflows.some((flow) => flow.binding === "WEEKLY_DELIVER" && flow.class_name === "WeeklyDeliveryWorkflow"));
  assert.deepEqual([config.vars.FORWARDPASS_WEEKLY_ENABLED, config.vars.FORWARDPASS_PERSONAL_EDITIONS_ENABLED], ["false", "false"], "a deploy changes nothing until the owner turns them on");
});
