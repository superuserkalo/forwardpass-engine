import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stubCloudflareWorkers } from "./cloudflare-workers-stub.mjs";

stubCloudflareWorkers();
const worker = await import("../src/worker.ts");

// The wiring of the watchdog: which crons run it, what it reads, who it writes to, and that it starts nothing. Its checks are in
// watchdog.test.mjs.
const TOKEN = "t".repeat(40);
const MORNING = Date.parse("2026-10-09T08:05:00Z");
const EVENING = Date.parse("2026-10-09T19:05:00Z");

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
  return { created, async create({ id, params }) { created.push({ id, params }); return {}; }, async get() { return { status: async () => ({ status: "running" }) }; } };
}
const makeEnv = (vars = {}) => ({ BUCKET: bucket(), COLLECT: workflow(), COLLECT_FAST: workflow(), ISSUE: workflow(), DELIVER: workflow(), WEEKLY: workflow(), WEEKLY_DELIVER: workflow(), ADMIN_TOKEN: TOKEN, ...vars });
const cron = (expression, at) => ({ cron: expression, scheduledTime: at });
const admin = (env, body, token = TOKEN) => worker.default.fetch(new Request("https://api.test/admin/watchdog", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil() {} });
const started = (env) => [env.COLLECT, env.COLLECT_FAST, env.ISSUE, env.DELIVER, env.WEEKLY, env.WEEKLY_DELIVER].flatMap((flow) => flow.created);

/** Runs a step with the owner's address, the sender and a Resend key set, and Resend's API answered by a stub that remembers what it was sent. */
async function withMail(run, { configured = true } = {}) {
  const saved = Object.fromEntries(["ALERT_EMAIL", "NEWSLETTER_FROM", "RESEND_API_KEY"].map((name) => [name, process.env[name]]));
  const realFetch = globalThis.fetch;
  const sent = [];
  if (configured) Object.assign(process.env, { ALERT_EMAIL: "owner@example.test", NEWSLETTER_FROM: "Forward Pass <hello@example.test>", RESEND_API_KEY: "re_test_key" });
  else { delete process.env.ALERT_EMAIL; process.env.NEWSLETTER_FROM = "Forward Pass <hello@example.test>"; process.env.RESEND_API_KEY = "re_test_key"; }
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.resend.com/")) throw new Error(`unexpected request to ${url}`);
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ id: `email-${sent.length}` });
  };
  try { return await run(sent); } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

test("the morning and evening crons check the pipeline, email the owner what is wrong once a day, and start nothing", async () => {
  await withMail(async (sent) => {
    const env = makeEnv({ FORWARDPASS_AUTOPUBLISH: "true" });
    await worker.default.scheduled(cron("5 8 * * *", MORNING), env);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.resend.com/emails");
    assert.deepEqual(sent[0].body.to, ["owner@example.test"]);
    assert.equal(sent[0].body.from, "Forward Pass <hello@example.test>");
    assert.match(sent[0].body.subject, /^Forward Pass: /);
    assert.match(sent[0].body.text, /No issue for 2026-10-09/, "an empty store has no issue and no collection");
    assert.match(sent[0].body.text, /collection/i);
    assert.deepEqual(started(env), [], "it only looks");
    assert.ok(env.BUCKET.objects.has("watchdog/2026-10-09.json"), "and remembers what it told");

    await worker.default.scheduled(cron("5 19 * * *", EVENING), env);
    assert.equal(sent.length, 1, "the evening run finds the same and says nothing");
  });
});

test("the morning cron reads the gateway balance and emails the owner when it is low", async () => {
  const saved = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "gw_test_key";
  try {
    await withMail(async (sent) => {
      const inner = globalThis.fetch;
      globalThis.fetch = async (url, init) => String(url) === "https://ai-gateway.vercel.sh/v1/credits" ? Response.json({ balance: "1.20", total_used: "43.80" }) : inner(url, init);
      const env = makeEnv({ FORWARDPASS_AUTOPUBLISH: "true" });
      await worker.default.scheduled(cron("5 8 * * *", MORNING), env);
      assert.equal(sent.length, 1);
      assert.match(sent[0].body.subject, /AI Gateway credits/);
      assert.match(sent[0].body.text, /\$1\.20/);
      globalThis.fetch = inner;
    });
  } finally {
    if (saved === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = saved;
  }
});

test("no other cron runs the watchdog, and the watchdog crons run nothing else", async () => {
  await withMail(async (sent) => {
    for (const expression of ["30 5 * * *", "0 */2 * * *", "*/15 * * * *", "30 7 * * SUN"]) {
      const env = makeEnv({ FORWARDPASS_AUTOPUBLISH: "true", FORWARDPASS_FAST_LANE_ENABLED: "true", FORWARDPASS_WEEKLY_ENABLED: "true" });
      await worker.default.scheduled(cron(expression, MORNING), env);
      assert.ok(![...env.BUCKET.objects.keys()].some((key) => key.startsWith("watchdog/")), `${expression} does not check`);
    }
    assert.equal(sent.length, 0);
  });
});

test("with no ALERT_EMAIL it checks, sends nothing and remembers nothing, so setting it later still alerts", async () => {
  await withMail(async (sent) => {
    const env = makeEnv({ FORWARDPASS_AUTOPUBLISH: "true" });
    await worker.default.scheduled(cron("5 8 * * *", MORNING), env);
    assert.equal(sent.length, 0);
    assert.ok(![...env.BUCKET.objects.keys()].some((key) => key.startsWith("watchdog/")));
  }, { configured: false });
});

test("the admin route needs the token, reports what it finds without emailing, and emails only when asked", async () => {
  await withMail(async (sent) => {
    const env = makeEnv({ FORWARDPASS_AUTOPUBLISH: "true" });
    assert.equal((await admin(env, {}, "wrong".repeat(10))).status, 401);
    assert.equal((await admin(env, { notify: "yes" })).status, 400);

    const look = await admin(env, {});
    assert.equal(look.status, 200);
    const report = await look.json();
    assert.ok(report.findings.some((finding) => finding.key === "collection-stalled"), JSON.stringify(report));
    assert.equal(sent.length, 0, "a look is not an alert");

    const tell = await (await admin(env, { notify: true })).json();
    assert.equal(sent.length, 1);
    assert.ok(tell.alerted.length > 0);
    assert.deepEqual(started(env), []);
  });
});

test("the admin route can send a test alert, to show the owner that alerts arrive, without recording anything as told", async () => {
  await withMail(async (sent) => {
    const env = makeEnv({ FORWARDPASS_AUTOPUBLISH: "true" });
    const response = await admin(env, { test: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: true, id: "email-1" });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.to, ["owner@example.test"]);
    assert.match(sent[0].body.subject, /alert test/i);
    assert.match(sent[0].body.text, /alerts reach you/i);
    assert.ok(![...env.BUCKET.objects.keys()].some((key) => key.startsWith("watchdog/")), "a test says nothing about what has been reported");
    assert.deepEqual(started(env), []);
  });
  await withMail(async (sent) => {
    const response = await admin(makeEnv(), { test: true });
    assert.equal(response.status, 503, "with nowhere to send it, it says so instead of pretending");
    assert.equal((await response.json()).sent, false);
    assert.equal(sent.length, 0);
  }, { configured: false });
});

test("wrangler.jsonc runs the watchdog at 08:05 and 19:05 UTC", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"));
  for (const expression of ["5 8 * * *", "5 19 * * *"]) assert.ok(config.triggers.crons.includes(expression), expression);
});
