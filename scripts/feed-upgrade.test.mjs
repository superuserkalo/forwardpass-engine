import assert from "node:assert/strict";
import test from "node:test";
import { chooseFeed, extractFeedLinks } from "../src/lib/feed-upgrade.ts";

// 196 of 612 public HTML routes advertise an RSS or Atom feed that the collector ignored while it
// guessed at article cards (docs/route-miss-research-2026-10-03.md). A feed gives dated items.

test("feed links come from autodiscovery tags in any attribute order, as absolute https URLs, once each", () => {
  const html = `<head>
    <link rel="alternate" type="application/rss+xml" title="Blog" href="/blog/rss.xml">
    <link href="https://lab.test/atom.xml" type="application/atom+xml" rel="alternate">
    <link rel="alternate" type="application/rss+xml" href="//cdn.lab.test/feed">
    <link rel="alternate" type="application/rss+xml" href="http://lab.test/insecure.xml">
    <link rel="alternate" type="application/rss+xml" href="/blog/rss.xml">
    <link rel="alternate" type="application/rss+xml" title="Comments" href="/comments/feed/">
    <link rel="stylesheet" href="/site.css"><link rel="alternate" type="application/json" href="/feed.json"></head>`;
  assert.deepEqual(extractFeedLinks(html, "https://lab.test/blog"), ["https://lab.test/blog/rss.xml", "https://lab.test/atom.xml", "https://cdn.lab.test/feed", "https://lab.test/insecure.xml"]);
  assert.deepEqual(extractFeedLinks("<html></html>", "https://lab.test/blog"), []);
});

const probe = (url, recent, extra = {}) => ({ url, kind: "rss", entries: 20, recent, latestAt: "2026-10-01T00:00:00Z", sampleTitles: ["A post"], ...extra });

test("the feed that matches the page's section wins, then the busier one, and a dead feed is never chosen", () => {
  assert.equal(chooseFeed("https://lab.test/research", [probe("https://lab.test/blog/rss.xml", 12), probe("https://lab.test/research/rss.xml", 3)])?.url, "https://lab.test/research/rss.xml");
  assert.equal(chooseFeed("https://lab.test/news", [probe("https://lab.test/a.xml", 2), probe("https://lab.test/b.xml", 9)])?.url, "https://lab.test/b.xml");
  assert.equal(chooseFeed("https://lab.test/news", [probe("https://lab.test/a.xml", 0)]), null);
  assert.equal(chooseFeed("https://lab.test/news", []), null);
});

import { upgradeTarget } from "../src/lib/feed-upgrade.ts";

test("forum category pages read their own category feed, never the site-wide reply stream, and GitHub pages are left alone", () => {
  // Discourse: appending .rss to a category URL gives that category's topics; /posts.rss is every reply on the site.
  assert.equal(upgradeTarget("https://discuss.huggingface.co/c/models/13", "https://discuss.huggingface.co/posts.rss"), "https://discuss.huggingface.co/c/models/13.rss");
  assert.equal(upgradeTarget("https://forum.cursor.com/c/announcements/11/", "https://forum.cursor.com/latest.rss"), "https://forum.cursor.com/c/announcements/11.rss");
  assert.equal(upgradeTarget("https://discuss.huggingface.co/", "https://discuss.huggingface.co/latest.rss"), "https://discuss.huggingface.co/latest.rss");
  // A forum's posts.rss is every reply on the site: never a substitute for a page of topics.
  assert.equal(upgradeTarget("https://discuss.huggingface.co/", "https://discuss.huggingface.co/posts.rss"), null);
  assert.equal(upgradeTarget("https://community.temporal.io/", "https://community.temporal.io/posts.rss"), null);
  assert.equal(upgradeTarget("https://github.com/vllm-project/vllm/releases", "https://github.com/vllm-project/vllm/releases.atom"), null);
  assert.equal(upgradeTarget("https://blog.cloudflare.com/", "https://blog.cloudflare.com/rss/"), "https://blog.cloudflare.com/rss/");
});

test("a changelog or release-notes page only reads a feed of the same kind, never the site's blog feed", () => {
  assert.equal(upgradeTarget("https://www.daytona.io/changelog", "https://www.daytona.io/rss.xml"), null);
  assert.equal(upgradeTarget("https://developers.openai.com/plugins/changelog", "https://developers.openai.com/rss.xml"), null);
  assert.equal(upgradeTarget("https://docs.litellm.ai/release_notes", "https://docs.litellm.ai/blog/rss.xml"), null);
  assert.equal(upgradeTarget("https://opensearch.org/releases/", "https://opensearch.org/feed/"), null);
  assert.equal(upgradeTarget("https://kiro.dev/changelog/", "https://kiro.dev/changelog/feed.rss"), "https://kiro.dev/changelog/feed.rss");
  assert.equal(upgradeTarget("https://platform.claude.com/docs/en/release-notes/overview", "https://platform.claude.com/docs/en/release-notes/feed.xml"), "https://platform.claude.com/docs/en/release-notes/feed.xml");
  assert.equal(upgradeTarget("https://changelog.exoscale.com/", "https://changelog.exoscale.com/rss.xml"), "https://changelog.exoscale.com/rss.xml");
  assert.equal(upgradeTarget("https://lab.test/blog", "https://lab.test/rss.xml"), "https://lab.test/rss.xml");
});

import { guessFeedLinks } from "../src/lib/feed-upgrade.ts";

