import test from "node:test";
import assert from "node:assert/strict";
import { parseFeed, findFeeds, findIndexPages } from "../src/lib/feed-finder.ts";
import { parseGithubTrending, collectTrending } from "../src/lib/trending-streams.ts";
import { missedPublishers, outboundLinks, classifyFeeds, classifyIndexes, discoveredStreams, reviewSources, publisherDomain } from "../src/lib/source-discovery.ts";

const now = new Date("2026-09-24T12:00:00Z");
const rss = (titles, date = "Tue, 23 Sep 2026 10:00:00 GMT") => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${titles.map((t) => `<item><title>${t}</title><pubDate>${date}</pubDate></item>`).join("")}</channel></rss>`;

test("parseFeed reads RSS and Atom entries with dates", () => {
  const feed = parseFeed(rss(["Agent tracing for LLM apps", "Pricing update"]));
  assert.equal(feed.kind, "rss");
  assert.equal(feed.entries.length, 2);
  assert.ok(Number.isFinite(feed.entries[0].date));
  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Seer AI debugger</title><updated>2026-09-20T00:00:00Z</updated></entry></feed>`);
  assert.deepEqual(atom.entries.map(({ title }) => title), ["Seer AI debugger"]);
  assert.equal(parseFeed("<html><body>not a feed</body></html>"), null);
});

test("findFeeds uses autodiscovery links and rejects stale feeds", async () => {
  const pages = {
    "https://example.com/": `<html><head><link rel="alternate" type="application/rss+xml" href="/changelog/feed.xml"></head></html>`,
    "https://example.com/changelog/feed.xml": rss(["Seer now explains AI agent failures"]),
    "https://example.com/rss.xml": rss(["Old post"], "Mon, 01 Jan 2024 00:00:00 GMT"),
  };
  const fetcher = async (url) => {
    const body = pages[url] ?? pages[`${url}/`];
    return body ? new Response(body, { status: 200 }) : new Response("missing", { status: 404 });
  };
  const feeds = await findFeeds("example.com", { fetcher, now });
  assert.deepEqual(feeds.map(({ url }) => url), ["https://example.com/changelog/feed.xml"]);
  assert.equal(feeds[0].recentItems, 1);
});

test("parseGithubTrending extracts repos with daily and total stars", () => {
  const html = `<article class="Box-row"><h2><a href="/NousResearch/hermes-agent">NousResearch / hermes-agent</a></h2><p>Agent framework</p>
    <a href="/NousResearch/hermes-agent/stargazers">12,345</a><a href="/NousResearch/hermes-agent/forks">1,002</a><span>2,109 stars today</span></article>`;
  const [repo] = parseGithubTrending(html, now.toISOString());
  assert.equal(repo.url, "https://github.com/NousResearch/hermes-agent");
  assert.equal(repo.attention[0].score, 12345);
  assert.equal(repo.attention[0].scoreDelta, 2109);
  assert.match(repo.summary, /2,109 stars today/);
});

test("collectTrending reports a failed stream without dropping the others", async () => {
  const fetcher = async (url) => url.includes("api/models") ? new Response(JSON.stringify([{ id: "org/model", likes: 10, downloads: 5, trendingScore: 9, tags: ["license:mit"] }]))
    : url.includes("daily_papers") ? new Response("[]") : new Response("down", { status: 503 });
  const { items, health } = await collectTrending({ now, fetcher, githubToken: "test-token" });
  assert.equal(items.length, 1);
  assert.equal(items[0].attention[0].platform, "huggingface");
  // Trending models, daily papers and GitHub trending, then the lab organizations' new models and GitHub's new repositories.
  assert.deepEqual(health.map(({ stream }) => stream), ["huggingface-trending-models", "huggingface-daily-papers", "github-trending", "huggingface-org-models", "github-org-repos", "github-rising-repos"]);
  assert.deepEqual(health.map(({ status }) => status), ["ok", "ok", "failed", "ok", "failed", "failed"]);
});

test("missedPublishers counts uncovered hosts and weights aggregator links", () => {
  const hn = (url, title, score) => ({ title, url, summary: "", publishedAt: null, source: "Hacker News", category: "community signal", attention: [{ platform: "hacker-news", id: "1", url, measuredAt: "", previousMeasuredAt: null, elapsedHours: null, score, scoreDelta: null, scorePerHour: null, secondaryCount: 0, secondaryDelta: null }] });
  const misses = missedPublishers([
    hn("https://blog.sentry.io/seer-ai", "Sentry Seer uses an AI agent to fix bugs", 120),
    hn("https://openai.com/x", "OpenAI model update", 900),
    hn("https://example.org/garden", "Gardening tips", 400),
    hn("https://github.com/org/repo", "An agent repo", 300),
  ], [{ url: "https://sentry.io/changelog/x", title: "AlphaSignal pick" }], new Set(["openai.com"]));
  assert.deepEqual([...misses.keys()], ["sentry.io"]);
  assert.equal(misses.get("sentry.io").mentions, 3);
});

