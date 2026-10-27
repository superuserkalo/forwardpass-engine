import assert from "node:assert/strict";
import test from "node:test";
import { articleLinks, dropChromeHosts, looseUrl, matchByUrl, publishedPool, stageOf } from "../src/pipeline/recall-match.ts";

// The recall report is the yardstick for coverage work, so it must not lose the sources it measures:
// the first version dropped GitHub, Hugging Face, arXiv and X links, and keyed stages on lead URLs.

const page = `<html><body><a href="https://alphasignal.ai/about">About</a>
<a href="https://x.com/claudeai/status/1234567890">post</a><a href="https://twitter.com/OpenAI/status/99/photo/1">photo</a>
<a href="https://github.com/acme/tool?utm_source=x#readme">repo</a><a href="https://huggingface.co/acme/model">model</a>
<a href="https://arxiv.org/abs/2609.12345">paper</a><a href="https://www.example.com/post?utm_campaign=a">blog</a>
<a href="https://www.example.com/post">same blog</a><a href="https://imagedelivery.net/abc/hero.png">image</a><a href="http://insecure.test/x">insecure</a></body></html>`;

test("article links keep repos, models, papers and X posts apart from publisher pages", () => {
  const { sources, xPosts } = articleLinks(page, "https://alphasignal.ai/news/x");
  assert.deepEqual(xPosts, ["https://x.com/claudeai/status/1234567890", "https://twitter.com/OpenAI/status/99"]);
  assert.deepEqual(sources, ["https://github.com/acme/tool", "https://huggingface.co/acme/model", "https://arxiv.org/abs/2609.12345", "https://www.example.com/post"]);
});

test("a host linked from most articles is page chrome, but GitHub, Hugging Face, arXiv and X never are", () => {
  const articles = new Map(Array.from({ length: 6 }, (_, i) => [`https://alphasignal.ai/news/${i}`, {
    sources: ["https://forms.test/signup", "https://github.com/acme/tool", `https://lab${i}.test/post`], xPosts: [`https://x.com/lab/status/${i}`],
  }]));
  const cleaned = dropChromeHosts(articles);
  assert.deepEqual(cleaned.get("https://alphasignal.ai/news/0"), { sources: ["https://github.com/acme/tool", "https://lab0.test/post"], xPosts: ["https://x.com/lab/status/0"] });
});

test("a source URL matches a cluster item however the link is decorated", () => {
  const cluster = (...urls) => ({ items: urls.map((url) => ({ url, title: "t" })), lead: { url: urls[0] }, score: 0 });
  const clusters = [cluster("https://other.test/a"), cluster("https://cohere.com/blog/embed-5", "https://news.test/cohere-embed")];
  assert.equal(matchByUrl(["https://www.cohere.com/blog/embed-5/?utm_source=x#top"], clusters), 1);
  assert.equal(matchByUrl(["https://nothing.test/here"], clusters), -1);
  assert.equal(looseUrl("https://www.Example.com/Path/?a=1#b"), "example.com/path");
});

test("a story's stage is the furthest any of its URLs got, whichever cluster lead carried it", () => {
  const pools = { collected: new Set(["a.test/1", "b.test/2", "c.test/3", "d.test/4", "e.test/5"]), shortlisted: new Set(["b.test/2", "c.test/3", "d.test/4", "e.test/5"]), kept: new Set(["c.test/3", "d.test/4", "e.test/5"]), editor: new Set(["d.test/4", "e.test/5"]), published: new Set(), picked: new Set(["e.test/5"]) };
  assert.equal(stageOf(["https://nowhere.test/x"], pools), "missing");
  assert.equal(stageOf(["https://a.test/1"], pools), "collected");
  assert.equal(stageOf(["https://a.test/1", "https://b.test/2"], pools), "shortlisted");
  assert.equal(stageOf(["https://c.test/3"], pools), "kept");
  assert.equal(stageOf(["https://d.test/4"], pools), "editor");
  assert.equal(stageOf(["https://a.test/1", "https://e.test/5"], pools), "picked");
});

