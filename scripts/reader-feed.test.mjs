import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { articleFromMarkdown, saveArticle } from "../src/lib/articles.ts";
import { issueV2Schema, saveIssue, storyId } from "../src/lib/issue.ts";
import { issueMarkdown, storyRecords } from "../src/pipeline/assemble.ts";
import { editionStories } from "../src/lib/edition-stories.ts";
import { preferencesLink } from "../src/lib/preference-link.ts";
import { createPrivateJson, memoryStore, useStore } from "../src/lib/private-store.ts";
import { readerArticle, readerEditorial, readerFeed, sourceName, storyType } from "../src/lib/reader-feed.ts";
import { allowVoteWrite, parseStoryId, setVote, storyExists, storyTally } from "../src/lib/reader-votes.ts";

const digest = { version: 1, date: "2026-09-23", stories: [] };
const edition = readFileSync(new URL("./fixtures/legacy-issue.md", import.meta.url), "utf8");

// Reader tokens belong to the fixture date, rather than the machine's current date.
test.beforeEach((context) => {
  context.mock.method(Date, "now", () => Date.parse("2026-09-24T12:00:00Z"));
});

async function inTempStore(run) {
  const secret = process.env.PREFERENCES_SIGNING_SECRET;
  process.env.PREFERENCES_SIGNING_SECRET = "x".repeat(32);
  useStore(memoryStore());
  try {
    await run();
  } finally {
    if (secret === undefined) delete process.env.PREFERENCES_SIGNING_SECRET;
    else process.env.PREFERENCES_SIGNING_SECRET = secret;
  }
}

// Issues saved by the retired Eve pipeline stay readable with their positional story ids.
const saveLegacyIssue = (date, markdown) => createPrivateJson(`issues/${date}.json`, { version: 1, digest, markdown });

function v2Issue(date) {
  const story = (overrides) => ({ role: "featured", label: "Top News", type: "news", headline: "Lab ships model", body: "It is fast.\n\n- One bullet", url: "https://lab.example/model",
    sources: ["https://lab.example/model"], traction: "120 HN points", topics: ["LLMs"], project: "Lab", publishedAt: `${date}T01:00:00Z`, facts: [], ...overrides });
  const stories = storyRecords(date, [story({})], [story({ role: "signal", label: "Signal", type: "repos", headline: "Repo adds a thing", body: null, url: "https://github.com/org/repo", sources: ["https://github.com/org/repo"], topics: ["Open source"] })]);
  const draft = { version: 2, date, createdAt: `${date}T05:30:00.000Z`, subject: "Lab ships model", preview: "Lab ships model", intro: ["Hook one. Hook two.", "Meanwhile, more.", "If you read one thing today: the model."], stories,
    pipeline: { candidates: 1, clusters: 1, shortlisted: 1, kept: 1, models: {}, usage: [], checks: {} } };
  return issueV2Schema.parse({ ...draft, markdown: issueMarkdown(draft) });
}

const freeReaders = { contacts: { get: async ({ email }) => ({ data: { email, properties: {} }, error: null }) } };

function readerRequest(email, path = "/feed") {
  const token = new URLSearchParams(new URL(preferencesLink(email, Date.parse("2026-09-20T00:00:00Z"))).hash.slice(1)).get("token");
  return new Request(`https://agent.example${path}`, { headers: { authorization: `Bearer ${token}` } });
}

test("a published edition splits into numbered stories and quick signals", () => {
  const stories = editionStories(edition);
  const numbered = stories.filter((story) => story.kind === "story");
  const signals = stories.filter((story) => story.kind === "signal");
  assert.equal(numbered.length, 1);
  assert.equal(numbered[0].title, "Example engine adds sandboxed evaluation");
  assert.match(numbered[0].dek, /^The example release adds/);
  assert.equal(numbered[0].sourceUrl, "https://lab.example/evaluation");
  assert.equal(signals.length, 13);
  assert.equal(signals[4].title, "Example signal 5");
  assert.equal(signals[4].sourceUrl, "https://lab.example/signals/5");
});