test("publisherDomain collapses app subdomains but keeps shared hosting sites", () => {
  assert.equal(publisherDomain("dashboard.sarvam.ai"), "sarvam.ai");
  assert.equal(publisherDomain("research.bbc.co.uk"), "bbc.co.uk");
  assert.equal(publisherDomain("someone.github.io"), "someone.github.io");
});

test("links present on most aggregator articles are treated as page chrome", () => {
  const links = Array.from({ length: 6 }, (_, i) => [
    { url: "https://www.googletagmanager.com/ns.html", title: `article ${i}` },
    { url: `https://publisher${i}.dev/post`, title: `article ${i}` },
  ]).flat();
  const misses = missedPublishers([], links, new Set());
  assert.equal(misses.has("googletagmanager.com"), false);
  assert.equal(misses.size, 6);
});

test("outboundLinks keeps external publisher links only", () => {
  const html = `<a href="https://www.databricks.com/blog/row-zero?utm_source=alphasignal">x</a><a href="https://alphasignal.ai/news/y">y</a><a href="https://x.com/a">z</a>`;
  assert.deepEqual(outboundLinks(html, "https://alphasignal.ai/news/z"), ["https://www.databricks.com/blog/row-zero"]);
});

test("classifyFeeds and registry lifecycle", async () => {
  const feed = (titles) => ({ url: "https://s.io/feed", kind: "rss", items: 3, recentItems: 3, latestAt: now.toISOString(), sampleTitles: titles });
  assert.equal(classifyFeeds([], 5), "no-feed");
  assert.equal(classifyFeeds([feed(["Quarterly results"])], 1), "off-topic");
  assert.equal(classifyFeeds([feed(["LLM tracing"])], 1), "probation");
  assert.equal(classifyFeeds([feed(["OpenAI investigates rogue agents", "FBI agents angry", "Election results", "Weather", "Football"])], 2), "off-topic");
  assert.equal(classifyFeeds([feed(["Fine-tuning Llama for support", "Serving LLMs on GPUs", "Company offsite"])], 1), "probation");
  assert.equal(classifyFeeds([feed(["Gemini 3.8 Flash in Antigravity"])], 2, true), "probation");
  const registry = { version: 1, sources: { "s.io": { domain: "s.io", status: "probation", feeds: [feed(["LLM tracing"])], firstSeenAt: "2026-09-01T00:00:00Z", checkedAt: "2026-09-10T00:00:00Z", mentions: 2, evidence: ["e"], curated: false } } };
  assert.equal(discoveredStreams(registry)[0].kind, "rss");
  const reviewed = await reviewSources(registry, { now, find: async () => [feed(["LLM agents GA"])], repos: async () => [] });
  assert.equal(reviewed.sources["s.io"].status, "active");
  const silent = await reviewSources(registry, { now, find: async () => [], repos: async () => [] });
  assert.equal(silent.sources["s.io"].status, "stale");
  assert.equal(discoveredStreams(silent).length, 0);
});

// 67 of the 121 discovered publishers sat at "no-feed": a blog with no RSS was never collected.
const html = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const site = (pages) => async (url) => (pages[url] === undefined ? new Response("missing", { status: 404 }) : html(pages[url]));

test("a publisher with no feed is found through the index pages that list several of its articles", async () => {
  const fetcher = site({
    "https://lab.test/": `<a href="/blog">Blog</a><a href="/about">About</a><a href="/careers">Jobs</a>`,
    "https://lab.test/blog": `<a href="/blog/launching-the-agent-platform">a</a><a href="/blog/how-we-built-memory">b</a><a href="/blog/benchmarks-for-retrieval">c</a>`,
    "https://lab.test/news": `<a href="/news/one-post-only">a</a>`,
  });
  const found = await findIndexPages("lab.test", { fetcher });
  assert.deepEqual(found.map(({ url }) => url), ["https://lab.test/blog"]);
  assert.equal(found[0].articles, 3);
  assert.deepEqual(found[0].sampleSlugs, ["launching-the-agent-platform", "how-we-built-memory", "benchmarks-for-retrieval"]);
  assert.deepEqual(await findIndexPages("nothing.test", { fetcher }), []);
});

