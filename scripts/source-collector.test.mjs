import assert from "node:assert/strict";
import test from "node:test";
import { collectSourceStreams, shortlistSourceItems, scoreSourceItem } from "../src/lib/source-collector.ts";

import { SOURCE_STREAMS } from "../src/lib/source-streams.ts";

const now = new Date("2026-09-24T12:00:00.000Z");
const rss = { id: "rss", publisher: "Publisher", publisherId: "publisher", section: "blog", category: "primary announcement", kind: "rss", url: "https://example.test/rss.xml" };
const atom = { id: "atom", publisher: "Other", publisherId: "other", section: "changelog", category: "developer tooling", kind: "atom", url: "https://example.test/atom" };
const releases = { id: "releases", publisher: "Repo", publisherId: "repo", section: "repo releases", category: "software release", kind: "github-releases", url: "https://api.github.test/releases" };
const newsroom = { id: "newsroom", publisher: "Lab", publisherId: "lab", section: "newsroom", category: "primary announcement", kind: "html-news", url: "https://lab.test/news" };
const rssBody = `<rss><channel><item><guid>stable-1</guid><title>New agent API</title><link>https://example.test/new-agent?utm_source=rss</link><description>Release details</description><pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item><item><title>Old news</title><link>https://example.test/old</link><pubDate>Mon, 14 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
const atomBody = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>entry-1</id><title>Another launch</title><link href="https://example.test/launch"/><updated>2026-09-24T09:00:00Z</updated></entry></feed>`;
const releaseBody = JSON.stringify([
  { id: 12, name: "v2.0.0", tag_name: "v2.0.0", html_url: "https://github.com/acme/repo/releases/tag/v2.0.0", published_at: "2026-09-24T08:00:00Z", body: "Important changes", draft: false },
  { id: 13, name: "draft", html_url: "https://github.com/acme/repo/releases/tag/draft", published_at: "2026-09-24T08:00:00Z", draft: true },
]);
const newsroomBody = `<main><a href="/model-release" class="FeaturedGrid-content"><h2>Introducing Model 5.5</h2><time>Sep 22, 2026</time><p>Faster inference</p></a><a href="https://elsewhere.test/story"><h2>Outside</h2><time>Sep 23, 2026</time></a></main>`;

