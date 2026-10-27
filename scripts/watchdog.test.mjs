import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateJson, memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";
import { checkHealth, gatewayBalance, ownerAlert, watch } from "../src/lib/watchdog.ts";

// On 8 and 9 October no issue was written and nobody was told: the owner found out from the missing email. The watchdog looks at what
// the pipeline leaves in storage (the last collection, the day's issue, the record of its delivery) and says so by email, once a day
// for each problem, when something that should be there is not.
const DATE = "2026-10-09";
const at = (time) => new Date(`${DATE}T${time}:00Z`);
const MORNING = at("08:05");
const delivery = (over = {}) => ({ date: DATE, recipients: 19, sent: 19, alreadySent: 0, skipped: 0, failed: 0, needsReconciliation: 0, personal: 0, subject: "x", ...over });

async function healthy(extra = {}) {
  useStore(memoryStore());
  await createPrivateJson(`collection/runs/${DATE}/06.json`, { collectedAt: `${DATE}T06:00:00Z`, items: [] });
  await createPrivateJson(`published/daily/${DATE}.json`, { version: 2, publishedAt: `${DATE}T05:41:00Z` });
  await createPrivateJson(`delivery/${DATE}/status.json`, delivery());
  for (const [key, value] of Object.entries(extra)) await createPrivateJson(key, value);
}

const keys = (findings) => findings.map((finding) => finding.key);

test("a day on which everything ran is quiet", async () => {
  await healthy();
  assert.deepEqual(await checkHealth({ now: MORNING, autopublish: true }), []);
});

test("a collection that stopped is reported with when the last one was saved", async () => {
  useStore(memoryStore());
  await createPrivateJson("collection/runs/2026-10-08/02.json", { collectedAt: "2026-10-08T02:00:00Z", items: [] });
  await createPrivateJson("collection/runs/2026-10-07/22.json", { collectedAt: "2026-10-07T22:00:00Z", items: [] });
  const findings = await checkHealth({ now: at("16:30"), autopublish: true });
  const stalled = findings.find((finding) => finding.key === "collection-stalled");
  assert.ok(stalled, JSON.stringify(findings));
  assert.match(stalled.detail, /2026-10-08 02:00 UTC/, "the newest snapshot is named, not an older one");
  assert.match(stalled.detail, /38 hours/);
  assert.ok(stalled.title.length < 60, "short enough for a subject line");

  useStore(memoryStore());
  assert.ok(keys(await checkHealth({ now: at("16:30"), autopublish: false })).includes("collection-stalled"), "no snapshot at all is the same problem");
});

test("a collection that missed one run is not yet a problem, one that is older than five hours is", async () => {
  for (const [hour, stalled] of [["06", false], ["04", false], ["03", true], ["02", true]]) {
    useStore(memoryStore());
    await createPrivateJson(`collection/runs/${DATE}/${hour}.json`, { collectedAt: `${DATE}T${hour}:00:00Z`, items: [] });
    const found = keys(await checkHealth({ now: at("08:05"), autopublish: false })).includes("collection-stalled");
    assert.equal(found, stalled, `the last snapshot was at ${hour}:00 and it is 08:05`);
  }
});

test("a missing issue is reported once it is due, and not before", async () => {
  useStore(memoryStore());
  await createPrivateJson(`collection/runs/${DATE}/06.json`, { collectedAt: `${DATE}T06:00:00Z`, items: [] });
  assert.deepEqual(keys(await checkHealth({ now: at("06:29"), autopublish: true })), [], "the workflow started at 05:30 and has until 06:30");
  const findings = await checkHealth({ now: at("06:31"), autopublish: true });
  assert.deepEqual(keys(findings), ["issue-missing"]);
  assert.match(findings[0].detail, /2026-10-09/);
  assert.match(findings[0].detail, /forwardpass-issue issue-2026-10-09/, "it says where to look");
  assert.match(findings[0].detail, /"id":"retry"/, "and how to run it again, which needs an id because the failed instance keeps its own");
});

test("with autopublish off the issue only has to exist, and with it on it has to be published", async () => {
  useStore(memoryStore());
  await createPrivateJson(`collection/runs/${DATE}/06.json`, { collectedAt: `${DATE}T06:00:00Z`, items: [] });
  await createPrivateJson(`issues/${DATE}.json`, { version: 2, date: DATE });
  assert.deepEqual(keys(await checkHealth({ now: MORNING, autopublish: false })), [], "a held draft is what that setting asks for");
  assert.deepEqual(keys(await checkHealth({ now: MORNING, autopublish: true })), ["issue-missing"], "but it is not published");
});

