import assert from "node:assert/strict";
import { test } from "node:test";
import { getArchiveEntry, listArchive } from "../src/lib/archive.ts";
import { preferencesLink } from "../src/lib/preference-link.ts";
import { createPrivateJson, memoryStore, useStore } from "../src/lib/private-store.ts";
import { weeklyMarkdown } from "../src/pipeline/weekly.ts";
import { EDITION } from "./weekly-fixture.mjs";

const digest = { version: 1, date: "2026-09-23", stories: [] };

test("published archive obeys Free, Personal, and Professional windows", async () => {
  const prior = { secret: process.env.PREFERENCES_SIGNING_SECRET };
  useStore(memoryStore());
  process.env.PREFERENCES_SIGNING_SECRET = "x".repeat(32);
  try {
    await createPrivateJson("issues/2026-09-23.json", { version: 1, digest, markdown: "General verified edition" });
    await createPrivateJson("published/daily/2026-09-23.json", { approvalHash: "daily-review" });
    await createPrivateJson("published/weekly/2026-09-23.json", { approvalHash: "weekly-review" });
    await createPrivateJson("delivery/2026-09-23/manifest.json", {
      version: 1, kind: "daily", date: "2026-09-23", sourceHash: "a".repeat(64), createdAt: "2026-09-23T12:00:00Z",
      items: [{ contactId: "personal", email: "personal@example.test", edition: "personal", subject: "Personal", text: "Personal verified edition\n\nEdit your reading brief: secret" }],
    });
    await createPrivateJson("delivery/weekly/2026-09-23/manifest.json", {
      version: 1, kind: "weekly", date: "2026-09-23", sourceHash: "b".repeat(64), createdAt: "2026-09-23T12:00:00Z",
      items: [{ contactId: "pro", email: "pro@example.test", edition: "professional", subject: "Weekly", text: "Professional weekly research\n\nEdit your reading brief: secret" }],
    });
    const client = { contacts: { get: async ({ email }) => ({ data: {
      email,
      properties: {
        personal_status: { type: "string", value: "active" },
        personal_plan: { type: "string", value: email.startsWith("pro") ? "professional" : "personal" },
      },
    }, error: null }) } };
    const bearer = (email) => new Request("https://agent.example/archive", { headers: {
      authorization: `Bearer ${new URLSearchParams(new URL(preferencesLink(email, Date.parse("2027-04-01T00:00:00Z"))).hash.slice(1)).get("token")}`,
    } });
    const publicRequest = new Request("https://agent.example/archive");
    assert.equal((await getArchiveEntry(publicRequest, "daily", "2026-09-23", new Date("2026-10-01"))).text, "General verified edition");
    assert.equal((await getArchiveEntry(publicRequest, "daily", "2026-09-23", new Date("2027-04-01"))).status, 403);
    // Everyone reads the shared issue until personal editions return on story records.
    assert.equal((await getArchiveEntry(bearer("personal@example.test"), "daily", "2026-09-23", new Date("2027-04-01"), client)).text, "General verified edition");
    assert.equal((await getArchiveEntry(bearer("personal@example.test"), "weekly", "2026-09-23", new Date("2027-04-01"), client)).status, 403);
    assert.equal((await getArchiveEntry(bearer("pro@example.test"), "weekly", "2026-09-23", new Date("2027-04-01"), client)).status, 404);
    assert.deepEqual((await listArchive(publicRequest, new Date("2026-10-01"))).daily, ["2026-09-23"]);
    assert.deepEqual((await listArchive(bearer("pro@example.test"), new Date("2027-04-01"), client)).weekly, ["2026-09-23"]);
  } finally {
    if (prior.secret === undefined) delete process.env.PREFERENCES_SIGNING_SECRET;
    else process.env.PREFERENCES_SIGNING_SECRET = prior.secret;
  }
});