test("story ids parse and unknown shapes are rejected", () => {
  assert.deepEqual(parseStoryId("daily:2026-09-23:0"), { kind: "story", date: "2026-09-23", index: 0 });
  assert.deepEqual(parseStoryId("daily:2026-09-23:signal:4"), { kind: "signal", date: "2026-09-23", index: 4 });
  assert.deepEqual(parseStoryId("weekly:2026-09-20"), { kind: "edition", section: "weekly", date: "2026-09-20" });
  assert.deepEqual(parseStoryId("editorial:local-qwen"), { kind: "editorial", slug: "local-qwen" });
  assert.equal(parseStoryId("daily:../../secret:0"), null);
  assert.equal(parseStoryId("editorial:Bad Slug"), null);
});

test("source names and story types come from the primary source", () => {
  assert.equal(sourceName("https://docs.nvidia.com/x"), "NVIDIA");
  assert.equal(sourceName("https://github.com/Tencent/BrowserSkill/releases"), "TENCENT");
  assert.equal(storyType("Flash-dLLM paper proposes caching", "https://huggingface.co/papers/date/2026-09-23"), "papers");
  assert.equal(storyType("Jev Browser 0.5.0", "https://github.com/jkudish/jev-browser"), "repos");
  assert.equal(storyType("Claude Opus 5.5 released", "https://www.anthropic.com/news/claude-opus-5-5"), "models");
});