test("a published issue with no record of being sent is reported once delivery is due", async () => {
  useStore(memoryStore());
  await createPrivateJson(`collection/runs/${DATE}/06.json`, { collectedAt: `${DATE}T06:00:00Z`, items: [] });
  await createPrivateJson(`published/daily/${DATE}.json`, { version: 2, publishedAt: `${DATE}T05:41:00Z` });
  assert.deepEqual(keys(await checkHealth({ now: at("07:29"), autopublish: true })), [], "delivery starts when the issue is published and has an hour");
  assert.deepEqual(keys(await checkHealth({ now: at("07:31"), autopublish: true })), ["delivery-missing"]);
  assert.ok(!keys(await checkHealth({ now: at("07:31"), autopublish: false })).includes("delivery-missing"), "nothing is sent when autopublish is off, so nothing is missing");
});

test("a delivery that failed for some readers is reported with how many", async () => {
  for (const [over, expected] of [[{ failed: 3 }, /3 of 19/], [{ needsReconciliation: 2 }, /2 .*checked/]]) {
    useStore(memoryStore({
      [`collection/runs/${DATE}/06.json`]: { collectedAt: `${DATE}T06:00:00Z`, items: [] },
      [`published/daily/${DATE}.json`]: { version: 2, publishedAt: `${DATE}T05:41:00Z` },
      [`delivery/${DATE}/status.json`]: delivery(over),
    }));
    const findings = await checkHealth({ now: MORNING, autopublish: true });
    assert.deepEqual(keys(findings), ["delivery-failed"], JSON.stringify(over));
    assert.match(findings[0].detail, expected);
  }
});

// On 9 October the AI Gateway's prepaid balance ran out ($45.00 used, -$0.02 left): every model call was refused, and the issue would have failed
// the next morning with nothing to say why. The watchdog reads the balance, and says so while there are days left.
test("a low or used-up gateway balance is reported with how long it lasts, and a healthy or unreadable one is not", async () => {
  await healthy();
  assert.deepEqual(await checkHealth({ now: MORNING, autopublish: true, credits: async () => 40.25 }), [], "plenty left");
  assert.deepEqual(await checkHealth({ now: MORNING, autopublish: true, credits: async () => null }), [], "a balance that cannot be read is not an alarm");
  assert.deepEqual(await checkHealth({ now: MORNING, autopublish: true, credits: async () => { throw new Error("gateway unreachable"); } }), [], "nor is one that throws");
  const low = await checkHealth({ now: MORNING, autopublish: true, credits: async () => 2.8 });
  assert.deepEqual(keys(low), ["gateway-credits-low"]);
  assert.match(low[0].title, /credits are low/i);
  assert.match(low[0].detail, /\$2\.80/);
  assert.match(low[0].detail, /about 9 days/, "at about thirty cents an issue");
  assert.match(low[0].detail, /AI Gateway/);
  const empty = await checkHealth({ now: MORNING, autopublish: true, credits: async () => -0.017 });
  assert.deepEqual(keys(empty), ["gateway-credits-low"]);
  assert.match(empty[0].title, /used up/i);
  assert.match(empty[0].detail, /no model call will run|every model call/i);
  // Without a way to read it the check is simply not made.
  assert.deepEqual(await checkHealth({ now: MORNING, autopublish: true }), []);
});

test("a low balance is emailed once a day with the other problems", async () => {
  await healthy();
  const sent = [];
  const alert = async (subject, text) => { sent.push({ subject, text }); };
  await watch({ now: MORNING, autopublish: true, alert, credits: async () => 1.9 });
  await createPrivateJson(`collection/runs/${DATE}/18.json`, { collectedAt: `${DATE}T18:00:00Z`, items: [] }); // the day's collections went on
  await watch({ now: at("19:05"), autopublish: true, alert, credits: async () => 1.9 });
  assert.equal(sent.length, 1, "the same low balance is not told twice in a day");
  assert.match(sent[0].subject, /credits/i);
});