// ---- recallReport end to end, with the network and the model replaced ----
import { memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";
import { recallReport } from "../src/pipeline/recall.ts";

const item = (title, url, extra = {}) => ({ title, summary: "", url, publishedAt: "2026-10-02T01:00:00Z", source: "Lab", category: "news", dateKind: "published", firstSeenAt: "2026-10-02T02:00:00Z", ...extra });

test("recall matches stories by source URL and scores the stage on every URL in the cluster, not its lead", async () => {
  const embed = item("Embed 5 ships", "https://cohere.com/blog/embed-5", { source: "Cohere" });
  const repost = item("Cohere launches Embed 5 for retrieval", "https://news.test/cohere-embed-5", { source: "News" });
  const articles = [
    item("Cohere's Embed 5 Lets Developers Query 2.4x Faster", "https://alphasignal.ai/news/embed", { source: "AlphaSignal" }),
    item("Acme Tool Hits 500 Stars", "https://alphasignal.ai/news/tool", { source: "AlphaSignal" }),
    item("Cohere Announces Something On X", "https://alphasignal.ai/news/xonly", { source: "AlphaSignal" }),
  ];
  useStore(memoryStore({ "collection/runs/2026-10-02/01.json": { version: 2, collectedAt: "2026-10-02T02:00:00Z", items: [embed, repost, ...articles], attention: { measurements: [], candidates: [], health: [] }, health: [] } }));
  const pages = new Map([
    ["https://alphasignal.ai/news/embed", `<a href="https://cohere.com/blog/embed-5">source</a>`],
    ["https://alphasignal.ai/news/tool", `<a href="https://github.com/acme/tool">repo</a>`],
    ["https://alphasignal.ai/news/xonly", `<a href="https://x.com/cohere/status/1">post</a>`],
  ]);
  // The issue shortlisted the story under the repost's URL as its lead.
  const cluster = { items: [{ ...repost, host: "news.test" }, { ...embed, host: "cohere.com" }], score: 9, lead: { ...repost, host: "news.test" } };
  const report = await recallReport("2026-10-02", new Date("2026-10-02T05:30:00Z"), [{ id: "c0", cluster }], [{ id: "c0", keep: true, importance: 8, section: "tool", angle: "", topics: [], prerank: 9 }], [],
    { fetchPage: async (url) => pages.get(url) ?? null, matchTitles: async () => new Map(), learn: false });
  const byHeadline = Object.fromEntries(report.stories.map((s) => [s.alphasignal.slice(0, 12), s]));
  assert.equal(byHeadline["Cohere's Emb"].stage, "editor");
  assert.equal(byHeadline["Cohere's Emb"].matchedBy, "url");
  assert.equal(byHeadline["Acme Tool Hi"].stage, "missing");
  assert.deepEqual(byHeadline["Acme Tool Hi"].sources, ["https://github.com/acme/tool"]);
  assert.equal(byHeadline["Cohere Annou"].stage, "missing");
  assert.deepEqual(byHeadline["Cohere Annou"].xPosts, ["https://x.com/cohere/status/1"]);
  assert.deepEqual(report.diagnostics, { urlMatched: 1, titleMatched: 0, xOnly: 1, noLink: 0 });
  assert.equal(report.counts.editor, 1);
  assert.equal((await readPrivateJson("reports/recall/2026-10-02.json")).benchmark, 3);
});

test("a story counts as picked when the issue linked any URL of its cluster, whichever URL leads it now", async () => {
  const embed = item("Embed 5 ships", "https://cohere.com/blog/embed-5", { source: "Cohere" });
  const repost = item("Cohere launches Embed 5 for retrieval", "https://news.test/cohere-embed-5", { source: "News" });
  const article = item("Cohere's Embed 5 Lets Developers Query 2.4x Faster", "https://alphasignal.ai/news/embed", { source: "AlphaSignal" });
  useStore(memoryStore({ "collection/runs/2026-10-02/01.json": { version: 2, collectedAt: "2026-10-02T02:00:00Z", items: [embed, repost, article], attention: { measurements: [], candidates: [], health: [] }, health: [] } }));
  // The issue linked the publisher's post; today's replay leads the cluster with the repost.
  const cluster = { items: [{ ...repost, host: "news.test" }, { ...embed, host: "cohere.com" }], score: 9, lead: { ...repost, host: "news.test" } };
  const report = await recallReport("2026-10-02", new Date("2026-10-02T05:30:00Z"), [{ id: "c0", cluster }], [], ["https://cohere.com/blog/embed-5"],
    { fetchPage: async () => `<a href="https://cohere.com/blog/embed-5">source</a>`, matchTitles: async () => new Map(), learn: false });
  assert.equal(report.stories[0].stage, "picked");
});

test("generic hosts never become sources, so they cannot earn a publisher weight or a discovery lead", () => {
  const html = ["https://www.reddit.com/r/x/comments/1", "https://medium.com/@a/post", "https://news.ycombinator.com/item?id=1", "https://en.wikipedia.org/wiki/X", "https://t.co/abc",
    "https://bit.ly/x", "https://docs.google.com/document/d/1", "https://discord.gg/abc", "https://raw.githubusercontent.com/a/b/main/README.md", "https://apple.com/", "https://real-lab.test/post",
    "https://cloud.google.com/blog/products/ai/x", "https://machinelearning.apple.com/research/x"].map((href) => `<a href="${href}">x</a>`).join("");
  // Publisher blogs on big domains stay; the plain generic hosts go.
  assert.deepEqual(articleLinks(html, "https://alphasignal.ai/news/x").sources, ["https://real-lab.test/post", "https://cloud.google.com/blog/products/ai/x", "https://machinelearning.apple.com/research/x"]);
});

// ---- signals count as coverage: a story we published live reached the reader, which the editor's shortlist alone did not ----
import { localSignalService } from "../src/lib/signal-service.ts";
import { freshCandidates } from "../src/pipeline/candidates.ts";
import { weeklyRecall } from "../src/pipeline/recall-weekly.ts";
import { newStore, record } from "./signals-test-support.mjs";

test("a story we published as a signal is further on than one the editor saw, and not as far as one the issue picked", () => {
  const pools = { collected: new Set(["a.test/1", "b.test/2", "c.test/3", "d.test/4", "e.test/5", "f.test/6"]), shortlisted: new Set(["b.test/2", "c.test/3", "d.test/4", "e.test/5", "f.test/6"]), kept: new Set(["c.test/3", "d.test/4", "e.test/5", "f.test/6"]),
    editor: new Set(["d.test/4", "e.test/5", "f.test/6"]), published: new Set(["e.test/5", "f.test/6", "p.test/7"]), picked: new Set(["f.test/6"]) };
  assert.equal(stageOf(["https://d.test/4"], pools), "editor");
  assert.equal(stageOf(["https://e.test/5"], pools), "published");
  assert.equal(stageOf(["https://d.test/4", "https://e.test/5"], pools), "published", "published passes editor");
  assert.equal(stageOf(["https://e.test/5", "https://f.test/6"], pools), "picked", "and picked passes published");
  assert.equal(stageOf(["https://p.test/7"], pools), "published", "a signal for a page nothing else collected still counts");
  assert.equal(stageOf(["https://a.test/1"], pools), "collected");
});

test("what counts as published is each signal's own address and every item of a cluster that holds one, matched as loosely as any other link", () => {
  const cluster = (...urls) => ({ items: urls.map((url) => ({ url, title: "t" })), lead: { url: urls[0] }, score: 0 });
  const clusters = [cluster("https://a.test/1", "https://a.test/2"), cluster("https://b.test/1"), cluster("https://c.test/1", "https://news.test/c")];
  assert.deepEqual([...publishedPool(["https://www.A.test/2/?utm_source=x", "https://d.test/elsewhere", "not a url", ""], clusters)].sort(), ["a.test/1", "a.test/2", "d.test/elsewhere"], "the other member of the cluster, the page no cluster holds, and nothing for what is not an address");
  assert.deepEqual([...publishedPool(["https://news.test/c"], clusters)].sort(), ["c.test/1", "news.test/c"]);
  assert.deepEqual([...publishedPool([], clusters)], []);
});

const SIGNAL_DAY = "2026-10-02";
const recallWith = (shortlist, ranked, picked, pages, deps = {}) => recallReport(SIGNAL_DAY, new Date("2026-10-02T05:30:00Z"), shortlist, ranked, picked,
  { fetchPage: async (url) => pages.get(url) ?? null, matchTitles: async () => new Map(), learn: false, ...deps });
async function signalsWorld() {
  const embed = item("Embed 5 ships", "https://cohere.com/blog/embed-5", { source: "Cohere" });
  const repost = item("Cohere launches Embed 5 for retrieval", "https://news.test/cohere-embed-5", { source: "News" });
  const tool = item("Acme releases a memory tool for agents", "https://github.com/acme/tool", { source: "GitHub" });
  const zed = item("Zed ships an agent panel to every editor user", "https://zed.dev/blog/agents", { source: "Zed" });
  const articles = [
    item("Cohere's Embed 5 Lets Developers Query 2.4x Faster", "https://alphasignal.ai/news/embed", { source: "AlphaSignal" }),
    item("Acme Tool Hits 500 Stars", "https://alphasignal.ai/news/tool", { source: "AlphaSignal" }),
    item("Old Lab Posts A Result We Had A Day Early", "https://alphasignal.ai/news/old", { source: "AlphaSignal" }),
    item("Zed Brings Agents Into The Editor", "https://alphasignal.ai/news/zed", { source: "AlphaSignal" }),
    item("Something Nobody Covered", "https://alphasignal.ai/news/none", { source: "AlphaSignal" }),
  ];
  useStore(memoryStore({ "collection/runs/2026-10-02/01.json": { version: 2, collectedAt: "2026-10-02T02:00:00Z", items: [embed, repost, tool, zed, ...articles], attention: { measurements: [], candidates: [], health: [] }, health: [] } }));
  const pages = new Map([
    ["https://alphasignal.ai/news/embed", `<a href="https://cohere.com/blog/embed-5">source</a>`],
    ["https://alphasignal.ai/news/tool", `<a href="https://github.com/acme/tool">repo</a>`],
    ["https://alphasignal.ai/news/old", `<a href="https://oldlab.test/result">source</a>`],
    ["https://alphasignal.ai/news/zed", `<a href="https://zed.dev/blog/agents">source</a>`],
    ["https://alphasignal.ai/news/none", `<a href="https://nobody.test/post">source</a>`],
  ]);
  const shortlist = [
    { id: "c0", cluster: { items: [{ ...repost, host: "news.test" }, { ...embed, host: "cohere.com" }], score: 9, lead: { ...repost, host: "news.test" } } },
    { id: "c1", cluster: { items: [{ ...zed, host: "zed.dev" }], score: 8, lead: { ...zed, host: "zed.dev" } } },
  ];
  const ranked = [{ id: "c0", keep: true, importance: 8, section: "tool", angle: "", topics: [], prerank: 9 }, { id: "c1", keep: true, importance: 8, section: "tool", angle: "", topics: [], prerank: 8 }];
  const signals = localSignalService(newStore());
  // The signal was published under the repost's address, so the story that links the original reaches it through the cluster; another is for a page this window never collected.
  for (const url of ["https://news.test/cohere-embed-5", "https://github.com/acme/tool", "https://oldlab.test/result", "https://zed.dev/blog/agents", "https://unrelated.test/other"]) await signals.publish(record(url, { publishedAt: "2026-10-02T04:00:00.000Z" }));
  return { shortlist, ranked, pages, signals };
}
const stageOfStory = (report) => Object.fromEntries(report.stories.map((story) => [story.alphasignal.slice(0, 10), story.stage]));

test("recall credits a story we published: through the cluster, for a page only collected, and for one outside the window; and the issue's pick still counts for more", async () => {
  const { shortlist, ranked, pages, signals } = await signalsWorld();
  const report = await recallWith(shortlist, ranked, ["https://zed.dev/blog/agents"], pages, { signals });
  assert.deepEqual(stageOfStory(report), { "Cohere's E": "published", "Acme Tool ": "published", "Old Lab Po": "published", "Zed Brings": "picked", "Something ": "missing" });
  assert.deepEqual(report.counts, { missing: 1, collected: 0, shortlisted: 0, kept: 0, editor: 0, published: 3, picked: 1 });
  assert.equal(Object.values(report.counts).reduce((sum, n) => sum + n, 0), report.benchmark, "the counts add up to the benchmark");
  assert.deepEqual((await readPrivateJson("reports/recall/2026-10-02.json")).counts, report.counts, "and the saved report says the same");
});

test("without a signal store the report is as it was", async () => {
  const { shortlist, ranked, pages } = await signalsWorld();
  const report = await recallWith(shortlist, ranked, [], pages);
  assert.deepEqual(stageOfStory(report), { "Cohere's E": "editor", "Acme Tool ": "collected", "Old Lab Po": "missing", "Zed Brings": "editor", "Something ": "missing" });
  assert.deepEqual(report.counts, { missing: 2, collected: 1, shortlisted: 0, kept: 0, editor: 2, published: 0, picked: 0 });
});

test("a signal store that cannot be read fails the report, which writes nothing, rather than undercounting what we covered", async () => {
  const { shortlist, ranked, pages } = await signalsWorld();
  await assert.rejects(recallWith(shortlist, ranked, [], pages, { signals: { recentHeadlines: async () => { throw new Error("signals are unavailable"); } } }), /signals are unavailable/);
  assert.equal(await readPrivateJson("reports/recall/2026-10-02.json"), null, "so the retried step makes the whole report");
});

test("recall looks for signals from two days before the window opens, since a story we covered a day early is still covered", async () => {
  const { shortlist, ranked, pages } = await signalsWorld();
  const asked = [];
  await recallWith(shortlist, ranked, [], pages, { signals: { recentHeadlines: async (since) => { asked.push(since); return []; } } });
  const { since } = await freshCandidates(SIGNAL_DAY, new Date("2026-10-02T05:30:00Z"));
  assert.deepEqual(asked, [new Date(Date.parse(since) - 48 * 3_600_000).toISOString()]);
});

test("the weekly view totals the published stage too, and a report from before it existed counts none", async () => {
  const day = (date, stages) => {
    const counts = {};
    for (const stage of stages) counts[stage] = (counts[stage] ?? 0) + 1;
    return [`reports/recall/${date}.json`, { date, benchmark: stages.length, counts, stories: stages.map((stage, i) => ({ alphasignal: `story ${i}`, stage, sources: [] })) }];
  };
  useStore(memoryStore(Object.fromEntries([
    day("2026-10-01", ["missing", "missing", "collected", "editor", "picked"]),
    day("2026-10-02", ["missing", "collected", "published", "published", "published", "picked"]),
    day("2026-10-03", ["editor", "published", "published", "picked", "picked"]),
  ])));
  const weekly = await weeklyRecall("2026-10-04");
  assert.deepEqual(weekly.totals, { missing: 3, collected: 2, shortlisted: 0, kept: 0, editor: 2, published: 5, picked: 4 });
  assert.deepEqual(weekly.daily, [
    { date: "2026-10-01", benchmark: 5, reached: 3, picked: 1, published: 0 },
    { date: "2026-10-02", benchmark: 6, reached: 5, picked: 1, published: 3 },
    { date: "2026-10-03", benchmark: 5, reached: 5, picked: 2, published: 2 },
  ]);
  assert.deepEqual((await readPrivateJson("reports/recall/weekly-2026-10-04.json")).totals, weekly.totals);
});
