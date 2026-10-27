import assert from "node:assert/strict";
import test from "node:test";
import { HF_ORGS, githubRisingRepos, huggingFaceOrgModels } from "../src/lib/discovery-streams.ts";
import { isTier1FirstParty } from "../src/pipeline/tier1.ts";

// Half of what AlphaSignal covers and we missed in 28 Sep to 3 Oct was a repository, a model or a paper
// (34 repos, 13 models, 5 papers of 102). Trending lists miss a new repo before its stars arrive and a
// lab's new model before it trends (docs/route-miss-research-2026-10-03.md).

const now = new Date("2026-10-03T12:00:00Z");
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

test("a lab's new Hugging Face models are first-party releases with their real creation time", async () => {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    const org = new URL(url).searchParams.get("author");
    if (org === "Qwen") return json([
      { id: "Qwen/Qwen3.8-27B", likes: 412, downloads: 90_000, createdAt: "2026-10-02T09:15:00.000Z", pipeline_tag: "text-generation", tags: ["license:apache-2.0"] },
      { id: "Qwen/Qwen3.7-old", likes: 3_000, downloads: 5_000_000, createdAt: "2026-08-01T00:00:00.000Z", pipeline_tag: "text-generation", tags: [] },
    ]);
    return json([]);
  };
  const items = await huggingFaceOrgModels(fetcher, now);
  assert.ok(HF_ORGS.includes("Qwen") && HF_ORGS.includes("deepseek-ai") && HF_ORGS.includes("meta-llama"));
  assert.ok(seen.every((url) => url.startsWith("https://huggingface.co/api/models?") && url.includes("sort=createdAt")));
  assert.equal(items.length, 1, "a model older than a week is not a new release");
  const [model] = items;
  assert.equal(model.url, "https://huggingface.co/Qwen/Qwen3.8-27B");
  assert.equal(model.publishedAt, "2026-10-02T09:15:00.000Z");
  assert.equal(model.dateKind, "published");
  assert.equal(model.category, "model release");
  assert.match(model.summary, /412 likes/);
  assert.equal(model.attention[0].platform, "huggingface");
  assert.equal(isTier1FirstParty(model), true, "so it always reaches triage");
});

test("one organization failing does not lose the others", async () => {
  const fetcher = async (url) => {
    if (new URL(url).searchParams.get("author") === "Qwen") throw new Error("network down");
    if (new URL(url).searchParams.get("author") === "deepseek-ai") return json([{ id: "deepseek-ai/V5-Flash", likes: 9, downloads: 1, createdAt: "2026-10-03T01:00:00.000Z", tags: [] }]);
    return json([]);
  };
  assert.deepEqual((await huggingFaceOrgModels(fetcher, now)).map((item) => item.title), ["deepseek-ai/V5-Flash"]);
});

test("new repositories with early traction become candidates, with stars per day as their momentum", async () => {
  const urls = [];
  const fetcher = async (url, init) => {
    urls.push({ url, auth: init?.headers?.Authorization });
    return json({ total_count: 2, items: [
      { full_name: "acme/agent-memory", html_url: "https://github.com/acme/agent-memory", description: "Persistent memory for coding agents", stargazers_count: 300, forks_count: 12, created_at: "2026-10-02T12:00:00Z", language: "TypeScript", topics: ["agents"], fork: false },
      { full_name: "someone/tiny-fork", html_url: "https://github.com/someone/tiny-fork", description: "", stargazers_count: 41, forks_count: 1, created_at: "2026-10-01T12:00:00Z", language: "Python", topics: [], fork: true },
    ] });
  };
  const items = await githubRisingRepos(fetcher, now, "token-123");
  assert.ok(urls.length >= 4 && urls.every(({ url, auth }) => url.startsWith("https://api.github.com/search/repositories?") && auth === "Bearer token-123"));
  assert.ok(decodeURIComponent(urls[0].url).includes("created:>=2026-09-30") && decodeURIComponent(urls[0].url).includes("stars:>="));
  assert.deepEqual([...new Set(items.map((item) => item.url))], ["https://github.com/acme/agent-memory"], "forks are not new projects, and repeated queries dedupe");
  const [repo] = items;
  assert.equal(repo.publishedAt, "2026-10-02T12:00:00.000Z");
  assert.equal(repo.attention[0].platform, "github");
  assert.equal(repo.attention[0].score, 300);
  assert.equal(repo.attention[0].scoreDelta, 300, "300 stars in one day");
  assert.match(repo.summary, /Persistent memory for coding agents/);
});

test("without a GitHub token the stream fails loudly instead of returning nothing", async () => {
  await assert.rejects(() => githubRisingRepos(async () => json({ items: [] }), now, undefined), /GITHUB_TOKEN/);
});

import { GITHUB_ORGS, githubOrgRepos } from "../src/lib/discovery-streams.ts";

test("a lab's new public repositories are first-party releases, not forks, docs sites or empty shells", async () => {
  const fetcher = async (url, init) => {
    assert.equal(init?.headers?.Authorization, "Bearer token-123");
    const org = decodeURIComponent(new URL(url).pathname.split("/")[2]);
    if (org !== "cohere-ai") return json([]);
    return json([
      { full_name: "cohere-ai/rcp-ndcg", html_url: "https://github.com/cohere-ai/rcp-ndcg", description: "Rank-calibrated nDCG for retrieval benchmarks", stargazers_count: 12, forks_count: 1, created_at: "2026-10-02T08:00:00Z", fork: false, archived: false, private: false },
      { full_name: "cohere-ai/fork-of-thing", html_url: "https://github.com/cohere-ai/fork-of-thing", description: "x", stargazers_count: 1, forks_count: 0, created_at: "2026-10-02T08:00:00Z", fork: true, archived: false, private: false },
      { full_name: "cohere-ai/cohere-ai.github.io", html_url: "https://github.com/cohere-ai/cohere-ai.github.io", description: "Site", stargazers_count: 0, forks_count: 0, created_at: "2026-10-02T08:00:00Z", fork: false, archived: false, private: false },
      { full_name: "cohere-ai/empty-shell", html_url: "https://github.com/cohere-ai/empty-shell", description: null, stargazers_count: 0, forks_count: 0, created_at: "2026-10-02T08:00:00Z", fork: false, archived: false, private: false },
      { full_name: "cohere-ai/old-library", html_url: "https://github.com/cohere-ai/old-library", description: "Old", stargazers_count: 900, forks_count: 50, created_at: "2025-01-01T00:00:00Z", fork: false, archived: false, private: false },
    ]);
  };
  const items = await githubOrgRepos(fetcher, now, "token-123");
  assert.ok(GITHUB_ORGS.includes("anthropics") && GITHUB_ORGS.includes("cohere-ai") && GITHUB_ORGS.includes("huggingface"));
  assert.deepEqual(items.map((item) => item.url), ["https://github.com/cohere-ai/rcp-ndcg"]);
  assert.equal(items[0].category, "new repository");
  assert.equal(items[0].publishedAt, "2026-10-02T08:00:00.000Z");
  assert.equal(isTier1FirstParty(items[0]), true);
  assert.equal(isTier1FirstParty({ ...items[0], url: "https://github.com/some-user/rcp-ndcg" }), false, "the same kind of repository from an unknown account is not first-party");
});
