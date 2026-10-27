import assert from "node:assert/strict";
import test from "node:test";
import { articleMeta } from "../src/lib/article-meta.ts";

// 361 of 612 HTML routes yield only undated cards and 89 yield none, so items were reported with
// the time we first saw them, or not at all. The article page itself says when it was published.

const now = new Date("2026-10-03T12:00:00Z");
const page = (head, body = "<main><article><h1>Heading</h1><p>Text</p></article></main>") => `<html><head>${head}</head><body>${body}</body></html>`;

test("JSON-LD datePublished is the most trusted date", () => {
  const html = page(`<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Lab"},{"@type":"BlogPosting","headline":"Cohere ships Embed 5","description":"Faster retrieval.","datePublished":"2026-09-30T14:31:00Z","dateModified":"2026-10-01T09:00:00Z"}]}</script>
    <meta property="article:published_time" content="2026-01-01T00:00:00Z">`);
  const meta = articleMeta(html, "https://lab.test/blog/embed-5", now);
  assert.equal(meta.publishedAt, "2026-09-30T14:31:00.000Z");
  assert.equal(meta.title, "Cohere ships Embed 5");
  assert.equal(meta.description, "Faster retrieval.");
});

test("meta tags carry the date, with offsets normalised to UTC, and Open Graph carries the title", () => {
  const html = page(`<meta property="og:title" content="Introducing Praxis-1"><meta property="og:description" content="Robots learn from video."><meta property="og:type" content="article">
    <meta property="article:published_time" content="2026-09-30T16:31:00+02:00"><title>Introducing Praxis-1 | Runway</title>`);
  const meta = articleMeta(html, "https://runway.com/research/introducing-praxis-1", now);
  assert.equal(meta.publishedAt, "2026-09-30T14:31:00.000Z");
  assert.equal(meta.title, "Introducing Praxis-1");
  assert.equal(meta.type, "article");
});

test("a time element in the article and a date in the URL are the fallbacks, in that order", () => {
  const timed = page("<title>A post</title>", `<main><article><h1>A post</h1><time datetime="2026-09-29">Sep 29</time></article></main>`);
  assert.equal(articleMeta(timed, "https://lab.test/blog/2026/01/01/a-post", now).publishedAt, "2026-09-29T00:00:00.000Z");
  assert.equal(articleMeta(page("<title>A post | Lab</title>"), "https://lab.test/blog/2026/09/28/a-post", now).publishedAt, "2026-09-28T00:00:00.000Z");
  assert.equal(articleMeta(page("<title>A post | Lab</title>"), "https://lab.test/blog/a-post", now).publishedAt, null);
  // The site name after a separator is not part of the headline.
  assert.equal(articleMeta(page("<title>Embed 5 lets you query faster | Cohere</title>"), "https://lab.test/blog/a-post", now).title, "Embed 5 lets you query faster");
});

test("implausible dates are rejected", () => {
  for (const date of ["1970-01-01T00:00:00Z", "2031-01-01T00:00:00Z", "not a date", "2026-10-05T00:00:00Z"]) {
    assert.equal(articleMeta(page(`<meta property="article:published_time" content="${date}">`), "https://lab.test/blog/a", now).publishedAt, null, date);
  }
});