test("collector deduplication preserves case-sensitive paths and meaningful version queries", async () => {
  const urls = ["https://example.test/Report?v=1", "https://example.test/Report?v=2", "https://example.test/report?v=2", "https://example.test/Report?v=1&utm_source=rss"];
  const body = `<rss><channel>${urls.map((url, index) => `<item><guid>${index}</guid><title>Deployment ${index}</title><link>${url.replaceAll("&", "&amp;")}</link><pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`;
  const result = await collectSourceStreams(undefined, { now, streams: [rss], fetcher: async () => new Response(body) });
  assert.equal(result.items.length, 3);
  assert.equal(result.duplicateCount, 1);
});

// DigiTimes, and two other routes in production on 9 October, answer HTTP 406 to a request that names only XML types. Every browser
// and feed reader adds a wildcard at a low weight, and the publisher then serves the feed.
test("a feed is asked for in XML first, with a low-weight wildcard so a publisher that is strict about Accept still answers", async () => {
  for (const stream of [rss, atom]) {
    const seen = [];
    const strict = async (url, init) => {
      const accept = new Headers(init?.headers).get("accept") ?? "";
      seen.push(accept);
      return /\*\/\*/.test(accept) ? new Response(stream === rss ? rssBody : atomBody) : new Response("Not Acceptable", { status: 406 });
    };
    const result = await collectSourceStreams(undefined, { now, streams: [stream], fetcher: strict });
    assert.equal(result.items.length, 1, `${stream.kind}: ${seen.join(" | ")}`);
    assert.match(seen[0], /^application\/atom\+xml, application\/rss\+xml, application\/xml/, "XML stays first");
    assert.match(seen[0], /\*\/\*;q=0\.1$/, "and the wildcard comes last, at the lowest weight");
  }
  // A page is asked for as a page, with the same wildcard (a government site in production answered 406 to "text/html" alone), and JSON stays JSON.
  const accepts = [];
  await collectSourceStreams(undefined, { now, streams: [newsroom, releases], fetcher: async (url, init) => { accepts.push(new Headers(init?.headers).get("accept")); return new Response("[]"); } });
  assert.deepEqual(accepts.sort(), ["application/json", "text/html, application/xhtml+xml;q=0.9, */*;q=0.1"]);
});

// Nebius's feed escapes its HTML twice, so a title arrives as "&lt;p&gt;Nebius achieves ... on&amp;nbsp;NVIDIA ..." once the XML is read. A title and a
// summary are plain text; tags that are tags are gone, entities are decoded, and a title that only looks like it has a tag (a Rust type) is left alone.
test("a feed title and summary are plain text, even when the feed escaped its HTML twice", async () => {
  const entries = [
    ["&amp;lt;p&amp;gt;Nebius achieves NVIDIA Exemplar Cloud on&amp;amp;nbsp;NVIDIA HGX B300&amp;lt;/p&amp;gt;", "Nebius achieves NVIDIA Exemplar Cloud on NVIDIA HGX B300"],
    ["&lt;b&gt;Intel&lt;/b&gt; ships 18A&amp;nbsp;chips", "Intel ships 18A chips"],
    ["AT&amp;T buys 5G spectrum for $2&amp;nbsp;billion", "AT&T buys 5G spectrum for $2 billion"],
    ["Understanding Vec&lt;T&gt; and Option&lt;T&gt; in Rust", "Understanding Vec<T> and Option<T> in Rust"],
    ["Why 5 &lt; 6 and 7 &gt; 3 matters", "Why 5 < 6 and 7 > 3 matters"],
    ["It&amp;#8217;s a &amp;quot;fast&amp;quot; model", "It’s a \"fast\" model"],
  ];
  const body = `<rss><channel>${entries.map(([title], i) => `<item><guid>g${i}</guid><title>${title}</title><link>https://example.test/p${i}</link><description>${title}</description><pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`;
  const result = await collectSourceStreams(undefined, { now, streams: [rss], fetcher: async () => new Response(body) });
  assert.deepEqual(result.items.map((item) => item.title).sort(), entries.map(([, plain]) => plain).sort());
  const nebius = result.items.find((item) => item.url.endsWith("/p0"));
  assert.equal(nebius.summary, "Nebius achieves NVIDIA Exemplar Cloud on NVIDIA HGX B300");
});

test("normalizes RSS, Atom, and named GitHub releases without using a model", async () => {
  const bodies = new Map([[rss.url, rssBody], [atom.url, atomBody], [releases.url, releaseBody]]);
  const fetcher = async (url) => new Response(bodies.get(url), { status: 200, headers: { ETag: '"revision-1"' } });
  const first = await collectSourceStreams(undefined, { now, streams: [rss, atom, releases], fetcher });
  assert.deepEqual(first.health.map(({ status }) => status), ["ok", "ok", "ok"]);
  assert.equal(first.items.length, 3);
  assert.equal(first.items.find((item) => item.streamId === "rss").id, "rss:stable-1");
  assert.equal(first.items.find((item) => item.streamId === "atom").url, "https://example.test/launch");
  assert.equal(first.items.find((item) => item.streamId === "releases").title, "repo releases: v2.0.0");
  assert.equal(first.state.streams.rss.etag, '"revision-1"');

  const second = await collectSourceStreams(first.state, { now: new Date(now.getTime() + 60_000), streams: [rss, atom, releases], fetcher });
  assert.equal(second.items.length, 0);
  assert.equal(second.health.every((row) => row.status === "ok"), true);
});

test("conditional 304 and source failure preserve checkpoint and report coverage separately", async () => {
  const state = { version: 1, streams: { rss: { etag: '"old"', lastSucceededAt: "2026-09-23T12:00:00Z", seen: { "rss:stable-1": "2026-09-23T10:00:00Z" } } } };
  const result = await collectSourceStreams(state, {
    now,
    streams: [rss, atom],
    fetcher: async (url, init) => {
      if (url === rss.url) {
        assert.equal(init.headers["If-None-Match"], '"old"');
        return new Response(null, { status: 304 });
      }
      return new Response("unavailable", { status: 503 });
    },
  });
  assert.deepEqual(result.health.map(({ status }) => status), ["unchanged", "failed"]);
  assert.equal(result.health[1].error, "HTTP 503");
  assert.equal(result.state.streams.rss.seen["rss:stable-1"], "2026-09-23T10:00:00Z");
  assert.equal(result.state.streams.atom, undefined);
});

test("undated feed entries are baselined without fabricated publication dates", async () => {
  const result = await collectSourceStreams(undefined, {
    now, streams: [rss],
    fetcher: async () => new Response("<rss><channel><item><title>Undated launch</title><link>https://example.test/launch</link></item></channel></rss>"),
  });
  assert.equal(result.health[0].status, "ok");
  assert.equal(result.health[0].baselineCount, 1);
  assert.equal(result.items.length, 0);
});

test("normalizes dated HTML newsroom items and excludes outside links", async () => {
  const result = await collectSourceStreams(undefined, {
    now, streams: [newsroom],
    fetcher: async () => new Response(newsroomBody, { status: 200 }),
  });
  assert.equal(result.health[0].status, "ok");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://lab.test/model-release");
  assert.equal(result.items[0].title, "Introducing Model 5.5");
  assert.equal(result.items[0].publishedAt, "2026-09-22T00:00:00.000Z");
});

test("shortlist caps noisy streams but retains all raw candidates", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `paper-${index}`, streamId: "arxiv-cs-ai", publisherId: "arxiv", title: `Paper ${index}`,
    score: 8, category: "research", publishedAt: now.toISOString(),
  }));
  items.push(...Array.from({ length: 3 }, (_, index) => ({
    id: `news-${index}`, streamId: "openai-news", publisherId: "openai", title: `News ${index}`,
    score: 7, category: "primary announcement", publishedAt: now.toISOString(),
  })));
  const shortlist = shortlistSourceItems(items);
  assert.equal(items.length, 23);
  assert.equal(shortlist.length, 7);
  assert.equal(shortlist.filter((item) => item.streamId === "arxiv-cs-ai").length, 4);
});

