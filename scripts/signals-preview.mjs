// A dry run of the live signals pipeline over real data, to read what it would publish before anything is switched on.
//
//   node --env-file=.env.local --import tsx scripts/signals-preview.mjs [--lane fast|main] [--now 2026-10-04T07:00:00Z] [--candidates-only]
//
// It reads production R2 and never writes to it: every write goes to a scratch directory (.scratch/signals-preview-<job>), the
// signals live in a throwaway in-memory store and not in the Durable Object, and nothing is announced. It does call the real
// models (about a few cents a signal) and fetches the real source pages. Read the output, fix what it shows, run it again.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readPrivateJson, useStore } from "../src/lib/private-store.ts";
import { localSignalService } from "../src/lib/signal-service.ts";
import { setDefaultPageLoader } from "../src/lib/source-evidence.ts";
import { localStore, overlayStore, r2S3Store } from "../src/node/store.ts";
import { publicPageLoader } from "../src/node/public-fetch.ts";
import { nodeSteps } from "../src/node/steps.ts";
import { nextCandidates } from "../src/pipeline/signal-candidates.ts";
import { gatherEvidence, groundDrafts, writeDrafts } from "../src/pipeline/signal-writing.ts";
import { CAPS, produceSignals } from "../src/pipeline/signals.ts";
import { triageBatch } from "../src/pipeline/triage.ts";
import { newStore } from "./signals-test-support.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 && args[at + 1] ? args[at + 1] : fallback; };
const lane = option("lane", "fast");
if (lane !== "fast" && lane !== "main") throw new Error("--lane is fast or main");
const nowIso = new Date(option("now", new Date().toISOString())).toISOString();
const job = `signals-preview-${Date.now()}`;
const scratch = join(process.cwd(), ".scratch", job);
mkdirSync(scratch, { recursive: true });

useStore(overlayStore(r2S3Store(), localStore(scratch)));
setDefaultPageLoader(publicPageLoader);
const service = localSignalService(newStore());
const clock = () => new Date(nowIso);

console.log(`signals preview ${nowIso} lane ${lane} (cap ${CAPS[lane]}): reads production R2, writes to ${scratch}`);
const pending = await nextCandidates(service, clock());
const known = new Map(pending.candidates.map(({ urlKey, cluster }) => [urlKey, { title: cluster.lead.title, url: cluster.lead.url, source: cluster.lead.source }]));
console.log(`candidates: ${pending.candidates.length} (read ${pending.read} snapshot files, ${pending.invalid} unreadable)`);
if (args.includes("--candidates-only")) {
  // Free: what the run would hand to triage, in order, without paying for a model.
  pending.candidates.slice(0, CAPS[lane] * 3).forEach(({ cluster }, i) => console.log(`${String(i + 1).padStart(3)}. [${cluster.lead.source}] ${cluster.lead.title.slice(0, 100)}  (${cluster.items.length} items, score ${cluster.score.toFixed(1)})`));
  process.exit(0);
}

const started = Date.now();
const result = await produceSignals(nodeSteps(job), { now: nowIso, lane, publish: true }, { service, triage: triageBatch, evidence: gatherEvidence, write: writeDrafts, ground: groundDrafts, now: clock });
const seconds = (Date.now() - started) / 1000;

const stamp = `${nowIso.slice(0, 10)}/${nowIso.slice(11, 13)}${nowIso.slice(14, 16)}`;
const report = await readPrivateJson(`signals/runs/${stamp}.json`);
const published = (await service.list({ limit: 50 })).signals;
const records = [];
for (const { id } of published) records.push(await service.get(id));

console.log(`\n=== result: ${JSON.stringify({ ...result, ids: undefined, cost: Number(result.cost.toFixed(4)) })}`);
console.log(`=== time ${seconds.toFixed(0)}s, cost $${result.cost.toFixed(4)}${result.published ? `, $${(result.cost / result.published).toFixed(4)} per signal` : ""}`);

console.log("\n=== what happened to each candidate that was claimed");
const byOutcome = new Map();
for (const note of report?.outcomes ?? []) byOutcome.set(note.outcome, [...(byOutcome.get(note.outcome) ?? []), note]);
for (const [outcome, notes] of byOutcome) {
  console.log(`\n-- ${outcome} (${notes.length})`);
  for (const { urlKey, reason } of notes) {
    const item = known.get(urlKey);
    console.log(`   ${item ? `${item.source}: ${item.title.slice(0, 90)}` : urlKey}\n      ${reason}`);
  }
}

console.log("\n=== published signals");
for (const record of records.filter(Boolean)) {
  console.log(`\n[${record.type}] ${record.importance}/10 ${record.publisher} (${record.topics.join(", ") || "no topics"}) ${record.evidence.basis}`);
  console.log(`  ${record.headline}`);
  console.log(`  ${record.summary}`);
  console.log(`  source: ${record.url}${record.traction ? `  (${record.traction})` : ""}`);
  for (const fact of record.facts) console.log(`  fact ${fact.impact}: ${fact.fact}\n        quote: "${fact.quote}"`);
  const weak = record.evidence.grounding.verdicts.filter((verdict) => verdict.supported < 0.8);
  if (weak.length) console.log(`  weakly supported: ${weak.map((verdict) => `${verdict.supported.toFixed(2)} ${verdict.text}`).join(" | ")}`);
}

writeFileSync(join(scratch, "preview.json"), JSON.stringify({ nowIso, lane, result, seconds, report, records }, null, 2));
console.log(`\nfull output: ${join(scratch, "preview.json")}`);