test("conventional feed paths are guessed for a page that advertises none, section first, then the site", () => {
  const guesses = guessFeedLinks("https://cursor.com/changelog");
  assert.deepEqual(guesses.slice(0, 4), ["https://cursor.com/changelog/rss.xml", "https://cursor.com/changelog/feed.xml", "https://cursor.com/changelog/feed", "https://cursor.com/changelog/rss"]);
  assert.ok(guesses.includes("https://cursor.com/changelog.rss") && guesses.includes("https://cursor.com/feed") && guesses.includes("https://cursor.com/rss.xml") && guesses.includes("https://cursor.com/blog/rss.xml"));
  assert.equal(new Set(guesses).size, guesses.length, "each guess once");
  // A home page has no section; only the site-level paths apply.
  assert.ok(guessFeedLinks("https://lab.test/").every((url) => !url.includes("//rss") && new URL(url).pathname.split("/").length <= 3));
  // Trailing slashes and query strings do not leak into guesses.
  assert.equal(guessFeedLinks("https://lab.test/news/?page=2")[0], "https://lab.test/news/rss.xml");
});

test("a site-level feed only replaces a page that is itself a content section, never a listing, leaderboard or portfolio", () => {
  // Found by the guessing pass: pages that are not blogs paired with the site's blog feed.
  for (const [page, feed] of [
    ["https://huggingface.co/models?sort=trending", "https://huggingface.co/blog/feed.xml"],
    ["https://huggingface.co/papers", "https://huggingface.co/blog/feed.xml"],
    ["https://openrouter.ai/rankings", "https://openrouter.ai/blog/feed.xml"],
    ["https://www.antler.co/portfolio", "https://www.antler.co/blog/rss.xml"],
    ["https://crfm.stanford.edu/helm/", "https://crfm.stanford.edu/feed"],
    ["https://redditinc.com/policies/data-api-terms", "https://redditinc.com/news/rss.xml"],
    ["https://ollama.com/search", "https://ollama.com/blog/rss.xml"],
  ]) assert.equal(upgradeTarget(page, feed), null, page);
  for (const [page, feed] of [
    ["https://www.langchain.com/blog", "https://www.langchain.com/blog/rss.xml"],
    ["https://lab.test/", "https://lab.test/feed"],
    ["https://www.elastic.co/search-labs/blog", "https://www.elastic.co/blog/feed"],
    ["https://deepmind.google/research/projects/", "https://deepmind.google/blog/rss.xml"],
    ["https://openai.com/signals/", "https://openai.com/news/rss.xml"],
    ["https://cursor.com/changelog", "https://cursor.com/changelog/rss.xml"],
  ]) assert.equal(upgradeTarget(page, feed), feed, page);
});

import { sameSite } from "../src/lib/feed-upgrade.ts";

// A feed advertised by a page is only that publisher's if it is on the publisher's own site. On shared
// platforms one host serves many tenants, so the tenant must match too (route audit review, 3 Oct).
test("a feed must come from the publisher's own site, and from the same tenant on a shared platform", () => {
  const url = (value) => new URL(value);
  assert.equal(sameSite(url("https://www.lab.test/blog"), url("https://blog.lab.test/rss.xml")), true, "subdomains of one registrable domain are one site");
  assert.equal(sameSite(url("https://lab.test/blog"), url("https://evil.test/feed.xml")), false);
  assert.equal(sameSite(url("https://evernorthtech.medium.com/"), url("https://evernorthtech.medium.com/feed")), true, "the same publication");
  assert.equal(sameSite(url("https://evernorthtech.medium.com/"), url("https://other.medium.com/feed")), false, "another publication on the same host");
  assert.equal(sameSite(url("https://medium.com/@acme"), url("https://medium.com/feed/@acme")), true);
  assert.equal(sameSite(url("https://medium.com/@acme"), url("https://medium.com/feed/@other")), false, "another author on the same host");
  assert.equal(sameSite(url("https://acme.github.io/blog"), url("https://other.github.io/feed.xml")), false);
  assert.equal(sameSite(url("https://cline.bot/blog"), url("https://cline.ghost.io/rss/")), false, "a hosted blog on a shared platform is not proven to be theirs");
  assert.equal(sameSite(url("https://www.gene.com/news"), url("https://feeds.feedburner.com/Genentech-Stories")), false, "a feed aggregator carries anyone's feed");
  assert.equal(sameSite(url("https://feeds.feedburner.com/a"), url("https://feeds.feedburner.com/a")), false, "and is never trusted by address alone");
});

test("a page can only point its route at a feed of its own site, or of the catalog's owner host when the page moved", () => {
  assert.equal(upgradeTarget("https://cline.bot/blog", "https://cline.ghost.io/rss/", "cline.bot"), null);
  assert.equal(upgradeTarget("https://www.gene.com/scientists/publications", "https://feeds.feedburner.com/Genentech-Stories", "gene.com"), null);
  assert.equal(upgradeTarget("https://lab.test/blog", "https://evil.test/feed.xml", "lab.test"), null);
  assert.equal(upgradeTarget("https://medium.com/@acme", "https://medium.com/feed/@other", "medium.com"), null);
  assert.equal(upgradeTarget("https://acme.medium.com/", "https://acme.medium.com/feed", "acme.medium.com"), "https://acme.medium.com/feed");
  // Factory moved from factory.ai to factory.com: the catalog's owner host vouches for the new address.
  assert.equal(upgradeTarget("https://docs.factory.ai/changelog/release-notes", "https://docs.factory.com/changelog/rss.xml", "factory.com"), "https://docs.factory.com/changelog/rss.xml");
  assert.equal(upgradeTarget("https://docs.factory.ai/changelog/release-notes", "https://docs.factory.com/changelog/rss.xml", "elsewhere.test"), null);
});
