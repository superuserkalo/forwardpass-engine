// Runs an engine job in Node with the same code the Cloudflare Workflows run.
//
//   npm run job -- issue 2026-09-28             dry run: reads production R2, writes to .scratch/, sends nothing
//   npm run job -- issue 2026-09-28 --fresh     dry run that ignores the saved production issue (for model comparisons)
//   npm run job -- issue 2026-09-28 --fresh --compute  dry run with chip and memory coverage
//   npm run job -- issue 2026-09-28 --live      saves the issue to production R2 (still sends nothing)
//   npm run job -- collect --live               collects sources into production R2
//   npm run job -- deliver 2026-09-28 --live    stages and sends the saved issue (emails readers)
//
// Model calls use AI_GATEWAY_API_KEY, or a VERCEL_OIDC_TOKEN supplied by your own project.
import { join } from "node:path";
import { useStore } from "../src/lib/private-store.ts";
import { setDefaultPageLoader } from "../src/lib/source-evidence.ts";
import { localStore, overlayStore, r2S3Store } from "../src/node/store.ts";
import { publicPageLoader } from "../src/node/public-fetch.ts";
import { nodeSteps } from "../src/node/steps.ts";

const [kind, maybeDate, ...rest] = process.argv.slice(2);
const flags = new Set([maybeDate, ...rest].filter((arg) => arg?.startsWith("--")));
const date = maybeDate && !maybeDate.startsWith("--") ? maybeDate : new Date().toISOString().slice(0, 10);
const live = flags.has("--live");
const local = flags.has("--local");
const now = flags.has("--now-end-of-day") ? new Date(`${date}T23:59:00Z`) : new Date();

const scratch = process.env.JOB_SCRATCH ?? join(process.cwd(), ".scratch", `${kind}-${date}`);
const hidden = flags.has("--fresh") ? [`issues/${date}`, `published/daily/${date}`] : [];
useStore(local ? localStore() : live ? r2S3Store() : overlayStore(r2S3Store(), localStore(scratch), hidden));
setDefaultPageLoader(publicPageLoader);
console.log(`${kind} ${date}: ${local ? "local store" : live ? "LIVE production R2" : `dry run, writes to ${scratch}`}`);

const started = Date.now();
if (kind === "issue") {
  const { produceIssue } = await import("../src/pipeline/issue.ts");
  const result = await produceIssue(nodeSteps(`issue-${date}${live ? "" : "-dry"}`), { date, now: now.toISOString(), publish: live && flags.has("--publish"), compute: flags.has("--compute") || process.env.FORWARDPASS_COMPUTE_ENABLED === "true" });
  console.log(JSON.stringify(result, null, 1));
} else if (kind === "collect") {
  const { collectSources } = await import("../src/collect/collect.ts");
  const hour = now.toISOString().slice(0, 13);
  const result = await collectSources(nodeSteps(`collect-${hour}${live ? "" : "-dry"}`), { now: now.toISOString() });
  console.log(JSON.stringify(result, null, 1));
} else if (kind === "deliver") {
  if (!live) throw new Error("Delivery sends email; pass --live to confirm.");
  const { deliverIssue } = await import("../src/delivery/deliver.ts");
  const result = await deliverIssue(nodeSteps(`deliver-${date}`), { date });
  console.log(JSON.stringify(result, null, 1));
} else {
  throw new Error(`Unknown job ${kind}; use issue, collect or deliver.`);
}
console.log(`finished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
