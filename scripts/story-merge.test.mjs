import test from "node:test";
import assert from "node:assert/strict";
import { releaseTitle, sameRelease, mergeSameRelease } from "../src/pipeline/story-merge.ts";

const same = (a, b) => sameRelease(releaseTitle(a), releaseTitle(b));

test("releaseTitle reads model versions and family members", () => {
  const t = releaseTitle("Introducing GPT-6 Sol and Luna");
  assert.deepEqual([...t.versions], ["gpt-6"]);
  assert.deepEqual([...t.variants].sort(), ["luna", "sol"]);
  assert.equal(t.follower, true);
  assert.deepEqual([...releaseTitle("Benchmarking Kimi-K3 Across vLLM, SGLang, and ATOM on MI350X").versions], ["kimi-k3"]);
  assert.equal(releaseTitle("Top 10 agent frameworks in 2026").versions.size, 0);
});

test("reposts of a release merge with the launch", () => {
  const launch = "Introducing GPT-6 Sol and Luna";
  for (const repost of [
    "Announcing GPT-6 Sol and GPT-6 Luna in the API, Codex and ChatGPT",
    "OpenAI GPT-6 Sol and GPT-6 Luna are now generally available on Amazon Bedrock",
    "GPT-6 Astra, Sol, and Luna: For production agents in Microsoft Foundry",
    "Day 0 Support: GPT-6 Sol and GPT-6 Luna",
  ]) assert.equal(same(launch, repost), true, repost);
  assert.equal(same("Introducing Claude Opus 5.5", "Claude Opus 5.5 is now available on AWS"), true);
  assert.equal(same("Introducing Claude Opus 5.5", "[AINews] Claude Opus 5.5, the new default model for AINews — and everybody cuts prices 40-50%"), true);
  assert.equal(same("Introducing FLUX 3 Action", "FLUX 3 Action: a world action model you can fine-tune"), true);
});

test("separate events about the same model stay separate", () => {
  const launch = "Introducing GPT-6 Sol and Luna";
  for (const other of [
    "GPT-6 Astra has gained the ability to drive a car",
    "GPT-6 Astra has made a major breakthrough in the Goldbach Conjecture",
    "Harvey turns legal context into stronger drafts with GPT-6 Astra",
    "Better prompt caching for GPT-6",
  ]) assert.equal(same(launch, other), false, other);
  assert.equal(same("Introducing Claude Opus 5.5", "Summary of METR's predeployment evaluation of Claude Opus 5.5"), false);
  assert.equal(same("Introducing Claude Opus 5.5", "Claude Opus 5.5 for code review: More catches, different misses"), false);
  assert.equal(same("Introducing Claude Opus 5.5", "Introducing GPT-6 Sol and Luna"), false);
});

test("mergeSameRelease keeps the first cluster's position and absorbs reposts", () => {
  const c = (...titles) => ({ items: titles.map((title) => ({ title })) });
  const merged = mergeSameRelease([
    c("Introducing GPT-6 Sol and Luna"), c("Introducing Claude Opus 5.5"), c("GPT-6 Astra has gained the ability to drive a car"),
    c("OpenAI GPT-6 Sol and GPT-6 Luna are now generally available on Amazon Bedrock"), c("Claude Opus 5.5 is now available on AWS"), c("An unrelated post"),
  ]);
  assert.deepEqual(merged.map(({ items }) => items.length), [2, 2, 1, 1]);
  assert.equal(merged[0].items[0].title, "Introducing GPT-6 Sol and Luna");
});

test("an absorbed repost does not chain unrelated stories into the release", () => {
  const c = (title) => ({ items: [{ title }] });
  const merged = mergeSameRelease([
    c("Introducing GPT-6 Sol and Luna"),
    c("GPT-6 Astra, Sol, and Luna: For production agents in Microsoft Foundry"),
    c("Airbnb widens access to GPT-6 Astra and OpenAI frontier models"),
  ]);
  assert.deepEqual(merged.map(({ items }) => items.map(({ title }) => title.slice(0, 20))), [
    ["Introducing GPT-6 So", "GPT-6 Astra, Sol, an"], ["Airbnb widens access"],
  ]);
});