test("each problem is emailed once a day, and a new one is emailed when it appears", async () => {
  useStore(memoryStore());
  await createPrivateJson("collection/runs/2026-10-08/02.json", { collectedAt: "2026-10-08T02:00:00Z", items: [] });
  const sent = [];
  const alert = async (subject, text) => { sent.push({ subject, text }); };

  const first = await watch({ now: MORNING, autopublish: true, alert });
  assert.deepEqual(keys(first.findings).sort(), ["collection-stalled", "issue-missing"]);
  assert.equal(sent.length, 1, "one email for the two problems, not two");
  assert.match(sent[0].subject, /^Forward Pass: /);
  assert.match(sent[0].text, /2026-10-08 02:00 UTC/);
  assert.match(sent[0].text, /No issue/);

  await watch({ now: at("19:05"), autopublish: true, alert });
  assert.equal(sent.length, 1, "the evening run finds the same two and says nothing");

  // The issue comes out, then its delivery fails: that is new, and only that is in the second email.
  await createPrivateJson(`published/daily/${DATE}.json`, { version: 2, publishedAt: `${DATE}T12:00:00Z` });
  await createPrivateJson(`delivery/${DATE}/status.json`, delivery({ failed: 4 }));
  await watch({ now: at("19:10"), autopublish: true, alert });
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /4 of 19/);
  assert.doesNotMatch(sent[1].text, /2026-10-08 02:00/, "a problem already reported is not repeated");

  const next = await watch({ now: new Date("2026-10-10T08:05:00Z"), autopublish: true, alert });
  assert.ok(next.findings.length > 0);
  assert.equal(sent.length, 3, "the next day it is told again, because it is still true");
});

test("a failed send is not recorded as sent, so the next run tries again, and it does not throw", async () => {
  useStore(memoryStore());
  let attempts = 0;
  const alert = async () => { attempts++; if (attempts === 1) throw new Error("Resend is down"); };
  const first = await watch({ now: MORNING, autopublish: true, alert });
  assert.match(first.error ?? "", /Resend is down/);
  assert.equal(await readPrivateJson(`watchdog/${DATE}.json`), null);
  const second = await watch({ now: at("19:05"), autopublish: true, alert });
  assert.equal(second.error, undefined);
  assert.equal(attempts, 2);
});

test("with nowhere to send an alert the findings are still returned, and nothing is marked as told", async () => {
  useStore(memoryStore());
  const result = await watch({ now: MORNING, autopublish: true });
  assert.ok(result.findings.length > 0);
  assert.equal(await readPrivateJson(`watchdog/${DATE}.json`), null, "so that setting the address later still gets the alert");
});

test("the owner's alert goes to the address in ALERT_EMAIL from the newsletter's sender, and only when both are set", async () => {
  const saved = { to: process.env.ALERT_EMAIL, from: process.env.NEWSLETTER_FROM };
  try {
    const calls = [];
    const client = { emails: { send: async (message) => { calls.push(message); return { data: { id: "e1" }, error: null }; } } };
    delete process.env.ALERT_EMAIL; process.env.NEWSLETTER_FROM = "Forward Pass <hello@example.test>";
    assert.equal(ownerAlert(client), undefined);
    process.env.ALERT_EMAIL = "owner@example.test"; delete process.env.NEWSLETTER_FROM;
    assert.equal(ownerAlert(client), undefined);
    process.env.NEWSLETTER_FROM = "Forward Pass <hello@example.test>";
    assert.equal(await ownerAlert(client)("Forward Pass: No issue for 9 October", "text"), "e1", "it hands back the id the mail service gave the message");
    assert.deepEqual(calls, [{ from: "Forward Pass <hello@example.test>", to: ["owner@example.test"], subject: "Forward Pass: No issue for 9 October", text: "text" }]);
    const refusing = { emails: { send: async () => ({ data: null, error: { message: "domain not verified" } }) } };
    await assert.rejects(ownerAlert(refusing)("s", "t"), /domain not verified/);
  } finally {
    for (const [name, value] of [["ALERT_EMAIL", saved.to], ["NEWSLETTER_FROM", saved.from]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test("the gateway balance is read from the credits endpoint with the key, and anything unreadable is null", async () => {
  const saved = { key: process.env.AI_GATEWAY_API_KEY, fetch: globalThis.fetch };
  const requests = [];
  try {
    delete process.env.AI_GATEWAY_API_KEY;
    assert.equal(await gatewayBalance(), null, "no key, no request");
    process.env.AI_GATEWAY_API_KEY = "gw_test_key";
    globalThis.fetch = async (url, init) => { requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") }); return Response.json({ balance: "-0.01714324", total_used: "45.00000179" }); };
    assert.equal(await gatewayBalance(), -0.01714324);
    assert.deepEqual(requests, [{ url: "https://ai-gateway.vercel.sh/v1/credits", auth: "Bearer gw_test_key" }]);
    globalThis.fetch = async () => new Response("nope", { status: 401 });
    assert.equal(await gatewayBalance(), null);
    globalThis.fetch = async () => Response.json({ balance: "soon" });
    assert.equal(await gatewayBalance(), null);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await gatewayBalance(), null);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = saved.key;
  }
});
