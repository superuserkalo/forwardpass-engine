import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { delivery, deliverIssue } from "../src/delivery/deliver.ts";
import { deliverWeekly } from "../src/delivery/weekly.ts";
import { saveIssue } from "../src/lib/issue.ts";
import { createPrivateJson, memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";
import { ISSUE } from "./email-fixture.mjs";
import { PERSONAL, PROFESSIONAL, fakeResend, jsonSteps, reader } from "./delivery-test-support.mjs";
import { EDITION } from "./weekly-fixture.mjs";

// The weekly research goes to Professional readers only, cut to their topics, through the same consent re-check, ledger and idempotency
// as the daily issue, recorded apart from it so the two never collide on the one day they share.
process.env.RESEND_SEGMENT_ID = "segment";
process.env.NEWSLETTER_FROM = "The Forward Pass <hello@theforwardpass.net>";
process.env.PREFERENCES_SIGNING_SECRET = "s".repeat(40);
delivery.pauseMs = 0;
const DATE = "2026-10-11";
const hash = (email) => createHash("sha256").update(email).digest("hex");

async function setup() {
  useStore(memoryStore({}));
  await createPrivateJson(`weekly/${DATE}.json`, EDITION());
}
const run = (contacts, options) => { const { client, sent } = fakeResend(contacts, options); return deliverWeekly(jsonSteps(), { date: DATE }, client).then((result) => ({ result, sent, client })); };
const to = (sent, contact) => sent.find((email) => email.to[0] === contact.email);
const readers = () => ({
  pro: reader(1, PROFESSIONAL({ topics: ["Retrieval"] })),
  proBare: reader(2, { personal_status: "active", personal_plan: "professional" }, { firstName: "Grace" }),
  personal: reader(3, PERSONAL()),
  free: reader(4),
  trial: reader(5, { personal_status: "trial", personal_trial_ends_at: "2026-10-30T00:00:00Z", onboarding_profile: PERSONAL().onboarding_profile }),
  canceled: reader(6, { personal_status: "canceled", personal_plan: "professional", onboarding_profile: PERSONAL().onboarding_profile }),
});

test("only Professional readers get the weekly research, each cut to their own topics, and nobody else is recorded", async () => {
  await setup();
  const r = readers();
  const { result, sent } = await run(Object.values(r));
  assert.deepEqual([result.recipients, result.sent, result.skipped, result.failed, result.personal], [6, 2, 4, 0, 1], "one of the two had topics to cut it to");
  assert.deepEqual(sent.map((email) => email.to[0]).sort(), [r.pro.email, r.proBare.email].sort());
  assert.match(to(sent, r.pro).html, /Hey Ada,/, "the name in their reading profile");
  assert.match(to(sent, r.proBare).html, /Hey Grace,/, "else the name on the contact");
  for (const contact of [r.pro, r.proBare]) assert.match(to(sent, contact).html, /Edit your reading brief/, "the way back to the brief");
  assert.equal((await readPrivateJson(`delivery/weekly-${DATE}/recipients/${hash(r.pro.email)}/sent.json`)).edition, "personal");
  assert.equal((await readPrivateJson(`delivery/weekly-${DATE}/recipients/${hash(r.proBare.email)}/sent.json`)).edition, "shared");
  assert.equal(to(sent, r.pro).subject, "Your week in Retrieval: Pub 1 ships thing 1 for developers");
  assert.match(to(sent, r.pro).html, /Built around your topics: Retrieval/);
  assert.equal(to(sent, r.proBare).subject, "The week in AI engineering: Pub 10 ships thing 10 for developers", "no profile: the week, with the busiest topics");
  assert.match(to(sent, r.proBare).html, />Agents</);
  for (const contact of [r.personal, r.free, r.trial, r.canceled]) {
    assert.equal(await readPrivateJson(`delivery/weekly-${DATE}/recipients/${hash(contact.email)}/sent.json`), null, contact.email);
    assert.equal(await readPrivateJson(`delivery/weekly-${DATE}/recipients/${hash(contact.email)}/attempt.json`), null, "a reader it is not for leaves no attempt");
  }
});

test("every weekly email is sendable as the daily one is: the headers, the AI marking, a key of its own and a ledger of its own", async () => {
  await setup();
  const r = readers();
  const { sent } = await run([r.pro]);
  const email = sent[0];
  assert.match(email.headers["List-Unsubscribe"], /unsubscribe\?email=/);
  assert.equal(email.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(email.headers["X-AI-Generated"], "true");
  assert.equal(email.idempotencyKey, `forwardpass/weekly/${DATE}/${hash(r.pro.email)}`);
  const marker = await readPrivateJson(`delivery/weekly-${DATE}/recipients/${hash(r.pro.email)}/sent.json`);
  assert.deepEqual([marker.edition, typeof marker.resendEmailId], ["personal", "string"]);
  const status = await readPrivateJson(`delivery/weekly-${DATE}/status.json`);
  assert.deepEqual([status.date, status.sent, status.topics, status.signals], [DATE, 1, EDITION().topics.length, EDITION().totals.signals]);
  assert.equal(await readPrivateJson(`delivery/${DATE}/recipients/${hash(r.pro.email)}/sent.json`), null, "nothing in the daily issue's ledger");
});

test("the daily issue and the weekly research on the one day are both sent, each once, and the weekly lists its own audience", async () => {
  await setup();
  await saveIssue({ ...ISSUE, date: DATE });
  const r = readers();
  const { client, sent } = fakeResend([r.pro]);
  const daily = await deliverIssue(jsonSteps(), { date: DATE }, client);
  // Someone joined after the daily issue listed its audience: the weekly research does not reuse that list.
  const joined = reader(10, PROFESSIONAL());
  const { client: later, sent: laterSent } = fakeResend([r.pro, joined]);
  const weekly = await deliverWeekly(jsonSteps(), { date: DATE }, later);
  assert.deepEqual([daily.sent, weekly.sent], [1, 2]);
  assert.deepEqual(laterSent.map((email) => email.to[0]).sort(), [r.pro.email, joined.email].sort());
  assert.equal(new Set([...sent, ...laterSent].map((email) => email.idempotencyKey)).size, 3, "a key for each reader and kind of send");
  const again = await deliverWeekly(jsonSteps(), { date: DATE }, later);
  assert.deepEqual([again.sent, again.alreadySent], [0, 2]);
  assert.equal(laterSent.length, 2, "and nothing twice");
});

test("a reader who has unsubscribed, or is not opted in, is never listed", async () => {
  await setup();
  const r = readers();
  const gone = reader(7, PROFESSIONAL(), { unsubscribed: true });
  const optedOut = reader(8, PROFESSIONAL());
  const { result, sent } = await run([r.pro, gone, optedOut], { optedOut: [optedOut.email] });
  assert.deepEqual([result.recipients, result.sent], [1, 1]);
  assert.deepEqual(sent.map((email) => email.to[0]), [r.pro.email]);
});

test("a reader who unsubscribes after the audience is listed is skipped and recorded, and nothing is attempted for them", async () => {
  await setup();
  const r = readers();
  const leaving = reader(9, PROFESSIONAL());
  const { client, sent } = fakeResend([r.pro, leaving]);
  const get = client.contacts.get;
  client.contacts.get = async (args) => { const found = await get(args); return args.id === leaving.id ? { ...found, data: { ...found.data, unsubscribed: true } } : found; };
  const result = await deliverWeekly(jsonSteps(), { date: DATE }, client);
  assert.deepEqual([result.recipients, result.sent, result.skipped], [2, 1, 1]);
  assert.deepEqual(sent.map((email) => email.to[0]), [r.pro.email]);
  assert.equal((await readPrivateJson(`delivery/weekly-${DATE}/recipients/${hash(leaving.email)}/skipped.json`)).reason, "consent_changed");
  assert.equal(await readPrivateJson(`delivery/weekly-${DATE}/recipients/${hash(leaving.email)}/attempt.json`), null);
});

test("a preview goes to the addresses given, marked as one, cut to the topics asked for, and leaves no ledger", async () => {
  await setup();
  const { client, sent } = fakeResend([]);
  const result = await deliverWeekly(jsonSteps(), { date: DATE, test: ["editor@example.com", "second@example.com"], topics: ["Retrieval"] }, client);
  assert.deepEqual([result.recipients, result.sent], [2, 2]);
  assert.deepEqual(sent.map((email) => email.to[0]), ["editor@example.com", "second@example.com"]);
  assert.equal(sent[0].subject, "[Preview] Your week in Retrieval: Pub 1 ships thing 1 for developers");
  assert.match(sent[0].html, /Built around your topics: Retrieval/);
  assert.equal(sent[0].headers["X-AI-Generated"], "true");
  assert.equal(await readPrivateJson(`delivery/weekly-${DATE}/recipients/${hash("editor@example.com")}/sent.json`), null);
  assert.equal(await readPrivateJson(`delivery/weekly-${DATE}/status.json`), null);
  const { client: plain, sent: plainSent } = fakeResend([]);
  await deliverWeekly(jsonSteps(), { date: DATE, test: ["editor@example.com"] }, plain);
  assert.equal(plainSent[0].subject, "[Preview] The week in AI engineering: Pub 10 ships thing 10 for developers", "with no topics, the busiest");
});

test("a week with no saved edition is an error, not an empty send", async () => {
  useStore(memoryStore({}));
  await assert.rejects(run([readers().pro]), /No weekly edition saved for 2026-10-11/);
});
