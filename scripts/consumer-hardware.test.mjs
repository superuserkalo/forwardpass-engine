import assert from "node:assert/strict";
import test from "node:test";
import { isComputeCandidate, computeMarks, provenance } from "../src/pipeline/compute.ts";
import { shortlistClusters } from "../src/pipeline/candidates.ts";
import { triageInput, triageSystem } from "../src/pipeline/triage.ts";
import { editorInput, editorSystem, importanceCriteria } from "../src/pipeline/editor.ts";
import { factSystem, rateFacts } from "../src/pipeline/facts.ts";

// Synthetic editorial cases, not claims about released products or measured performance.
const item = (title, summary = "", url = "https://www.tomshardware.com/pc-components/example") => ({
  title, summary, url, source: "Hardware press", category: "news", host: new URL(url).hostname,
  publishedAt: "2026-10-15T01:00:00Z",
});
const hardware = [
  item("NVIDIA launches GeForce RTX 5090 with 32GB GDDR7 memory"),
  item("Radeon RX 9070 gets 16GB VRAM at a lower launch price"),
  item("Intel Arc B580 launches with 12GB of graphics memory"),
  item("GeForce RTX 5090 is back in stock with 32GB VRAM"),
  item("GPU memory prices rise as GDDR7 supply tightens"),
  item("Intel Core Ultra CPU ships with more cores and DDR5 support"),
  item("Intel Core Ultra 300 desktop CPUs launch next month"),
  item("GeForce RTX 50-series prices rise as memory supply tightens"),
  item("New desktop CPU ships with more cores and DDR5 support"),
  item("AMD unveils Ryzen AI Max with 128GB unified memory"),
  item("Qualcomm launches Snapdragon X with a faster NPU"),
  item("Apple introduces M5 with higher memory bandwidth", "A new Neural Engine for on-device inference.", "https://www.apple.com/newsroom/2026/10/m5/"),
  item("RTX 5090 review: local LLM inference measured at 4-bit", "32GB VRAM; measured tokens per second with a named model."),
  item("A new AI PC runs larger local models", "The NPU supports INT8 inference with shared system memory."),
  item("RTX 5090 顯卡推出 32GB GDDR7 記憶體", "", "https://technews.tw/2026/10/15/gpu/"),
  item("GeForce RTX 5090 그래픽카드 출시, 32GB GDDR7 메모리", "", "https://www.etnews.com/202610150001"),
  item("GeForce RTX 5090 レビュー: ローカルLLM推論とVRAM容量", "", "https://pc.watch.impress.co.jp/docs/review/1.html"),
];

test("consumer chips, GPU memory and measured local AI hardware enter the compute shortlist and model inputs", () => {
  const clusters = hardware.map((lead) => ({ lead, items: [lead], score: 1 }));
  for (const lead of hardware) assert.equal(isComputeCandidate(lead), true, lead.title);
  assert.equal(shortlistClusters(clusters, 0, 0, 0, 80).length, hardware.length);
  const batch = clusters.map((cluster, i) => ({ id: `c${i}`, cluster }));
  assert.ok(JSON.parse(triageInput(batch, true)).every((entry) => entry.lane === "compute"));
  const rows = batch.map(({ id }) => ({ id, keep: true, section: "compute", importance: 8, topics: ["Chips"], angle: "memory", prerank: 1 }));
  assert.ok(JSON.parse(editorInput(rows, new Map(batch.map(({ id, cluster }) => [id, cluster])), new Map(), true)).every((entry) => entry.lane === "compute"));
  for (const lead of hardware) {
    const marks = computeMarks({ lead, traction: null, topics: [] });
    assert.ok(marks?.topics.includes("Chips"), lead.title);
    assert.match(marks.traction, /^(Reported|Official) · /);
  }
});

test("consumer coverage keeps retail deals, gaming-only reviews, peripherals, stock chatter and forums out", () => {
  for (const lead of [
    item("Best RTX 5090 deals: 32GB GDDR7 at half price"),
    item("RTX 5090 review: gaming FPS and DLSS benchmarks", "32GB VRAM and GDDR7 memory."),
    item("Intel Arc GPU Graphics Drivers 101.9150 WHQL Released"),
    item("Lenovo Legion Go 2 Price Hike Puts Ryzen Z2 Extreme Handheld Price Over $3,000"),
    item("GeForce driver adds DLSS support for three Steam games"),
    item("New gaming headset ships with an AI chip"),
    item("Ryzen AI laptop review: keyboard, battery and screen"),
    item("Apple unveils new iPhone camera and colors"),
    item("RTX 5090 stock price target rises on GDDR7 demand"),
    item("GeForce RTX 5090 GDDR7 vulnerability gets a patch"),
    item("RTX 5090 has 32GB VRAM", "", "https://www.reddit.com/r/LocalLLaMA/comments/1"),
  ]) assert.equal(isComputeCandidate(lead), false, lead.title);
  const lowPower = computeMarks({ lead: item("New Ryzen AI Max has 128GB unified memory", "Lower power consumption for local inference."), traction: null, topics: [] });
  assert.deepEqual(lowPower.topics, ["Chips"]);
  assert.equal(provenance(hardware.find((lead) => lead.url.includes("apple.com"))), "Official");
  assert.equal(provenance(item("RTX 5090 reportedly doubles VRAM", "", "https://www.techpowerup.com/1")), "Unconfirmed");
});

test("memory capacity remains a headline fact for hardware even on a major launch", async () => {
  let questions;
  await rateFacts("GPU launch", [{ fact: "32GB VRAM", quote: "32GB VRAM" }], {
    compute: true, launch: true,
    rate: async (_step, _state, input) => {
      questions = input;
      return { answers: { f0: { high: 1 } }, usage: null, evaluator: "test" };
    },
  });
  assert.match(questions.f0.criteria.high, /VRAM/);
  assert.doesNotMatch(questions.f0.instructions, /specs are supporting detail/);
});

test("every editorial stage explicitly admits consumer hardware and asks for useful memory evidence", () => {
  assert.match(triageSystem(true), /consumer.*(?:GPU|chip)/i);
  assert.doesNotMatch(triageSystem(true), /analyst opinion, consumer devices/);
  assert.match(editorSystem(true), /consumer.*(?:GPU|chip)/i);
  assert.doesNotMatch(editorSystem(true), /or a consumer device/);
  assert.match(importanceCriteria(true).medium, /VRAM/);
  assert.match(factSystem(true), /VRAM/);
  assert.match(factSystem(true), /(?:quantization|precision)/);
  assert.match(factSystem(true), /(?:vendor|manufacturer).*claims/i);
  assert.doesNotMatch(factSystem(false), /VRAM/);
});