test("an index page is on probation when an aggregator vetted the publisher or its articles are about AI", () => {
  const index = (...sampleSlugs) => ({ url: "https://s.io/blog", articles: sampleSlugs.length, sampleSlugs });
  assert.equal(classifyIndexes([], 5), "no-feed");
  assert.equal(classifyIndexes([index("quarterly-results-2026", "office-move")], 1), "off-topic");
  assert.equal(classifyIndexes([index("serving-llms-on-gpus", "fine-tuning-llama-for-support", "company-offsite")], 1), "probation");
  assert.equal(classifyIndexes([index("quarterly-results-2026")], 1, true), "probation");
  assert.equal(classifyIndexes([index("quarterly-results-2026")], 4), "probation");
});

test("a publisher without a feed is collected through its index page and falls back to stale when it goes quiet", async () => {
  const entry = { domain: "lab.test", status: "no-feed", feeds: [], indexes: [], firstSeenAt: "2026-09-20T00:00:00Z", checkedAt: "2026-08-01T00:00:00Z", mentions: 3, evidence: ["e"], curated: true, repos: [] };
  const registry = { version: 1, sources: { "lab.test": entry } };
  const index = { url: "https://lab.test/blog", articles: 3, sampleSlugs: ["a-post", "b-post", "c-post"] };
  const reviewed = await reviewSources(registry, { now, find: async () => [], repos: async () => [], indexes: async () => [index] });
  assert.equal(reviewed.sources["lab.test"].status, "probation");
  assert.deepEqual(reviewed.sources["lab.test"].indexes, ["https://lab.test/blog"]);
  const [stream] = discoveredStreams(reviewed);
  assert.equal(stream.kind, "html-news");
  assert.equal(stream.url, "https://lab.test/blog");
  assert.equal(stream.publisherId, "lab.test");
  const quiet = await reviewSources({ version: 1, sources: { "lab.test": { ...reviewed.sources["lab.test"], checkedAt: "2026-09-10T00:00:00Z" } } }, { now, find: async () => [], repos: async () => [], indexes: async () => [] });
  assert.equal(quiet.sources["lab.test"].status, "stale");
  assert.equal(discoveredStreams(quiet).length, 0);
});

test("one index page reached by two routes is reported once", async () => {
  // /blog and the home page's link to the www host both end at the same page.
  const pages = {
    "https://lab.test/": `<a href="https://www.lab.test/blog">Blog</a>`,
    "https://lab.test/blog": `<a href="/blog/launching-the-agent-platform">a</a><a href="/blog/how-we-built-memory">b</a><a href="/blog/benchmarks-for-retrieval">c</a>`,
    "https://www.lab.test/blog": `<a href="/blog/launching-the-agent-platform">a</a><a href="/blog/how-we-built-memory">b</a><a href="/blog/benchmarks-for-retrieval">c</a>`,
  };
  const redirecting = async (url, init) => url === "https://lab.test/blog" ? new Response(null, { status: 301, headers: { location: "https://www.lab.test/blog" } }) : site(pages)(url, init);
  const found = await findIndexPages("lab.test", { fetcher: redirecting });
  assert.deepEqual(found.map(({ url }) => url), ["https://www.lab.test/blog"]);
});

test("findFeeds keeps only the publisher's own feeds, never one a page advertises on another site or tenant", async () => {
  const pages = {
    "https://lab.test/": `<head><link rel="alternate" type="application/rss+xml" href="https://elsewhere.test/feed.xml"><link rel="alternate" type="application/rss+xml" href="https://lab.ghost.io/rss/"><link rel="alternate" type="application/rss+xml" href="https://feeds.feedburner.com/lab"><link rel="alternate" type="application/rss+xml" href="https://blog.lab.test/rss.xml"></head>`,
    "https://elsewhere.test/feed.xml": rss(["Somebody else's post about LLM agents"]),
    "https://lab.ghost.io/rss/": rss(["A hosted blog about LLM agents"]),
    "https://feeds.feedburner.com/lab": rss(["An aggregated post about LLM agents"]),
    "https://blog.lab.test/rss.xml": rss(["Our own post about LLM agents"]),
  };
  const feeds = await findFeeds("lab.test", { fetcher: site(pages), now });
  assert.deepEqual(feeds.map(({ url }) => url), ["https://blog.lab.test/rss.xml"]);
});
