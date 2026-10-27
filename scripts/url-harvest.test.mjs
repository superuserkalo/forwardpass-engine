import assert from "node:assert/strict";
import test from "node:test";
import { harvestUrls } from "../src/lib/url-harvest.ts";

// 89 of 612 HTML routes are blind to their own articles (Runway, Factory, MiniMax, Prime Intellect,
// Cursor's changelog): the page is rendered in the browser, so there are no article cards to read,
// but the article URLs are still in the HTML, in anchors or in the JSON the framework embeds.

const html = `<html><body>
  <nav><a href="/research/publications">Publications</a><a href="/research/category/robotics">Robotics</a><a href="/about">About</a></nav>
  <a href="/research/introducing-praxis-1">Praxis</a><a href="/research/gwm-worlds-2/">Worlds</a>
  <a href="/research/introducing-praxis-1?utm_source=x#top">again</a>
  <script id="__NEXT_DATA__" type="application/json">{"props":{"items":[{"href":"/research/solaris-world-model"},{"slug":"/research/runway-characters"}]}}</script>
  <script>self.__next_f.push([1,"{\\"url\\":\\"https://www.runway.com/research/aleph-two-release\\"}"])</script>
  <script>var legacy = "https:\\/\\/runway.com\\/research\\/escaped-slash-post";</script>
  <a href="https://other.test/research/not-this-host">other</a><a href="/research/page/2">next</a><a href="/research/tag/video">tag</a>
  <a href="/research/logo.png">image</a><a href="/research/feed.xml">feed</a><a href="/research/123">number</a><a href="/news/company-news/hello-world-post">another section</a>
</body></html>`;

test("article URLs under the page's section come from anchors and from embedded script JSON, once each, in document order", () => {
  assert.deepEqual(harvestUrls(html, "https://runway.com/research/publications"), [
    "https://runway.com/research/introducing-praxis-1", "https://runway.com/research/gwm-worlds-2", "https://runway.com/research/solaris-world-model",
    "https://runway.com/research/runway-characters", "https://runway.com/research/aleph-two-release", "https://runway.com/research/escaped-slash-post",
  ]);
});

test("a locale prefix is skipped when finding the section, and a home page has none", () => {
  const localized = `<a href="/en/blog/launching-the-agent-platform">a</a><a href="/en/about-the-company">b</a><a href="/en/blog/tag/ai">c</a>`;
  assert.deepEqual(harvestUrls(localized, "https://lab.test/en/blog"), ["https://lab.test/en/blog/launching-the-agent-platform"]);
  assert.deepEqual(harvestUrls(`<a href="/some-long-post-slug-here">a</a>`, "https://lab.test/"), []);
});

test("the limit bounds a very long archive", () => {
  const many = Array.from({ length: 100 }, (_, i) => `<a href="/blog/a-post-number-${i}">p</a>`).join("");
  assert.equal(harvestUrls(many, "https://lab.test/blog", 12).length, 12);
});

test("a home page that lists posts is read for the usual blog sections", () => {
  const home = `<a href="/blog/qwen3-release-notes/">a</a><a href="/news/open-weights-update">b</a><a href="/about-us-page">c</a><a href="/blog/tag/ai">d</a><a href="/pricing-and-plans">e</a>`;
  assert.deepEqual(harvestUrls(home, "https://qwenlm.github.io/"), ["https://qwenlm.github.io/blog/qwen3-release-notes", "https://qwenlm.github.io/news/open-weights-update"]);
});

test("an absurdly long path is not a candidate", () => {
  const huge = `<a href="/blog/${"a".repeat(5000)}">x</a><a href="/blog/a-reasonable-post">y</a>`;
  assert.deepEqual(harvestUrls(huge, "https://lab.test/blog"), ["https://lab.test/blog/a-reasonable-post"]);
});