const scored = (title, summary = "", extra = {}) => scoreSourceItem({
  title, summary, publishedAt: now.toISOString(), ...extra,
}, now);

test("discovery priority is invariant to model brand, publisher labels and paper category", () => {
  const unfamiliar = scored("Benchmarking Zephyr inference", "Evaluation against a baseline");
  for (const brand of ["GPT-6", "Claude", "Gemini", "Grok", "Qwen", "DeepSeek", "Llama", "Mistral", "Kimi"]) {
    assert.deepEqual(scored(`Benchmarking ${brand} inference`, "Evaluation against a baseline"), unfamiliar);
  }
  for (const category of ["research", "primary announcement", "developer tooling", "software release"]) {
    for (const publicationCategory of ["Research", "Product", "Company", "Startup", ""]) {
      assert.deepEqual(scored("Benchmarking Zephyr inference", "Evaluation against a baseline", { category, publicationCategory }), unfamiliar);
    }
  }
});

test("deployment lessons and research evidence survive neutral formatting and industry labels", () => {
  const summary = "An inference deployment measures latency and memory, with a reproducible evaluation.";
  const neutral = scored("Serving language models", summary);
  for (const prefix of ["Case study: ", "How to: ", "Guide to ", "Research: "]) {
    assert.deepEqual(scored(`${prefix}Serving language models`, summary), neutral);
  }
  for (const industry of ["healthcare", "financial", "chemistry", "marketing"]) {
    assert.deepEqual(scored(`Serving language models for ${industry}`, summary), neutral);
  }
  assert.ok(neutral.score > scored("Introducing our new AI model").score);
  assert.ok(scored("Learning under constraints", summary).score > scored("Learning under constraints").score);
  assert.ok(neutral.scoreReasons.some((reason) => reason.includes("Operational")));
  assert.ok(neutral.scoreReasons.some((reason) => reason.includes("Evaluation")));
});

test("version numbers are neutral and invalid/future dates earn no freshness bonus", () => {
  assert.deepEqual(scored("Inference SDK v1.2.3"), scored("Inference SDK"));
  const old = scored("Inference", "", { publishedAt: "2026-09-20T12:00:00Z" });
  for (const publishedAt of [null, "bad-date", "2026-09-25T12:00:00Z"]) {
    assert.equal(scored("Inference", "", { publishedAt }).score, old.score);
  }
});

test("publisher caps span real Google and Vercel streams and selection ignores input order", async () => {
  const ids = ["deepmind-blog", "google-deepmind-news", "google-developer-tools", "vercel-news", "github-vercel-ai", "anthropic-news"];
  // Same RSS fixture format isolates stream ownership from format-specific parsing.
  const streams = SOURCE_STREAMS.filter((stream) => ids.includes(stream.id)).map((stream) => ({ ...stream, kind: "rss" }));
  const result = await collectSourceStreams(undefined, { now, streams, fetcher: async (url) => {
    const stream = streams.find((row) => row.url === url);
    return new Response(`<rss><channel>${Array.from({ length: 4 }, (_, i) => `<item><guid>${i}</guid><title>Inference evaluation ${i}</title><link>https://example.test/${stream.id}/${i}</link><pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`);
  } });
  assert.equal(result.items.length, 24);
  assert.equal(result.shortlist.length, 12);
  for (const publisherId of ["google", "vercel", "anthropic"]) {
    assert.equal(result.shortlist.filter((item) => item.publisherId === publisherId).length, 4);
  }
  assert.deepEqual(shortlistSourceItems([...result.items].reverse()), result.shortlist);
  assert.equal(shortlistSourceItems(result.items, 3).length, 3);
  assert.equal(new Set(shortlistSourceItems(result.items, 3).map((item) => item.publisherId)).size, 3);
  assert.deepEqual(shortlistSourceItems(result.items, 0), []);
});

test("package release bursts consume one repository slot while substantive blog posts compete normally", () => {
  const items = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `release-${i}`, publisherId: "vercel", streamId: "github-vercel-ai", category: "software release", score: 9, publishedAt: now.toISOString() })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `blog-${i}`, publisherId: "vercel", streamId: "vercel-news", category: "developer tooling", score: 8, publishedAt: now.toISOString() })),
  ];
  const selected = shortlistSourceItems(items);
  assert.equal(selected.length, 4);
  assert.equal(selected.filter((item) => item.category === "software release").length, 1);
  assert.equal(items.length, 34);
});

