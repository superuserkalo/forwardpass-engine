import assert from "node:assert/strict";
import test from "node:test";
import { clusterCandidates, shortlistClusters, COMPUTE_SLOTS } from "../src/pipeline/candidates.ts";

// Chip news has no Hacker News points or GitHub stars, so the attention-ranked shortlist never reaches it. The Compute lane gets slots of
// its own, as a tier-1 publisher's own post does, and only when the issue is built with the lane on.
const hn = (score) => [{ platform: "hacker-news", id: String(score), url: "https://x.test", measuredAt: "2026-10-09T02:00:00Z", previousMeasuredAt: null, elapsedHours: null, score, scoreDelta: null, scorePerHour: null, secondaryCount: 5, secondaryDelta: null }];
const item = (title, url, extra = {}) => ({ title, summary: "", url, publishedAt: "2026-10-09T01:00:00Z", source: "Trade press", category: "news", ...extra });
// Every title has its own tokens so no two items cluster together.
const noise = (count) => Array.from({ length: count }, (_, i) => item(`alpha${i} beta${i} gamma${i} delta${i} epsilon${i}`, `https://s${i}.test/p`, { source: "Hacker News", category: "community signal", attention: hn(200 + i) }));
// Each story has words of its own, so the clustering keeps them apart, as it does real stories.
const chip = (n) => item(`Maker${n}a raises wafer output guidance${n}c for node${n}d lines`, `https://www.theregister.com/2026/10/09/hbm-${n}/`);

test("compute news reaches triage however little attention it has, but only when the lane is on", () => {
  const clusters = clusterCandidates([...noise(600), chip(1)]);
  assert.ok(clusters.findIndex((c) => c.lead.url === chip(1).url) >= 450, "the story ranks below the usual cut");
  assert.ok(!shortlistClusters(clusters).some((c) => c.lead.url === chip(1).url), "with the lane off the shortlist is what it was");
  assert.ok(shortlistClusters(clusters, 450, 60, 150, COMPUTE_SLOTS).some((c) => c.lead.url === chip(1).url), "with it on, the story is shortlisted");
});

test("the lane has a quota of its own and adds nothing that is not compute", () => {
  const stories = Array.from({ length: COMPUTE_SLOTS + 25 }, (_, n) => chip(n));
  const clusters = clusterCandidates([...noise(600), ...stories]);
  const base = shortlistClusters(clusters);
  const on = shortlistClusters(clusters, 450, 60, 150, COMPUTE_SLOTS);
  assert.equal(on.length - base.length, COMPUTE_SLOTS, "exactly the quota is added, no more");
  const added = on.filter((c) => !base.includes(c));
  assert.ok(added.every((c) => c.lead.url.includes("hbm-")), "and everything added is compute news");
  // Ranked by score within the lane, so the quota keeps the best ones.
  const order = added.map((c) => c.score);
  assert.deepEqual(order, [...order].sort((a, b) => b - a));
});

test("a story already shortlisted is not added twice", () => {
  const popular = item("Micron HBM4 supply deal lifts memory prices", "https://www.theregister.com/2026/10/09/popular/", { attention: hn(900) });
  const clusters = clusterCandidates([popular, ...noise(10)]);
  const on = shortlistClusters(clusters, 450, 60, 150, COMPUTE_SLOTS);
  assert.equal(on.filter((c) => c.lead.url === popular.url).length, 1);
});

// The Chinese, Korean and Japanese outlets are read for the supply chain. What they print about anything else is other outlets' news a day late and in
// another language, and a dry run of 10 October put an event the issue had reported in English back at the top through a Chinese article about it.
test("a story in Chinese, Korean or Japanese is shortlisted only as compute news, and only when the lane is on", () => {
  const other = (n) => item(`OpenAI 發表新模型 GPT-${n} 推理能力大幅提升 開發者可立即使用 API`, `https://technews.tw/2026/10/09/openai-${n}/`, { source: "TechNews (科技新報)", attention: hn(300) });
  const chinese = item("台積電2奈米報價再漲 CoWoS先進封裝產能滿載 客戶訂單看到2027年", "https://technews.tw/2026/10/09/tsmc/", { source: "TechNews (科技新報)" });
  const korean = item("삼성전자 파운드리 2나노 수율 개선 속도 엔비디아 수주 기대", "https://www.hankyung.com/article/1", { source: "Hankyung (한국경제)" });
  const clusters = clusterCandidates([other(6), chinese, korean, ...noise(20)]);
  const urls = (list) => list.map((c) => c.lead.url);
  const off = urls(shortlistClusters(clusters));
  assert.ok(![other(6).url, chinese.url, korean.url].some((url) => off.includes(url)), "with the lane off none of them is shortlisted, as before the outlets were added");
  const on = urls(shortlistClusters(clusters, 450, 60, 150, COMPUTE_SLOTS));
  assert.ok(on.includes(chinese.url) && on.includes(korean.url), "the chip stories are");
  assert.ok(!on.includes(other(6).url), "a story about anything else is not, however much attention it has");
});
