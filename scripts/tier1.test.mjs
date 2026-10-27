import assert from "node:assert/strict";
import test from "node:test";
import { clusterCandidates, shortlistClusters } from "../src/pipeline/candidates.ts";
import { isTier1, isTier1FirstParty } from "../src/pipeline/tier1.ts";

// Found by replaying 28 Sep to 3 Oct: blog.google, claude.com, github.blog, blog.cloudflare.com and
// runway.com posts were collected and then lost to HN-driven ranking (docs/route-miss-research-2026-10-03.md).

const item = (title, url, extra = {}) => ({ title, summary: "", url, publishedAt: "2026-10-01T10:00:00Z", source: "Lab", category: "news", ...extra });
const hn = (score) => [{ platform: "hacker-news", id: String(score), url: "https://x.test", measuredAt: "2026-10-01T11:00:00Z", previousMeasuredAt: null, elapsedHours: null, score, scoreDelta: null, scorePerHour: null, secondaryCount: 3, secondaryDelta: null }];

// Hugging Face hosts anyone's writing under /blog: official posts are /blog/<slug>, an organisation's are /blog/<org>/<slug>,
// and a community member's are /blog/<user>/<slug>, which are not the publisher's words and must not be treated as them.
test("a Hugging Face post is tier-1 when HF or a lab's own organisation wrote it, not when a community member did", () => {
  for (const url of ["https://huggingface.co/blog", "https://huggingface.co/blog/", "https://huggingface.co/blog/smolagents", "https://huggingface.co/blog/meta-llama/llama-4", "https://huggingface.co/blog/nvidia/nemotron-launch", "https://huggingface.co/meta-llama/Llama-4"]) {
    assert.equal(isTier1(url), true, url);
  }
  for (const url of ["https://huggingface.co/blog/some-random-user/my-post", "https://huggingface.co/blog/zh/smolagents", "https://huggingface.co/blog/some-random-user/my-post/part-2", "https://huggingface.co/spaces/someone/app", "https://huggingface.co/someone/their-model"]) {
    assert.equal(isTier1(url), false, url);
  }
  assert.equal(isTier1FirstParty({ url: "https://huggingface.co/blog/some-random-user/my-post", source: "Hugging Face", category: "developer tooling" }), false, "so a community article is no tier-1 launch");
  assert.equal(isTier1FirstParty({ url: "https://huggingface.co/blog/smolagents", source: "Hugging Face", category: "developer tooling" }), true);
});

// The path rules read the path as the server routes it. An encoded slash or backslash is one segment to a pattern and a
// separator to the server, so a community article could pass as an official post; and the list of hosts that are not
// announcements has to hold wherever the label sits, or a nested subdomain falls through to its tier-1 parent.
test("an encoded separator never lets a path rule match, and a community or support host is never an announcement at any depth", () => {
  for (const url of ["https://huggingface.co/blog/some-random-user%2Fmy-post", "https://huggingface.co/blog/some-random-user%2fmy-post", "https://huggingface.co/blog/meta-llama%2Fllama-4", "https://huggingface.co/blog/some-random-user%5Cmy-post", "https://huggingface.co/blog%2Fsome-random-user/my-post", "https://huggingface.co/meta-llama%2Fcommunity-fork"]) {
    assert.equal(isTier1(url), false, url);
  }
  assert.equal(isTier1("https://huggingface.co/blog/smolagents"), true, "an ordinary path still matches");
  assert.equal(isTier1("https://huggingface.co/blog/a/%2e%2e/smolagents"), true, "dot segments are resolved by the URL parser, so this is the official post");
  for (const url of ["https://community.openai.com/t/x/1", "https://eu.community.openai.com/t/x/1", "https://cdn.status.openai.com/", "https://x.support.claude.com/en/articles/1", "https://help.openai.com/en/articles/1", "https://a.b.forum.cloudflare.com/t/1", "https://discuss.huggingface.co/t/x/1", "https://us.discourse.openai.com/"]) {
    assert.equal(isTier1(url), false, url);
  }
  for (const url of ["https://blog.cloudflare.com/clef-decision-models", "https://openai.com/index/x", "https://developers.openai.com/codex/changelog", "https://platform.claude.com/docs/en/release-notes/overview"]) {
    assert.equal(isTier1(url), true, url);
  }
});

test("tier-1 matching covers the labs and tools that were being missed, and not forums or ordinary repos", () => {
  for (const url of [
    "https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-skills/",
    "https://research.google/blog/toward-provably-private-learning/", "https://claude.com/blog/claude-code-mods", "https://platform.claude.com/docs/en/release-notes/overview",
    "https://github.blog/changelog/2026-09-30-hydrafusion", "https://blog.cloudflare.com/clef-decision-models", "https://runway.com/research/introducing-praxis-1",
    "https://zed.dev/releases/stable", "https://cohere.com/blog/embed-5", "https://www.perplexity.ai/hub/blog/computer", "https://developers.openai.com/codex/changelog",
    "https://www.anthropic.com/news/claude-opus-5-5", "https://huggingface.co/blog/ettin",
  ]) assert.equal(isTier1(url), true, url);
  for (const url of [
    "https://community.openai.com/t/api-question/123", "https://support.claude.com/en/articles/1", "https://startup.test/blog/launch",
    "https://github.com/someone/their-repo", "https://huggingface.co/someone/their-model", "https://news.ycombinator.com/item?id=1", "not a url",
  ]) assert.equal(isTier1(url), false, url);
});

test("first-party means the publisher's own item, never a community submission or a leaderboard", () => {
  assert.equal(isTier1FirstParty(item("Embed 5", "https://cohere.com/blog/embed-5")), true);
  assert.equal(isTier1FirstParty(item("Codex changelog", "https://developers.openai.com/codex/changelog#a", { category: "changelog" })), true);
  assert.equal(isTier1FirstParty(item("Embed 5 on HN", "https://cohere.com/blog/embed-5", { source: "Hacker News", category: "community signal" })), false);
  assert.equal(isTier1FirstParty(item("Leaderboard", "https://artificialanalysis.ai/leaderboards/models", { category: "rankings" })), false);
  assert.equal(isTier1FirstParty(item("Release", "https://pypi.org/project/openai/1.2.3/", { category: "software release" })), false);
});

test("a first-party post from a tier-1 publisher reaches triage however little attention it has", () => {
  // Every title has its own tokens so no two noise items cluster together.
  const noise = Array.from({ length: 600 }, (_, i) => item(`alpha${i} beta${i} gamma${i} delta${i} epsilon${i}`, `https://s${i}.test/p`, { source: "Hacker News", category: "community signal", attention: hn(400 - (i % 300)) }));
  const quiet = item("Google turns Gems into Gemini skills for free users", "https://blog.google/products/gemini/gemini-skills/", { source: "Google Keyword Blog" });
  const clusters = clusterCandidates([...noise, quiet]);
  assert.ok(clusters.findIndex((c) => c.lead.url === quiet.url) >= 450, "the post ranks below the usual cut");
  assert.ok(shortlistClusters(clusters).some((c) => c.lead.url === quiet.url), "but it is shortlisted");
});

test("the lab bonus applies to publishers the old host pattern missed", () => {
  const scoreOf = (url) => clusterCandidates([item("A launch", url)])[0].score;
  assert.ok(scoreOf("https://blog.google/products/x/") > scoreOf("https://unknown-startup.test/blog/x"));
  assert.ok(scoreOf("https://claude.com/blog/x") > scoreOf("https://unknown-startup.test/blog/y"));
  assert.ok(scoreOf("https://runway.com/news/x") > scoreOf("https://unknown-startup.test/blog/z"));
});
