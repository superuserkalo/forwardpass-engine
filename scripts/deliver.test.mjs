import assert from "node:assert/strict";
import test from "node:test";
import { delivery, deliverIssue } from "../src/delivery/deliver.ts";
import { renderIssueEmail } from "../src/delivery/email.ts";
import { saveIssue } from "../src/lib/issue.ts";
import { memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";
import { buildPool } from "../src/pipeline/personal.ts";
import { ISSUE } from "./email-fixture.mjs";
import { PERSONAL, PROFESSIONAL, fakeResend, jsonSteps, reader } from "./delivery-test-support.mjs";

// Who gets which email. A free reader gets the shared issue exactly as before; a paying reader with a usable profile gets their own
// edition; and building an edition can never stop a send, so anything that goes wrong sends the shared issue instead.
const NOW = new Date("2026-10-08T05:45:00.000Z");
// Trial expiry must use the fixture's clock, even when this suite runs months later.
test.beforeEach((context) => {
  context.mock.method(Date, "now", () => NOW.getTime());
});
process.env.RESEND_SEGMENT_ID = "segment";
process.env.NEWSLETTER_FROM = "The Forward Pass <hello@theforwardpass.net>";
process.env.PREFERENCES_SIGNING_SECRET = "s".repeat(40);
delivery.pauseMs = 0;
const waits = [];
delivery.sleep = async (ms) => { waits.push(ms); };

async function setup() {
  useStore(memoryStore({}));
  await saveIssue(ISSUE);
}
// A preferences link is signed with its own expiry, so it differs every time it is made: the rest of the email is what must match.
const sameButToken = (html) => html.replace(/token=[^"<\s]+/g, "token=T");
const sharedFor = (contact) => renderIssueEmail(ISSUE, { firstName: contact.firstName, unsubscribeUrl: `https://theforwardpass.net/unsubscribe?email=${encodeURIComponent(contact.email)}`, preferencesUrl: "https://theforwardpass.net/preferences/open#token=T" });
const personalDeps = (extra = {}) => ({ personal: { pool: async (issue) => buildPool(issue, [], NOW), brief: async () => ({ boost: [], skip: [] }), now: () => NOW, ...extra } });
const run = (contacts, deps, options) => { const { client, sent } = fakeResend(contacts, options); return deliverIssue(jsonSteps(), { date: "2026-10-08" }, client, deps).then((result) => ({ result, sent })); };
const to = (sent, contact) => sent.find((email) => email.to[0] === contact.email);

test("with no personal editions every reader gets the shared issue, paying or not, exactly as before", async () => {
  await setup();
  const readers = [reader(1), reader(2, PERSONAL()), reader(3, PROFESSIONAL())];
  const { result, sent } = await run(readers, undefined);
  assert.deepEqual([result.recipients, result.sent, result.failed], [3, 3, 0]);
  for (const contact of readers) {
    assert.equal(sameButToken(to(sent, contact).html), sameButToken(sharedFor(contact).html), contact.email);
    assert.equal(sameButToken(to(sent, contact).text), sameButToken(sharedFor(contact).text), contact.email);
    assert.equal(to(sent, contact).subject, ISSUE.subject);
  }
});

test("a paying reader with a profile gets their own edition, a free reader and one with no profile get the shared issue", async () => {
  await setup();
  const free = reader(1);
  const personal = reader(2, PERSONAL());
  const professional = reader(3, PROFESSIONAL({ topics: ["Security"] }));
  const noProfile = reader(4, { personal_status: "active", personal_plan: "personal" });
  const trial = reader(5, { personal_status: "trial", personal_trial_ends_at: "2026-10-20T00:00:00Z", onboarding_profile: PERSONAL().onboarding_profile });
  const expired = reader(6, { personal_status: "trial", personal_trial_ends_at: "2026-10-01T00:00:00Z", onboarding_profile: PERSONAL().onboarding_profile });
  const canceled = reader(7, { personal_status: "canceled", personal_plan: "personal", onboarding_profile: PERSONAL().onboarding_profile });
  const { result, sent } = await run([free, personal, professional, noProfile, trial, expired, canceled], personalDeps());
  assert.deepEqual([result.recipients, result.sent, result.personal], [7, 7, 3], "three personal editions: personal, professional and the trial");
  for (const contact of [personal, professional, trial]) {
    assert.match(to(sent, contact).html, /Built from your brief/, contact.email);
    assert.match(to(sent, contact).html, /Your daily AI-generated issue/);
  }
  for (const contact of [free, noProfile, expired, canceled]) {
    assert.doesNotMatch(to(sent, contact).html, /Built from your brief/, contact.email);
    assert.equal(to(sent, contact).subject, ISSUE.subject, "the shared issue's subject");
  }
  assert.match(to(sent, personal).html, /Hey Ada,/, "the name the reader gave in their profile");
  assert.equal(to(sent, professional).subject, "Databricks makes on-behalf-of-user authorization generally available", "the subject is the top item of their own edition");
  assert.match(to(sent, professional).html, /Topics: Security/, "each reader's own topics");
  assert.match(to(sent, personal).html, /Topics: Agents/);
});

test("a reader who allows nothing in the pool gets the shared issue, which is not a failure and is not recorded as one", async () => {
  await setup();
  const contact = reader(1, PERSONAL({ content: ["Papers"] }));
  const { result, sent } = await run([contact], personalDeps());
  assert.deepEqual([result.sent, result.personal], [1, 0]);
  assert.equal(to(sent, contact).subject, ISSUE.subject);
  const marker = await readPrivateJson(`delivery/2026-10-08/recipients/${(await import("node:crypto")).createHash("sha256").update(contact.email).digest("hex")}/sent.json`);
  assert.deepEqual([marker.edition, "fallback" in marker], ["shared", false]);
});

test("a profile with no usable name greets the reader by the name on their contact", async () => {
  await setup();
  const contact = reader(1, PERSONAL({ firstName: "<b>" }), { firstName: "Grace" });
  const { sent } = await run([contact], personalDeps());
  assert.match(to(sent, contact).html, /Hey Grace,/);
});

test("every email still carries what makes it sendable: the unsubscribe headers, the AI marking and the idempotency key", async () => {
  await setup();
  const { sent } = await run([reader(1), reader(2, PERSONAL())], personalDeps());
  for (const email of sent) {
    assert.match(email.headers["List-Unsubscribe"], /unsubscribe\?email=/);
    assert.equal(email.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.equal(email.headers["X-AI-Generated"], "true");
    assert.match(email.idempotencyKey, /^forwardpass\/daily\/2026-10-08\//);
    assert.equal(email.from, process.env.NEWSLETTER_FROM);
  }
  assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
});

test("what the reader asked to skip is skipped, using the brief compiled from their note", async () => {
  await setup();
  const contact = reader(1, PERSONAL({ topics: ["Agents", "Security"], notes: "skip security news" }));
  const { sent } = await run([contact], personalDeps({ brief: async (notes) => { assert.equal(notes, "skip security news"); return { boost: [], skip: ["databricks"] }; } }));
  assert.doesNotMatch(to(sent, contact).html, /Databricks/);
  await setup();
  const { sent: without } = await run([reader(2, PERSONAL({ topics: ["Agents", "Security"] }))], personalDeps());
  assert.match(to(without, reader(2)).html, /Databricks/, "the same item for a reader who did not skip it");
});

test("anything that goes wrong building an edition sends the shared issue instead, and the ledger says so", async () => {
  await setup();
  const contacts = [reader(1, PERSONAL()), reader(2, PERSONAL())];
  const { result, sent } = await run(contacts, personalDeps({ brief: async () => { throw new Error("gateway down"); } }));
  assert.deepEqual([result.sent, result.failed, result.personal], [2, 0, 0], "both sent, neither personal");
  for (const contact of contacts) assert.equal(to(sent, contact).subject, ISSUE.subject);
  const marker = await readPrivateJson(`delivery/2026-10-08/recipients/${(await import("node:crypto")).createHash("sha256").update(contacts[0].email).digest("hex")}/sent.json`);
  assert.deepEqual([marker.edition, marker.fallback], ["shared", "gateway down"]);
});

test("a pool that cannot be built, or is empty, leaves every reader on the shared issue and does not stop the run", async () => {
  for (const pool of [async () => { throw new Error("signals unavailable"); }, async () => []]) {
    await setup();
    const { result, sent } = await run([reader(1, PERSONAL()), reader(2)], personalDeps({ pool }));
    assert.deepEqual([result.sent, result.failed, result.personal], [2, 0, 0]);
    assert.ok(sent.every((email) => email.subject === ISSUE.subject));
  }
});

test("the pool is built once for the run, however many readers and pages there are", async () => {
  await setup();
  let built = 0;
  const contacts = Array.from({ length: 205 }, (_, i) => reader(i + 1, i % 2 ? PERSONAL() : {}));
  const { result } = await run(contacts, personalDeps({ pool: async (issue) => { built++; return buildPool(issue, [], NOW); } }));
  assert.equal(built, 1);
  assert.deepEqual([result.recipients, result.sent, result.personal], [205, 205, 102]);
});

test("a second run sends nothing twice, and a reader who unsubscribed meanwhile is skipped", async () => {
  await setup();
  const contacts = [reader(1, PERSONAL()), reader(2, PERSONAL(), { unsubscribed: true }), reader(3)];
  const first = await run(contacts, personalDeps());
  assert.deepEqual([first.result.sent, first.result.recipients], [2, 2]);
  const { client, sent } = fakeResend(contacts);
  const second = await deliverIssue(jsonSteps(), { date: "2026-10-08" }, client, personalDeps());
  assert.deepEqual([second.sent, second.alreadySent], [0, 2]);
  assert.equal(sent.length, 0);
});

test("a preview to given addresses is the shared issue, marked as a preview", async () => {
  await setup();
  const { client, sent } = fakeResend([]);
  await deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com"] }, client, personalDeps());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, `[Preview] ${ISSUE.subject}`);
  assert.doesNotMatch(sent[0].html, /Built from your brief/);
});

// ---- a preview of a reader's own edition

test("a preview for a profile is the reader's own edition for it, marked as a preview, sent to the addresses given, with no ledger", async () => {
  await setup();
  const { client, sent } = fakeResend([]);
  const profile = { firstName: "Ada", topics: ["Security"], content: ["News", "Models", "Repos"], format: "Briefing", notes: "" };
  const result = await deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com", "second@example.com"], profile }, client, personalDeps());
  assert.deepEqual([result.recipients, result.sent], [2, 2]);
  assert.deepEqual(sent.map((email) => email.to[0]), ["editor@example.com", "second@example.com"]);
  assert.equal(sent[0].subject, "[Preview] Databricks makes on-behalf-of-user authorization generally available", "the best match for the profile, not the issue's subject");
  assert.match(sent[0].html, /Built from your brief/);
  assert.match(sent[0].html, /Topics: Security/);
  assert.match(sent[0].html, /Hey Ada,/);
  assert.doesNotMatch(sent[0].html, /Edit your reading brief/, "a preview has no brief to edit");
  assert.equal(sent[0].headers["X-AI-Generated"], "true");
  assert.equal(await readPrivateJson(`delivery/2026-10-08/recipients/${(await import("node:crypto")).createHash("sha256").update("editor@example.com").digest("hex")}/sent.json`), null, "no ledger");
  assert.equal(await readPrivateJson("delivery/2026-10-08/status.json"), null);

  const links = await deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com"], profile: { ...profile, format: "Links only" } }, fakeResend([]).client, personalDeps());
  assert.equal(links.sent, 1);
  let poolAt = null;
  await deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com"], profile }, fakeResend([]).client, personalDeps({ pool: async (issue, at) => { poolAt = at; return buildPool(issue, [], NOW); } }));
  assert.equal(poolAt.toISOString(), NOW.toISOString(), "the pool is drawn as of the clock the edition is built by");
  const { client: noted, sent: notedSent } = fakeResend([]);
  await deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com"], profile: { ...profile, topics: ["Agents", "Security"], notes: "skip security news" } }, noted, personalDeps({ brief: async (notes) => { assert.equal(notes, "skip security news"); return { boost: [], skip: ["databricks"] }; } }));
  assert.doesNotMatch(notedSent[0].html, /Databricks/, "the note is compiled and applied as it is for a reader");
});

test("a preview with no profile is still the shared issue, and a preview for a profile that matches nothing, or with nothing to build it from, says so", async () => {
  await setup();
  const { client, sent } = fakeResend([]);
  await deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com"] }, client, personalDeps());
  assert.equal(sent[0].subject, `[Preview] ${ISSUE.subject}`);
  const profile = { topics: ["Security"], content: ["Papers"], format: "Briefing", notes: "" };
  await assert.rejects(deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com"], profile }, fakeResend([]).client, personalDeps()), /matches nothing/i);
  await assert.rejects(deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com"], profile: { topics: ["Security"] } }, fakeResend([]).client), /needs the pool/i, "without the means to build an edition");
  const { client: defaults, sent: defaulted } = fakeResend([]);
  await deliverIssue(jsonSteps(), { date: "2026-10-08", test: ["editor@example.com"], profile: { topics: ["Security"] } }, defaults, personalDeps());
  assert.match(defaulted[0].html, /Includes: News, Papers, Models, Repos/, "a profile that names only topics reads everything, as a reader's does");
  assert.match(defaulted[0].html, /Format: Briefing/);
});

// ---- Resend's rate limit

/** A Resend method that answers with an error for its first `times` calls, then as it would. Returns how many calls were made. */
function failing(client, path, times, error = { name: "rate_limit_exceeded", statusCode: 429, message: "Too many requests" }, headers = { "retry-after": "1" }) {
  const parts = path.split(".");
  const owner = parts.slice(0, -1).reduce((object, key) => object[key], client);
  const original = owner[parts.at(-1)];
  let left = times, calls = 0;
  owner[parts.at(-1)] = async (...args) => { calls++; if (left-- > 0) return { data: null, error, headers }; return original(...args); };
  return () => calls;
}
const runWith = async (contacts, prepare) => {
  await setup();
  waits.length = 0;
  const { client, sent } = fakeResend(contacts);
  const calls = prepare(client);
  const result = await deliverIssue(jsonSteps(), { date: "2026-10-08" }, client, personalDeps());
  return { result, sent, calls, waits: [...waits] };
};

test("a rate limit from Resend is waited out for as long as it asks and the call is tried again, whichever of the four calls it hits", async () => {
  for (const path of ["contacts.list", "contacts.topics.list", "contacts.get", "emails.send"]) {
    const { result, sent, calls, waits: slept } = await runWith([reader(1, PERSONAL())], (client) => failing(client, path, 2));
    assert.deepEqual([result.sent, result.failed, result.recipients], [1, 0, 1], path);
    assert.equal(sent.length, 1, `${path}: one email, however many times it was asked for`);
    assert.ok(calls() >= 3, `${path}: tried again`);
    assert.deepEqual(slept.filter((ms) => ms === 1000), [1000, 1000], `${path}: it waited the second Resend asked for, each time`);
  }
});

test("with no time given it backs off, and what it is told is capped so a step is never held for an hour", async () => {
  const none = await runWith([reader(1)], (client) => failing(client, "emails.send", 3, undefined, {}));
  assert.deepEqual(none.waits.filter((ms) => ms >= 1000), [1000, 2000, 4000], "twice as long each time");
  assert.equal(none.result.sent, 1);
  const huge = await runWith([reader(1)], (client) => failing(client, "emails.send", 1, undefined, { "retry-after": "3600" }));
  assert.deepEqual(huge.waits.filter((ms) => ms > 600), [30_000]);
  const odd = await runWith([reader(1)], (client) => failing(client, "emails.send", 1, undefined, { "retry-after": "soon" }));
  assert.deepEqual(odd.waits.filter((ms) => ms > 600), [1000], "a time that is not a number is no time");
});

test("a limit that does not lift is given up on after three more tries, and the reader is recorded as failed with what Resend said", async () => {
  const { result, calls } = await runWith([reader(1)], (client) => failing(client, "emails.send", 99));
  assert.deepEqual([result.sent, result.failed], [0, 1]);
  assert.equal(calls(), 4, "the call and three more");
  const marker = await readPrivateJson(`delivery/2026-10-08/recipients/${(await import("node:crypto")).createHash("sha256").update(reader(1).email).digest("hex")}/failed.json`);
  assert.equal(marker.error, "Too many requests");
  await assert.rejects(runWith([reader(1)], (client) => failing(client, "contacts.get", 99)), /Could not recheck contact: Too many requests/, "a check that cannot be made stops the page, which Workflows tries again");
});

test("a quota is not a rate: it is not waited out, and it is not retried", async () => {
  for (const name of ["daily_quota_exceeded", "monthly_quota_exceeded"]) {
    const { result, calls, waits: slept } = await runWith([reader(1)], (client) => failing(client, "emails.send", 99, { name, statusCode: 429, message: "Quota reached" }));
    assert.deepEqual([result.sent, result.failed], [0, 1], name);
    assert.equal(calls(), 1, `${name}: asked once`);
    assert.deepEqual(slept.filter((ms) => ms >= 1000), [], `${name}: nothing waited for`);
  }
});

test("the same email is asked for again with the same idempotency key, so a retry cannot send it twice", async () => {
  await setup();
  const { client } = fakeResend([reader(1)]);
  const keys = [];
  const send = client.emails.send;
  let left = 2;
  client.emails.send = async (payload, config) => { keys.push(config?.idempotencyKey); if (left-- > 0) return { data: null, error: { name: "rate_limit_exceeded", statusCode: 429, message: "x" }, headers: { "retry-after": "0" } }; return send(payload, config); };
  await deliverIssue(jsonSteps(), { date: "2026-10-08" }, client, personalDeps());
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 1);
});