test("sitemap streams list article URLs under the path pattern as undated records", async () => {
  const { sitemapIndex } = await import("../src/lib/source-index.ts");
  const stream = { id: "s", publisher: "Runway", publisherId: "runway.com", section: "Sitemap", category: "news", kind: "sitemap", url: "https://runway.com/sitemap.xml", match: "^/news/company-news/[a-z0-9-]+$" };
  const body = "<urlset><url><loc>https://runway.com/news/company-news/introducing-runway-ads</loc></url><url><loc>https://runway.com/pricing</loc></url><url><loc>https://runway.com/news/company-news</loc></url></urlset>";
  const records = sitemapIndex(stream, body);
  assert.deepEqual(records.map(({ link, title, undated }) => ({ link, title, undated })), [
    { link: "https://runway.com/news/company-news/introducing-runway-ads", title: "Runway: Introducing Runway Ads", undated: true },
  ]);
});

test("markdown changelogs with month and day headings become dated entries with their own anchors", async () => {
  const { markdownIndex } = await import("../src/lib/source-index.ts");
  const stream = { id: "m", publisher: "OpenAI Developers", publisherId: "developers.openai.com", section: "API changelog", category: "changelog", kind: "markdown", url: "https://developers.openai.com/api/docs/changelog.md" };
  const body = "# Changelog\n\n## September, 2026\n\n### Sep 29\n\nFeature · Model: gpt-6.1-sol\n\nReleased [GPT-6.1 Sol](https://x.example) for complex coding work. More text.\n\n### Sep 25\n\nFixed a bug in image encoding that degraded image understanding.\n";
  const records = markdownIndex(stream, body);
  assert.deepEqual(records.map(({ pubDate, title }) => ({ pubDate, title })), [
    { pubDate: "2026-09-29", title: "Released GPT-6.1 Sol for complex coding work." },
    { pubDate: "2026-09-25", title: "Fixed a bug in image encoding that degraded image understanding." },
  ]);
  assert.notEqual(records[0].link, records[1].link);
  assert.match(String(records[0].link), /^https:\/\/developers\.openai\.com\/api\/docs\/changelog#2026-09-29-/);
});

// ---- what the state remembers
// The state is read whole to commit each run and cut into the shards, in a Worker with 128 MB: what it holds must be bounded by what the
// collector can still use, not by how long it has been running.
const DAY = 86_400_000;
const ago = (days) => new Date(now.getTime() - days * DAY).toISOString();
// A feed has to have an item to be a feed; this one has a fresh one.
const freshFeed = async () => new Response(`<rss><channel><item><guid>fresh</guid><title>A fresh announcement of an agent API</title><link>https://example.test/fresh</link><pubDate>${new Date(now.getTime() - 3_600_000).toUTCString()}</pubDate></item></channel></rss>`);

test("a dated item is forgotten after ten days, since nothing that old is ever reported again, and a newer one is kept", async () => {
  const state = { version: 1, streams: { rss: { lastSucceededAt: ago(1), seen: { "rss:nine": ago(9), "rss:ten-ish": ago(9.9), "rss:eleven": ago(11), "rss:forty": ago(40) } } } };
  const result = await collectSourceStreams(state, { now, streams: [rss], fetcher: freshFeed });
  assert.equal(result.health[0].status, "ok");
  assert.deepEqual(Object.keys(result.state.streams.rss.seen).sort(), ["rss:fresh", "rss:nine", "rss:ten-ish"]);
});

test("an item older than the backfill window is not reported again whether or not it is remembered", async () => {
  const old = `<rss><channel><item><guid>old</guid><title>An old announcement of a product</title><link>https://example.test/old</link><pubDate>${new Date(now.getTime() - 12 * DAY).toUTCString()}</pubDate></item></channel></rss>`;
  const state = { version: 1, streams: { rss: { lastSucceededAt: ago(1), seen: {} } } };
  const result = await collectSourceStreams(state, { now, streams: [rss], fetcher: async () => new Response(old) });
  assert.equal(result.items.length, 0, "so forgetting it after ten days cannot bring it back");
});