test("the feed serves published stories with shared, idempotent vote counts", async () => {
  await inTempStore(async () => {
    await saveLegacyIssue("2026-09-23", edition);
    await createPrivateJson("published/daily/2026-09-23.json", { approvalHash: "daily-review" });
    const now = new Date("2026-09-24T12:00:00Z");

    const anonymous = await readerFeed(new Request("https://agent.example/feed"), 48, now);
    assert.equal(anonymous.stories.length, 14);
    assert.equal(anonymous.stories[0].id, "daily:2026-09-23:0");
    assert.equal(anonymous.stories[0].href, "/archive/daily/2026-09-23/example-engine-adds-sandboxed-evaluation");
    assert.equal(anonymous.stories[0].published_at, "2026-09-23T07:00:00Z");
    assert.match(anonymous.stories[1].href, /^https:\/\//);
    assert.equal(anonymous.stories[0].upvotes, 0);

    const lead = parseStoryId("daily:2026-09-23:0");
    assert.equal(await storyExists(lead), true);
    assert.equal(await storyExists(parseStoryId("daily:2026-09-23:9")), false);
    assert.equal(await storyExists(parseStoryId("daily:2026-09-22:0")), false);

    await setVote(lead, "a@example.test", true);
    await setVote(lead, "a@example.test", true);
    await setVote(lead, "b@example.test", true);
    assert.deepEqual(await storyTally(lead, "a@example.test"), { upvotes: 2, viewerHasUpvoted: true });

    const forA = await readerFeed(readerRequest("a@example.test"), 48, now, freeReaders);
    assert.equal(forA.stories[0].upvotes, 2);
    assert.equal(forA.stories[0].viewer_has_upvoted, true);
    const forC = await readerFeed(readerRequest("c@example.test"), 48, now, freeReaders);
    assert.equal(forC.stories[0].viewer_has_upvoted, false);

    await setVote(lead, "a@example.test", false);
    await setVote(lead, "a@example.test", false);
    assert.deepEqual(await storyTally(lead, "a@example.test"), { upvotes: 1, viewerHasUpvoted: false });
    assert.equal((await readerFeed(new Request("https://agent.example/feed"), 2, now)).stories.length, 2);
  });
});

test("story-record issues serve stable ids, explicit topics, real publish times and votes", async () => {
  await inTempStore(async () => {
    const issue = v2Issue("2026-09-28");
    await saveIssue(issue);
    await saveIssue(issue);
    await createPrivateJson("published/daily/2026-09-28.json", { version: 2, kind: "daily", date: "2026-09-28", publishedAt: "2026-09-28T05:41:00.000Z" });
    const now = new Date("2026-09-28T12:00:00Z");
    const feed = await readerFeed(new Request("https://agent.example/feed"), 48, now);
    const lead = storyId("2026-09-28", "https://lab.example/model");
    assert.deepEqual(feed.stories.map(({ id }) => id), [`daily:2026-09-28:${lead}`, `daily:2026-09-28:${storyId("2026-09-28", "https://github.com/org/repo")}`]);
    assert.equal(feed.stories[0].href, "/archive/daily/2026-09-28/lab-ships-model");
    assert.deepEqual(feed.stories[0].topics, ["LLMs"]);
    assert.equal(feed.stories[1].type, "repos");
    assert.equal(feed.stories[0].published_at, "2026-09-28T05:41:00.000Z");
    assert.equal(feed.stories[0].dek, "It is fast.");
    const ref = parseStoryId(feed.stories[0].id);
    assert.deepEqual(ref, { kind: "record", date: "2026-09-28", storyId: lead });
    assert.equal(await storyExists(ref), true);
    assert.equal(await storyExists(parseStoryId("daily:2026-09-28:s-0000000000000000")), false);
    await setVote(ref, "a@example.test", true);
    assert.equal((await readerFeed(new Request("https://agent.example/feed"), 48, now)).stories[0].upvotes, 1);
    await assert.rejects(saveIssue({ ...issue, subject: "Different" }), /different issue/);
  });
});

test("editorial pieces publish from markdown, hide until their date, and carry votes", async () => {
  await inTempStore(async () => {
    const piece = articleFromMarkdown(
      `---\ntitle: How to Run Qwen Locally\ndek: Pick a file, an engine and a harness.\nauthor: ADHAM KHALED\nkind: tutorial\ntopics: LLMs, Development\npublished_at: 2026-09-21T09:00:00Z\n---\n\n## Pick a file\n\nBody.`,
      "local-qwen",
    );
    await saveArticle(piece);
    await saveArticle({ ...piece, slug: "future-piece", publishedAt: "2026-12-01T00:00:00Z" });
    const now = new Date("2026-09-24T12:00:00Z");

    await setVote(parseStoryId("editorial:local-qwen"), "a@example.test", true);
    const listed = await readerEditorial(readerRequest("a@example.test", "/editorial"), now);
    assert.deepEqual(listed.pieces.map((entry) => entry.id), ["editorial:local-qwen"]);
    assert.equal(listed.pieces[0].href, "/archive/editorial/local-qwen");
    assert.deepEqual(listed.pieces[0].topics, ["LLMs", "Development"]);
    assert.equal(listed.pieces[0].upvotes, 1);
    assert.equal(listed.pieces[0].viewer_has_upvoted, true);

    const article = await readerArticle(new Request("https://agent.example/editorial/local-qwen"), "local-qwen", now);
    assert.equal(article.markdown, "## Pick a file\n\nBody.");
    assert.equal(await readerArticle(new Request("https://agent.example/x"), "future-piece", now), null);
    assert.equal(await readerArticle(new Request("https://agent.example/x"), "missing", now), null);
    assert.throws(() => articleFromMarkdown("no front matter", "x"));
  });
});

test("vote writes are rate limited per reader", () => {
  const start = Date.parse("2026-09-24T12:00:00Z");
  for (let index = 0; index < 60; index += 1) assert.equal(allowVoteWrite("burst@example.test", start), true);
  assert.equal(allowVoteWrite("burst@example.test", start), false);
  assert.equal(allowVoteWrite("other@example.test", start), true);
  assert.equal(allowVoteWrite("burst@example.test", start + 61_000), true);
});

test("every story carries its own image, featured stories link to their page and signals to their source", async () => {
  const { illustrationPrompt, storySlug } = await import("../src/lib/cover-images.ts");
  const { handleReaderRequest } = await import("../src/api/reader.ts");
  const { writePrivateJson } = await import("../src/lib/private-store.ts");
  await inTempStore(async () => {
    const date = "2026-09-28";
    const issue = v2Issue(date);
    await saveIssue(issue);
    await createPrivateJson(`published/daily/${date}.json`, { version: 2, kind: "daily", date, publishedAt: `${date}T05:41:00.000Z` });
    const now = new Date(`${date}T12:00:00Z`);
    const feed = async () => (await readerFeed(new Request("https://agent.example/feed"), 48, now)).stories;
    assert.deepEqual((await feed()).map(({ href }) => href), [`/archive/daily/${date}/lab-ships-model`, "https://github.com/org/repo"]);
    assert.deepEqual((await feed()).map(({ image }) => image), [null, null]);

    const [lead, signal] = issue.stories;
    const bytes = Buffer.from("png-bytes");
    for (const story of [lead, signal]) {
      await writePrivateJson(`images/story/${date}/${story.id}.json`, { version: 1, mediaType: "image/png", base64: bytes.toString("base64"), origin: "source", sourceUrl: story.url, imageUrl: `${story.url}/og.png`, credit: new URL(story.url).hostname, model: null, prompt: null, createdAt: now.toISOString() });
      await writePrivateJson(`images-meta/story/${date}/${story.id}.json`, { origin: "source", credit: new URL(story.url).hostname, sourceUrl: story.url });
    }
    assert.deepEqual((await feed()).map(({ image }) => image), [`/media/story/${date}/${lead.id}`, `/media/story/${date}/${signal.id}`]);

    const served = await handleReaderRequest(new Request("https://agent.example/x"), `/images/story/${date}/${lead.id}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.match(served.headers.get("cache-control"), /immutable/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
    assert.equal((await handleReaderRequest(new Request("https://agent.example/x"), "/images/story/2026-01-01/s-0000000000000000")).status, 404);
    assert.equal((await handleReaderRequest(new Request("https://agent.example/x"), "/images/story/..%2Fx")).status, 404);

    const edition = await handleReaderRequest(new Request(`https://agent.example/archive/daily/${date}`), `/archive/daily/${date}`);
    assert.equal(edition.status, 200);
    assert.equal(edition.headers.get("x-cover-image"), `/media/story/${date}/${lead.id}`);
    assert.deepEqual(JSON.parse(edition.headers.get("x-story-images"))[lead.id], { path: `/media/story/${date}/${lead.id}`, credit: "lab.example", source: lead.url, slug: "lab-ships-model" });
  });
  assert.equal(storySlug("Cloudflare open-sources Clef decision models at 209.3 ms versus Jev's 524.1 ms"), "cloudflare-open-sources-clef-decision-models-at-209-3-ms-versus-jevs-524-1-ms");
  assert.equal(storySlug("Pi ships 1.0 agent harness with Codemode, native MCP and cache warming"), "pi-ships-1-0-agent-harness-with-codemode-native-mcp-and-cache-warming");
  assert.ok(storySlug("x".repeat(30) + " " + "word ".repeat(30)).length <= 80);
  assert.match(illustrationPrompt("A laptop running a desktop app."), /Scene: A laptop running a desktop app\. .*No text, no letters/);
});

test("source images are only fetched from public HTTPS hosts", async () => {
  const { imageCandidates, imageSize, usableSize } = await import("../src/lib/source-images.ts");
  const html = `<meta property="og:image" content="https://opengraph.githubassets.com/x/y"><main><img src="/fig.png" width="900"><img src="/icon.png" width="32"><img src="https://cdn.example.com/logo.png"></main>`;
  assert.deepEqual(imageCandidates(html, "https://lab.example/post"), ["https://lab.example/fig.png"]);
  const png = Buffer.alloc(32); png.write("\x89PNG", 0, "latin1"); png.writeUInt32BE(1200, 16); png.writeUInt32BE(630, 20);
  assert.deepEqual(imageSize(png), { width: 1200, height: 630 });
  assert.equal(usableSize({ width: 1200, height: 630 }), true);
  assert.equal(usableSize({ width: 300, height: 300 }), false);
  assert.equal(usableSize({ width: 600, height: 3000 }), false);
});
