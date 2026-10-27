import assert from "node:assert/strict";
import test from "node:test";
import { collectSourceStreams } from "../src/lib/source-collector.ts";

// 361 of 612 HTML routes give only undated cards and 89 give none. A new card was reported with the
// time we first saw it, the first read of a route swallowed everything on the page, and a page
// rendered in the browser was a "page changed" blob. The article's own page says when it was published.

const stream = { id: "blog", publisher: "Lab", publisherId: "lab", section: "blog", category: "news", kind: "html-news", url: "https://lab.test/blog" };
const t0 = new Date("2026-09-24T12:00:00.000Z");
const t1 = new Date("2026-09-24T14:00:00.000Z");
const card = (slug, title) => `<article><h2><a href="/blog/${slug}">${title}</a></h2></article>`;
const index = (...cards) => `<main>${cards.join("")}</main>`;
const dated = (date, title = "Page") => `<html><head><meta property="og:title" content="${title}"><meta property="og:type" content="article"><meta property="article:published_time" content="${date}"></head><body><main><p>${"text ".repeat(60)}</p></main></body></html>`;
const html = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const site = (pages) => async (url) => (pages[url] === undefined ? new Response("missing", { status: 404 }) : html(pages[url]));
const run = (state, now, pages, extra = {}) => collectSourceStreams(state, { now, streams: [stream], fetcher: site(pages), ...extra });

test("a new undated card is reported with its article's publication date", async () => {
  const pages = { "https://lab.test/blog": index(card("old-post-here", "An older research project")), "https://lab.test/blog/old-post-here": dated("2026-08-01T10:00:00Z") };
  const first = await run(undefined, t0, pages);
  assert.equal(first.items.length, 0, "an old article on the first read is a baseline");
  pages["https://lab.test/blog"] = index(card("new-launch-post", "A newly listed launch"), card("old-post-here", "An older research project"));
  pages["https://lab.test/blog/new-launch-post"] = dated("2026-09-24T13:00:00Z");
  const second = await run(first.state, t1, pages);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].publishedAt, "2026-09-24T13:00:00.000Z");
  assert.equal(second.items[0].dateKind, "published");
  assert.equal(second.items[0].title, "A newly listed launch");
});

test("the first read of a route no longer swallows an article published inside the window", async () => {
  const pages = { "https://lab.test/blog": index(card("fresh-launch-post", "A fresh launch")), "https://lab.test/blog/fresh-launch-post": dated("2026-09-24T09:00:00Z") };
  const first = await run(undefined, t0, pages);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].publishedAt, "2026-09-24T09:00:00.000Z");
  assert.equal(first.health[0].baselineCount ?? 0, 0);
});

test("a new card whose article is older than the window is not news", async () => {
  const pages = { "https://lab.test/blog": index(card("first-post-ever", "The first post")) };
  const first = await run(undefined, t0, pages);
  pages["https://lab.test/blog"] = index(card("resurfaced-old-post", "A resurfaced post"), card("first-post-ever", "The first post"));
  pages["https://lab.test/blog/resurfaced-old-post"] = dated("2026-06-01T10:00:00Z");
  const second = await run(first.state, t1, pages);
  assert.equal(second.items.length, 0);
});

test("when the article page cannot be read the card is still reported as first seen", async () => {
  const pages = { "https://lab.test/blog": index(card("first-post-ever", "The first post")) };
  const first = await run(undefined, t0, pages);
  pages["https://lab.test/blog"] = index(card("brand-new-post", "A brand new post"), card("first-post-ever", "The first post"));
  const second = await run(first.state, t1, pages);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].publishedAt, null);
  assert.equal(second.items[0].dateKind, "first-seen");
});

test("resolution is bounded per route and never drops the cards beyond the bound", async () => {
  const pages = { "https://lab.test/blog": index(card("seed-post-one", "Seed post")) };
  const first = await run(undefined, t0, pages);
  const slugs = Array.from({ length: 12 }, (_, i) => `new-post-number-${i}`);
  pages["https://lab.test/blog"] = index(...slugs.map((slug, i) => card(slug, `New post number ${i}`)), card("seed-post-one", "Seed post"));
  for (const slug of slugs) pages[`https://lab.test/blog/${slug}`] = dated("2026-09-24T13:00:00Z");
  let articleFetches = 0;
  const counting = async (url, init) => { if (url !== "https://lab.test/blog") articleFetches++; return site(pages)(url, init); };
  const second = await collectSourceStreams(first.state, { now: t1, streams: [stream], fetcher: counting });
  assert.equal(second.items.length, 12);
  assert.equal(articleFetches, 8);
  assert.equal(second.items.filter((item) => item.publishedAt).length, 8);
});

const shell = (links) => `<html><body><main>${"A page rendered in the browser. ".repeat(10)}${links.map((slug) => `<a href="/blog/${slug}">Read more</a>`).join("")}</main></body></html>`;

