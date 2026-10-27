import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { delivery } from "../src/delivery/deliver.ts";
import { deliverWeekly } from "../src/delivery/weekly.ts";
import { deliverWeeklyCompute } from "../src/delivery/weekly-compute.ts";
import { renderComputeWeeklyEmail } from "../src/delivery/weekly-compute-email.ts";
import { createPrivateJson, memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";
import { PERSONAL, PROFESSIONAL, fakeResend, jsonSteps, reader } from "./delivery-test-support.mjs";
import { EDITION as WEEKLY } from "./weekly-fixture.mjs";
import { EDITION } from "./weekly-compute-fixture.mjs";

// The Compute report goes to Professional readers who follow Chips or Data centers, through the same consent re-check, ledger and idempotency as every
// other send, recorded apart from the weekly research on the day they share.
process.env.RESEND_SEGMENT_ID = "segment";
process.env.NEWSLETTER_FROM = "The Forward Pass <hello@theforwardpass.net>";
process.env.PREFERENCES_SIGNING_SECRET = "s".repeat(40);
delivery.pauseMs = 0;
const DATE = "2026-10-11";
const hash = (email) => createHash("sha256").update(email).digest("hex");
const CTX = { firstName: "Ada", unsubscribeUrl: "https://theforwardpass.net/unsubscribe?x=1", preferencesUrl: "https://theforwardpass.net/preferences?x=1" };

async function setup() { useStore(memoryStore({})); await createPrivateJson(`weekly-compute/${DATE}.json`, EDITION()); }
const run = (contacts, options) => { const { client, sent } = fakeResend(contacts, options); return deliverWeeklyCompute(jsonSteps(), { date: DATE }, client).then((result) => ({ result, sent, client })); };
const readers = () => ({
  chips: reader(1, PROFESSIONAL({ topics: ["Chips", "Agents"] })),
  centers: reader(2, PROFESSIONAL({ topics: ["Data centers"] })),
  other: reader(3, PROFESSIONAL({ topics: ["Retrieval"] })),
  bare: reader(4, { personal_status: "active", personal_plan: "professional" }),
  personal: reader(5, PERSONAL({ topics: ["Chips"] })),
  free: reader(6),
});

test("the email says where each claim comes from, shows the figures with their quotes, and prints nothing a feed wrote as markup", () => {
  const { html, text, subject } = renderComputeWeeklyEmail(EDITION(), CTX);
  assert.match(subject, /^The week in AI compute: /);
  for (const part of ["Top of the week", "By the numbers", "Chips", "On the radar"]) assert.ok(html.includes(part), part);
  assert.ok(html.includes("Official · maker0.test") && html.includes("Reported · ctee.com.tw · translated from Chinese"));
  assert.match(html, /Hey Ada,/);
  assert.match(html, /Edit your reading brief/);
  assert.match(html, /AI-generated/i);
  assert.match(text, /TOP OF THE WEEK/);
  assert.ok(text.includes(`“${EDITION().numbers[0].quote}”`), "a figure beside the quote it rests on");
  const hostile = EDITION();
  hostile.top[0] = { ...hostile.top[0], headline: "<script>alert(1)</script> & \"quotes\"", url: "https://pub.test/a?x=1&y=2" };
  hostile.radar[0] = { ...hostile.radar[0], title: "Radar <img src=x onerror=alert(1)>" };
  const evil = renderComputeWeeklyEmail(hostile, CTX);
  assert.doesNotMatch(evil.html, /<script>|<img src=x/);
  assert.ok(evil.html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;"));
  assert.ok(!/href="(?!https:\/\/)/.test(evil.html.replace(/href="mailto:[^"]*"/g, "")), "every link is a secure address");
  const odd = EDITION(); odd.top[0] = { ...odd.top[0], url: "https://pub.test/x" };
  odd.top[0].url = "https://pub.test/x";
  assert.doesNotMatch(renderComputeWeeklyEmail(odd, CTX).html, /javascript:/);
});

test("a story is shown once: not again in an area if the top showed it", () => {
  const { html } = renderComputeWeeklyEmail(EDITION(), CTX);
  const links = (headline) => html.split(`>${headline}</a>`).length - 1;
  for (const { headline } of EDITION().top) assert.ok(links(headline) <= 1 + EDITION().numbers.filter((n) => n.headline === headline).length, headline);
  assert.equal(links(EDITION().top[0].headline), 1 + EDITION().numbers.filter((n) => n.headline === EDITION().top[0].headline).length, "once among the stories, and again only beside its figures");
});

test("only Professional readers who follow Chips or Data centers get it, and nobody else is recorded", async () => {
  await setup();
  const r = readers();
  const { result, sent } = await run(Object.values(r));
  assert.deepEqual([result.recipients, result.sent, result.skipped, result.failed], [6, 2, 4, 0]);
  assert.deepEqual(sent.map((email) => email.to[0]).sort(), [r.chips.email, r.centers.email].sort());
  for (const contact of [r.other, r.bare, r.personal, r.free]) {
    assert.equal(await readPrivateJson(`delivery/weekly-compute-${DATE}/recipients/${hash(contact.email)}/sent.json`), null, contact.email);
    assert.equal(await readPrivateJson(`delivery/weekly-compute-${DATE}/recipients/${hash(contact.email)}/attempt.json`), null, "a reader it is not for leaves no attempt");
  }
  const email = sent[0];
  assert.equal(email.headers["X-AI-Generated"], "true");
  assert.match(email.headers["List-Unsubscribe"], /unsubscribe\?email=/);
  assert.equal(email.idempotencyKey, `forwardpass/weekly-compute/${DATE}/${hash(email.to[0])}`);
  const status = await readPrivateJson(`delivery/weekly-compute-${DATE}/status.json`);
  assert.deepEqual([status.date, status.sent, status.stories], [DATE, 2, EDITION().totals.stories]);
});

test("the weekly research and the Compute report on the one Sunday are both sent, each once, with keys and ledgers of their own", async () => {
  await setup();
  await createPrivateJson(`weekly/${DATE}.json`, WEEKLY());
  const r = readers();
  const { client, sent } = fakeResend([r.chips]);
  await deliverWeekly(jsonSteps(), { date: DATE }, client);
  const compute = await deliverWeeklyCompute(jsonSteps(), { date: DATE }, client);
  assert.equal(compute.sent, 1);
  assert.equal(sent.length, 2);
  assert.equal(new Set(sent.map((email) => email.idempotencyKey)).size, 2, "Resend would otherwise take the second for the first");
  const again = await deliverWeeklyCompute(jsonSteps(), { date: DATE }, client);
  assert.deepEqual([again.sent, again.alreadySent], [0, 1]);
  assert.equal(sent.length, 2, "and nothing twice");
});

test("a reader who unsubscribes after the audience is listed is skipped and recorded, and nothing is attempted for them", async () => {
  await setup();
  const r = readers();
  const { client, sent } = fakeResend([r.chips, r.centers]);
  const get = client.contacts.get;
  client.contacts.get = async (args) => { const found = await get(args); return args.id === r.centers.id ? { ...found, data: { ...found.data, unsubscribed: true } } : found; };
  const result = await deliverWeeklyCompute(jsonSteps(), { date: DATE }, client);
  assert.deepEqual([result.sent, result.skipped], [1, 1]);
  assert.deepEqual(sent.map((email) => email.to[0]), [r.chips.email]);
  assert.equal((await readPrivateJson(`delivery/weekly-compute-${DATE}/recipients/${hash(r.centers.email)}/skipped.json`)).reason, "consent_changed");
});

test("a preview goes to the addresses given, marked as one, and leaves no ledger", async () => {
  await setup();
  const { client, sent } = fakeResend([]);
  const result = await deliverWeeklyCompute(jsonSteps(), { date: DATE, test: ["editor@example.com"] }, client);
  assert.deepEqual([result.recipients, result.sent], [1, 1]);
  assert.match(sent[0].subject, /^\[Preview\] The week in AI compute: /);
  assert.equal(sent[0].headers["X-AI-Generated"], "true");
  assert.equal(await readPrivateJson(`delivery/weekly-compute-${DATE}/recipients/${hash("editor@example.com")}/sent.json`), null);
  assert.equal(await readPrivateJson(`delivery/weekly-compute-${DATE}/status.json`), null);
});

test("there is nothing to send until the edition is published", async () => {
  useStore(memoryStore({}));
  const { client } = fakeResend([]);
  await assert.rejects(deliverWeeklyCompute(jsonSteps(), { date: DATE }, client), /No weekly Compute report saved/);
});

test("a fact shown under the numbers is not shown again beneath its story", () => {
  const edition = EDITION();
  const figure = edition.numbers[0];
  const { text } = renderComputeWeeklyEmail(edition, CTX);
  assert.equal(text.split(figure.fact).length - 1, 1, "once, with its quote");
  const without = EDITION({ numbers: [] });
  assert.equal(renderComputeWeeklyEmail(without, CTX).text.split(figure.fact).length - 1, 1, "and with no numbers section it is beneath its story");
});

test("a quote and a radar headline are printed so that no mail program can link what is in them", () => {
  const edition = EDITION();
  edition.numbers[0] = { ...edition.numbers[0], fact: "Maker raised output 12% on node.js tooling.", quote: "output rose 12% on node.js tooling" };
  edition.radar[0] = { ...edition.radar[0], title: "Maker opens a fab, per node.js docs" };
  const { html, text } = renderComputeWeeklyEmail(edition, CTX);
  for (const out of [html, text]) assert.ok(out.includes("node.\u200Bjs"));
  assert.doesNotMatch(html + text, /node\.js/, "never as an unbroken name");
});