test("the weekly research is read in the archive by Professional readers only, and only within their window", async () => {
  const prior = process.env.PREFERENCES_SIGNING_SECRET;
  useStore(memoryStore());
  process.env.PREFERENCES_SIGNING_SECRET = "x".repeat(32);
  try {
    const base = EDITION();
    const edition = { ...base, markdown: weeklyMarkdown(base) };
    await createPrivateJson(`weekly/${edition.date}.json`, edition);
    await createPrivateJson(`published/weekly/${edition.date}.json`, { version: 2, kind: "weekly", date: edition.date, publishedAt: edition.generatedAt });
    await createPrivateJson("published/weekly/2026-10-04.json", { version: 2, kind: "weekly", date: "2026-10-04", publishedAt: "2026-10-04T05:30:00Z" });
    await createPrivateJson("weekly/2026-09-27.json", { version: 1, date: "2026-09-27", markdown: "not an edition" });
    await createPrivateJson("published/weekly/2026-09-27.json", { version: 2, kind: "weekly", date: "2026-09-27", publishedAt: "2026-09-27T05:30:00Z" });
    const now = new Date("2026-10-12T08:00:00Z");
    const client = { contacts: { get: async ({ email }) => ({ data: { email, properties: {
      personal_status: { type: "string", value: "active" },
      personal_plan: { type: "string", value: email.startsWith("pro") ? "professional" : "personal" },
    } }, error: null }) } };
    const bearer = (email) => new Request("https://agent.example/archive", { headers: {
      authorization: `Bearer ${new URLSearchParams(new URL(preferencesLink(email, now.getTime())).hash.slice(1)).get("token")}`,
    } });
    const read = (request, date = edition.date, at = now) => getArchiveEntry(request, "weekly", date, at, client);

    const pro = await read(bearer("pro@example.test"));
    assert.equal(pro.status, 200);
    assert.equal(pro.text, edition.markdown, "the markdown the pipeline wrote, as written");
    assert.match(pro.text, /^# The week in AI engineering: 4 to 11 October/);
    assert.equal((await read(bearer("personal@example.test"))).status, 403, "Personal does not include the weekly research");
    assert.equal((await read(new Request("https://agent.example/archive"))).status, 403, "nor does reading signed out");
    assert.equal((await read(bearer("pro@example.test"), "2026-10-18")).status, 404, "a week not published is not there");
    assert.equal((await read(bearer("pro@example.test"), "2026-10-04")).status, 404, "published with no edition saved is not an edition");
    assert.equal((await read(bearer("pro@example.test"), "2026-09-27")).status, 404, "nor is an edition that cannot be read");
    assert.equal((await read(bearer("pro@example.test"), edition.date, new Date("2028-11-01T00:00:00Z"))).status, 403, "Professional reads back 24 months");
    assert.equal((await read(bearer("pro@example.test"), "not-a-date")).status, 400);
    assert.deepEqual((await listArchive(bearer("pro@example.test"), now, client)).weekly, [edition.date, "2026-10-04", "2026-09-27"]);
    assert.deepEqual((await listArchive(bearer("personal@example.test"), now, client)).weekly, []);
  } finally {
    if (prior === undefined) delete process.env.PREFERENCES_SIGNING_SECRET;
    else process.env.PREFERENCES_SIGNING_SECRET = prior;
  }
});

test("archive markdown marks featured headings with their story ids", async () => {
  const { withStoryMarkers } = await import("../src/lib/archive.ts");
  const markdown = "# Lead\n\nIntro.\n\n## Lead\n\nBody.\n\n## Second\n\nMore.\n\n## Signals\n\n1. [A](https://a.example)";
  const marked = withStoryMarkers(markdown, [
    { id: "s-0123456789abcdef", role: "featured", headline: "Lead" },
    { id: "s-fedcba9876543210", role: "featured", headline: "Second" },
    { id: "s-1111111111111111", role: "signal", headline: "A" },
  ]);
  assert.match(marked, /<!-- story:s-0123456789abcdef -->\n## Lead/);
  assert.match(marked, /<!-- story:s-fedcba9876543210 -->\n## Second/);
  assert.equal(marked.match(/<!-- story:/g)?.length, 2);
  assert.ok(marked.startsWith("# Lead"));
});