test("a page with no readable cards yields the article URLs it links, with titles and dates from the articles", async () => {
  const pages = { "https://lab.test/blog": shell(["introducing-agent-mode"]), "https://lab.test/blog/introducing-agent-mode": dated("2026-08-01T10:00:00Z") };
  const first = await run(undefined, t0, pages);
  assert.equal(first.items.length, 0);
  assert.equal(first.health[0].status, "ok");
  pages["https://lab.test/blog"] = shell(["new-model-launch", "introducing-agent-mode"]);
  pages["https://lab.test/blog/new-model-launch"] = dated("2026-09-24T13:30:00Z", "Lab launches a new model");
  const second = await run(first.state, t1, pages);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].url, "https://lab.test/blog/new-model-launch");
  assert.equal(second.items[0].title, "Lab launches a new model");
  assert.equal(second.items[0].publishedAt, "2026-09-24T13:30:00.000Z");
});

test("a harvested link whose page is an error page is not an item", async () => {
  const pages = { "https://lab.test/blog": shell(["introducing-agent-mode"]), "https://lab.test/blog/introducing-agent-mode": dated("2026-08-01T10:00:00Z") };
  const first = await run(undefined, t0, pages);
  pages["https://lab.test/blog"] = shell(["broken-link-page", "introducing-agent-mode"]);
  pages["https://lab.test/blog/broken-link-page"] = `<html><head><title>Page not found</title></head><body><main>${"Sorry. ".repeat(40)}</main></body></html>`;
  const second = await run(first.state, t1, pages);
  assert.equal(second.items.length, 0);
});

test("resolution stops when the run's time budget is spent, and the cards are still reported", async () => {
  const pages = { "https://lab.test/blog": index(card("seed-post-one", "Seed post")) };
  const first = await run(undefined, t0, pages);
  const slugs = Array.from({ length: 6 }, (_, i) => `slow-post-number-${i}`);
  pages["https://lab.test/blog"] = index(...slugs.map((slug, i) => card(slug, `Slow post number ${i}`)), card("seed-post-one", "Seed post"));
  for (const slug of slugs) pages[`https://lab.test/blog/${slug}`] = dated("2026-09-24T13:00:00Z");
  let clock = 0, articleFetches = 0;
  const slow = async (url, init) => { if (url !== "https://lab.test/blog") { articleFetches++; clock += 20_000; } return site(pages)(url, init); };
  const second = await collectSourceStreams(first.state, { now: t1, streams: [stream], fetcher: slow, clock: () => clock, resolveBudgetMs: 50_000 });
  assert.equal(second.items.length, 6, "every new card is reported");
  assert.equal(articleFetches, 3, "20s each: the third fetch ends past the 50s budget, so no fourth starts");
});

test("a malformed percent sequence in a link cannot fail the route", async () => {
  const pages = { "https://lab.test/blog": shell(["introducing-agent-mode"]), "https://lab.test/blog/introducing-agent-mode": dated("2026-08-01T10:00:00Z") };
  const first = await run(undefined, t0, pages);
  pages["https://lab.test/blog"] = shell(["%E0%A4%A-bad-slug-post", "introducing-agent-mode"]);
  const second = await run(first.state, t1, pages);
  assert.equal(second.health[0].status, "ok");
});

// ---- how long an undated card is remembered

test("an undated card is remembered for as long as it is listed, and forgotten, with its mark, thirty days after it was last seen", async () => {
  const DAY = 86_400_000;
  const at = (days) => new Date(t0.getTime() + days * DAY);
  const both = index(card("evergreen-page", "An evergreen page"), card("vanished-page", "A page that went away"));
  const only = index(card("evergreen-page", "An evergreen page"));
  const pages = { "https://lab.test/blog": both };
  const evergreen = "blog:https://lab.test/blog/evergreen-page";
  const vanished = "blog:https://lab.test/blog/vanished-page";
  let state = (await run(undefined, t0, pages)).state;
  assert.deepEqual(Object.keys(state.streams.blog.seen).sort(), [evergreen, vanished]);

  pages["https://lab.test/blog"] = only;
  for (const days of [20, 45]) {
    const poll = await run(state, at(days), pages);
    assert.equal(poll.items.length, 0, `day ${days}: nothing is news, however long the card has been listed`);
    state = poll.state;
    if (days === 20) assert.deepEqual(Object.keys(state.streams.blog.seen).sort(), [evergreen, vanished], "twenty days after it was last seen, a card is still remembered");
  }
  assert.deepEqual(Object.keys(state.streams.blog.seen), [evergreen], "the card still listed is remembered; the one gone for more than thirty days is not");
  assert.deepEqual(state.streams.blog.undatedIds, [evergreen], "and its mark goes with it");
  assert.equal(state.streams.blog.seen[evergreen], at(45).toISOString(), "a card is remembered from the last time it was seen, not the first");

  const again = await run(state, at(46), pages);
  assert.equal(again.items.length, 0, "a card that has been listed all along is not announced as new");
});
