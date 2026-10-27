import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { z } from "zod";
import { handleReaderRequest } from "./api/reader.js";
import { handleAgentAccess, handleAgentMcp } from "./api/agent.js";
import { handleSlackMcp } from "./api/slack-mcp.js";
import { handleAgentCreditPayment } from "./api/agent-credit-payment.js";
import { agentCodeExecutor } from "./agent-code-executor.js";
import { AgentCreditLedger, type AgentCreditEnv } from "./agent-credit-ledger.js";
export { AgentCreditLedger };
import { ChatRegistry } from "./chat-registry.js";
export { ChatRegistry };
import { handleChatSettings, handleSlackOAuth } from "./api/chat.js";
import { chatAvailability, createChatRuntime } from "./lib/chat-bot.js";
import { chatPlatformSchema } from "./lib/chat-subscriptions.js";
import { deliverChatIssue, type ChatDeliveryJob, type ChatDeliveryResult } from "./delivery/chat.js";
import { handleSignalsMcp } from "./api/signals-mcp.js";
import { whoIs } from "./lib/caller.js";
import { collectBeforeIssue, collectSources, type CollectResult } from "./collect/collect.js";
import { deliverIssue, resend, type DeliveryJob, type DeliveryResult } from "./delivery/deliver.js";
import { deliverWeekly, type WeeklyDeliveryJob } from "./delivery/weekly.js";
import { deliverWeeklyCompute, type WeeklyComputeDeliveryJob } from "./delivery/weekly-compute.js";
import { listArticles, loadArticle, publishArticle } from "./lib/articles.js";
import { produceDeepDive } from "./pipeline/deep-dive.js";
import { produceMonthlyReport, summarizeAttention } from "./pipeline/monthly-report.js";
import { publishedDates } from "./lib/archive.js";
import { clearIssueImages, ensureArticleImage, ensureIssueImages, storySlug } from "./lib/cover-images.js";
import { FEED_TOPICS, loadIssue } from "./lib/issue.js";
import { CONTENT_TYPES } from "./lib/reader-profile.js";
import { articlePaths, issuePaths, pingIndexNow } from "./lib/indexnow.js";
import { listPrivateJsonKeys, readPrivateJson, useStore } from "./lib/private-store.js";
import { r2BindingStore } from "./lib/store-r2.js";
import { checkHealth, gatewayBalance, ownerAlert, watch } from "./lib/watchdog.js";
import { produceIssue, type IssueResult } from "./pipeline/issue.js";
import { personalPool } from "./pipeline/personal.js";
import { produceWeekly, writeOverviews, type WeeklyResult } from "./pipeline/weekly.js";
import { produceWeeklyCompute, type WeeklyComputeResult } from "./pipeline/weekly-compute.js";
import { weeklyRecall } from "./pipeline/recall-weekly.js";
import { collectFast, type FastResult } from "./collect/fast.js";
import { gatherEvidence, groundDrafts, writeDrafts } from "./pipeline/signal-writing.js";
import { produceSignals, type SignalsResult } from "./pipeline/signals.js";
import { triageBatch } from "./pipeline/triage.js";
import { SignalsIndex } from "./signals-index.js";
import type { StepConfig, Steps } from "./pipeline/steps.js";
export { SignalsIndex };

// The Forward Pass engine on Cloudflare: cron triggers start Workflows (collect, issue,
// deliver) whose steps are durable and retried; the fetch handler serves the website's
// reader API and token-protected admin routes. Secrets reach process.env via nodejs_compat.

export interface Env extends AgentCreditEnv, Pick<Cloudflare.Env, "AGENT_RATE_LIMITER" | "AGENT_CODE_LOADER"> {
  AGENT_CREDITS: DurableObjectNamespace<AgentCreditLedger>;
  BUCKET: R2Bucket;
  BROWSER: BrowserWorker;
  COLLECT: Workflow<CollectParams>;
  ISSUE: Workflow<IssueParams>;
  DELIVER: Workflow<DeliverParams>;
  SIGNALS: DurableObjectNamespace<SignalsIndex>;
  COLLECT_FAST: Workflow<FastParams>;
  SIGNALS_RATE_LIMITER: RateLimit;
  CHAT_REGISTRY: DurableObjectNamespace<ChatRegistry>;
  CHAT_DELIVER: Workflow<ChatDeliveryJob>;
  SIGNALS_MCP_RATE_LIMITER: RateLimit;
  SIGNALS_MCP_NETWORK_RATE_LIMITER: RateLimit;
  WEEKLY: Workflow<WeeklyParams>;
  WEEKLY_DELIVER: Workflow<WeeklyDeliveryJob>;
  WEEKLY_COMPUTE: Workflow<WeeklyComputeParams>;
  WEEKLY_COMPUTE_DELIVER: Workflow<WeeklyComputeDeliveryJob>;
  ADMIN_TOKEN?: string;
  FORWARDPASS_AUTOPUBLISH?: string;
  /** "true" publishes Sunday deep dives and monthly reports; otherwise they wait as drafts. */
  FORWARDPASS_EDITORIAL_AUTOPUBLISH?: string;
  /** "true" polls the tier-1 feeds every fifteen minutes; the fifteen-minute cron does nothing otherwise. */
  FORWARDPASS_FAST_LANE_ENABLED?: string;
  /** "true" lets scheduled runs publish live signals; until then only an explicit preview runs. */
  FORWARDPASS_SIGNALS_ENABLED?: string;
  /** "true" gives each paying reader a daily issue chosen for their reading profile; otherwise every reader gets the shared issue. */
  FORWARDPASS_PERSONAL_EDITIONS_ENABLED?: string;
  /** "true" writes the weekly research on Sundays and emails it to Professional readers. */
  FORWARDPASS_WEEKLY_ENABLED?: string;
  FORWARDPASS_COMPUTE_ENABLED?: string;
  /** "true" writes the weekly Compute report on Sundays and emails it to Professional readers who follow Chips or Data centers. */
  FORWARDPASS_COMPUTE_WEEKLY_ENABLED?: string;
}

type CollectParams = { now?: string; browser?: boolean };
type IssueParams = { date: string; publish: boolean; deliver: boolean };
type DeliverParams = DeliveryJob;
/** `publish` saves the week's edition (otherwise a preview that only returns it); `deliver` then starts its delivery; `now` is the moment the week is written as of. */
type WeeklyParams = { date: string; publish: boolean; deliver: boolean; now?: string };
/** The weekly Compute report: `publish` saves it (otherwise a preview that only returns it), `deliver` then starts its delivery. */
type WeeklyComputeParams = { date: string; publish: boolean; deliver: boolean; now?: string };
/** `collect` polls the tier-1 feeds first; `signals` is what runs after (nothing, a preview that only reads, or a real run); `lane` sets the run's cap. */
type FastParams = { now?: string; collect?: boolean; signals?: "off" | "preview" | "publish"; lane?: "fast" | "main" };

function workflowSteps(step: WorkflowStep): Steps {
  const config = (value: StepConfig) => ({
    ...(value.retries ? { retries: { limit: value.retries.limit, delay: value.retries.delay, backoff: value.retries.backoff ?? "exponential" } } : {}),
    ...(value.timeout ? { timeout: value.timeout } : {}),
  });
  return {
    // Results cross the step boundary as JSON text: exactly what the Node runner stores.
    async run<T>(name: string, value: StepConfig, callback: () => Promise<T>): Promise<T> {
      const text = await step.do(name, config(value), async () => JSON.stringify({ value: (await callback()) ?? null }));
      return (JSON.parse(text) as { value: T }).value;
    },
    async sleep(name, ms) { await step.sleep(name, ms); },
  };
}

const prefixed = (steps: Steps, prefix: string): Steps => ({
  run: (name, config, callback) => steps.run(`${prefix}${name}`, config, callback),
  sleep: (name, ms) => steps.sleep(`${prefix}${name}`, ms),
});

const autopublish = (env: Env) => env.FORWARDPASS_AUTOPUBLISH === "true";
const signalsEnabled = (env: Env) => env.FORWARDPASS_SIGNALS_ENABLED === "true";
const fastLaneEnabled = (env: Env) => env.FORWARDPASS_FAST_LANE_ENABLED === "true";
const personalEditionsEnabled = (env: Env) => env.FORWARDPASS_PERSONAL_EDITIONS_ENABLED === "true";
const weeklyEnabled = (env: Env) => env.FORWARDPASS_WEEKLY_ENABLED === "true";
const computeWeeklyEnabled = (env: Env) => env.FORWARDPASS_COMPUTE_WEEKLY_ENABLED === "true";
/** The Compute lane: chip, memory and data center news with its own block in the daily issue. Off until the owner turns it on. */
const computeEnabled = (env: Env) => env.FORWARDPASS_COMPUTE_ENABLED === "true";
const signalService = (env: Env) => env.SIGNALS.getByName("signals-v1");

/** One run of the signals pipeline with the real models. It publishes only when `publish` is true; otherwise it only reads. */
function runSignals(steps: Steps, env: Env, now: string, lane: "fast" | "main", publish: boolean): Promise<SignalsResult> {
  return produceSignals(prefixed(steps, "signals/"), { now, lane, publish }, { service: signalService(env), triage: triageBatch, evidence: gatherEvidence, write: writeDrafts, ground: groundDrafts, announce: pingIndexNow });
}

const failure = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : String(error);

export class CollectWorkflow extends WorkflowEntrypoint<Env, CollectParams> {
  async run(event: WorkflowEvent<CollectParams>, step: WorkflowStep): Promise<CollectResult & { signals: SignalsResult | null }> {
    useStore(r2BindingStore(this.env.BUCKET));
    const steps = workflowSteps(step);
    const now = event.payload.now ?? event.timestamp.toISOString();
    const collection = await collectSources(steps, { now }, { browser: this.env.BROWSER, forceBrowser: event.payload.browser });
    // Signals follow the collection once the owner has turned them on. A failure is logged and never fails the collection.
    let signals: SignalsResult | null = null;
    if (signalsEnabled(this.env)) {
      try { signals = await runSignals(steps, this.env, now, "main", true); }
      catch (error) { console.error("forwardpass.signals_failed", JSON.stringify({ lane: "main", error: failure(error) })); }
    }
    return { ...collection, signals };
  }
}

/** The fast lane: the tier-1 feeds every fifteen minutes, then signals, and signals alone for a manual run. */
export class FastCollectWorkflow extends WorkflowEntrypoint<Env, FastParams> {
  async run(event: WorkflowEvent<FastParams>, step: WorkflowStep): Promise<{ collection: FastResult | null; signals: SignalsResult | null }> {
    useStore(r2BindingStore(this.env.BUCKET));
    const steps = workflowSteps(step);
    const now = event.payload.now ?? event.timestamp.toISOString();
    const collection = event.payload.collect ? await collectFast(prefixed(steps, "fast/"), { now }) : null;
    const mode = event.payload.signals ?? "off";
    let signals: SignalsResult | null = null;
    if (mode !== "off") {
      try { signals = await runSignals(steps, this.env, now, event.payload.lane ?? "fast", mode === "publish"); }
      catch (error) { console.error("forwardpass.signals_failed", JSON.stringify({ lane: event.payload.lane ?? "fast", mode, error: failure(error) })); }
    }
    return { collection, signals };
  }
}

export class IssueWorkflow extends WorkflowEntrypoint<Env, IssueParams> {
  async run(event: WorkflowEvent<IssueParams>, step: WorkflowStep): Promise<IssueResult & { collection: CollectResult | null; collectionFailure: string | null; delivery: string | null }> {
    useStore(r2BindingStore(this.env.BUCKET));
    const steps = workflowSteps(step);
    const now = event.timestamp.toISOString();
    // A fresh collection first, so the issue includes everything published up to now. If it fails the issue is written from the snapshots the
    // two-hourly runs have taken: a day without an issue costs readers far more than a few hours of staleness.
    const { collection, failure: collectionFailure } = await collectBeforeIssue(() => collectSources(prefixed(steps, "collect/"), { now }, { browser: this.env.BROWSER }));
    const result = await produceIssue(steps, { date: event.payload.date, now, publish: event.payload.publish, compute: computeEnabled(this.env) }, { signals: signalsEnabled(this.env) ? signalService(this.env) : undefined });
    let delivery: string | null = null;
    if (event.payload.deliver && result.published) {
      delivery = await steps.run("start-delivery", { retries: { limit: 3, delay: 10_000 } }, async () => {
        const id = `deliver-${event.payload.date}`;
        const launches = await Promise.allSettled([
          startOnce(this.env.DELIVER, id, { date: event.payload.date }),
          ...chatPlatformSchema.options.filter(platform => chatAvailability()[platform]).map(platform =>
            startOnce(this.env.CHAT_DELIVER, `chat-${event.payload.date}-${platform}`, { date: event.payload.date, platform })),
        ]);
        if (launches.some(launch => launch.status === "rejected")) throw new Error("Some delivery workflows could not start.");
        return id;
      });
    }
    if (result.published) await afterPublish(steps, event.payload.date, this.env.FORWARDPASS_EDITORIAL_AUTOPUBLISH === "true");
    return { ...result, collection, collectionFailure, delivery };
  }
}

async function featuredSlugs(date: string): Promise<string[]> {
  const issue = await loadIssue(date);
  return issue?.version === 2 ? issue.stories.filter((story) => story.role === "featured").map((story) => storySlug(story.headline)) : [];
}

const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * Extras after an issue publishes: story images, IndexNow, yesterday's attention summary, and on
 * Sundays the deep dive and on the 1st the previous month's report. A failure is logged and never
 * fails the issue.
 */
async function afterPublish(steps: Steps, date: string, publishEditorial: boolean): Promise<void> {
  const day = new Date(`${date}T00:00:00Z`);
  const editorial = async (result: { status: string; slug: string | null }) => {
    if (publishEditorial && result.status === "saved" && result.slug) await pingIndexNow(articlePaths(result.slug)).catch(() => undefined);
    return result;
  };
  // Finding images visits up to four source pages per story and may draw a few, so it gets longer.
  const extras: Array<[string, number, () => Promise<unknown>]> = [
    ["story-images", 15 * 60_000, () => ensureIssueImages(date)],
    ["indexnow", 60_000, async () => pingIndexNow(issuePaths(date, await featuredSlugs(date)))],
    ["attention-summary", 10 * 60_000, () => summarizeAttention(dayBefore(date))],
  ];
  if (day.getUTCDay() === 0) extras.push(["deep-dive", 30 * 60_000, async () => editorial(await produceDeepDive(date, { publish: publishEditorial }))]);
  if (day.getUTCDate() === 1) {
    const month = dayBefore(date).slice(0, 7);
    extras.push(["monthly-report", 20 * 60_000, async () => editorial(await produceMonthlyReport(month, { publish: publishEditorial, publishAt: `${date}T08:00:00.000Z` }))]);
  }
  for (const [name, timeout, run] of extras) {
    try {
      const outcome = await steps.run(name, { retries: { limit: 2, delay: 30_000 }, timeout }, run);
      console.info(`forwardpass.${name}`, JSON.stringify({ date, outcome }));
    } catch (error) {
      console.error(`forwardpass.${name}_failed`, JSON.stringify({ date, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
    }
  }
}

export class DeliveryWorkflow extends WorkflowEntrypoint<Env, DeliverParams> {
  async run(event: WorkflowEvent<DeliverParams>, step: WorkflowStep): Promise<DeliveryResult> {
    useStore(r2BindingStore(this.env.BUCKET));
    // With personal editions on, a paying reader's issue is chosen from the day's issue and the signals verified in the last day and a
    // half. Off, or if it cannot be built, every reader gets the shared issue. A preview for a profile is built whether they are on or not,
    // so the owner can read one before any reader does.
    const personal = personalEditionsEnabled(this.env) || event.payload.profile ? { personal: { pool: personalPool(signalService(this.env)) } } : {};
    return deliverIssue(workflowSteps(step), event.payload, undefined, personal);
  }
}

/** The week's research, written once per topic from the week's verified signals, then, if asked, sent to Professional readers. */
export class WeeklyWorkflow extends WorkflowEntrypoint<Env, WeeklyParams> {
  async run(event: WorkflowEvent<WeeklyParams>, step: WorkflowStep): Promise<WeeklyResult & { delivery: string | null }> {
    useStore(r2BindingStore(this.env.BUCKET));
    const steps = workflowSteps(step);
    const { date, publish, deliver } = event.payload;
    const now = event.payload.now ?? event.timestamp.toISOString();
    const result = await produceWeekly(steps, { date, now, publish }, { service: signalService(this.env), write: writeOverviews, ground: groundDrafts });
    let delivery: string | null = null;
    if (deliver && result.published) {
      delivery = await steps.run("start-delivery", { retries: { limit: 3, delay: 10_000 } }, async () => {
        const id = `weekly-deliver-${date}`;
        await startOnce(this.env.WEEKLY_DELIVER, id, { date });
        return id;
      });
    }
    return { ...result, delivery };
  }
}

export class WeeklyDeliveryWorkflow extends WorkflowEntrypoint<Env, WeeklyDeliveryJob> {
  async run(event: WorkflowEvent<WeeklyDeliveryJob>, step: WorkflowStep): Promise<DeliveryResult> {
    useStore(r2BindingStore(this.env.BUCKET));
    return deliverWeekly(workflowSteps(step), event.payload);
  }
}

/** The week of AI compute as the daily issues reported it, written once, then, if asked, sent to the Professional readers who follow it. */
export class WeeklyComputeWorkflow extends WorkflowEntrypoint<Env, WeeklyComputeParams> {
  async run(event: WorkflowEvent<WeeklyComputeParams>, step: WorkflowStep): Promise<WeeklyComputeResult & { delivery: string | null }> {
    useStore(r2BindingStore(this.env.BUCKET));
    const steps = workflowSteps(step);
    const { date, publish, deliver } = event.payload;
    const now = event.payload.now ?? event.timestamp.toISOString();
    const result = await produceWeeklyCompute(steps, { date, now, publish }, { write: writeOverviews, ground: groundDrafts });
    let delivery: string | null = null;
    if (deliver && result.published) {
      delivery = await steps.run("start-delivery", { retries: { limit: 3, delay: 10_000 } }, async () => {
        const id = `weekly-compute-deliver-${date}`;
        await startOnce(this.env.WEEKLY_COMPUTE_DELIVER, id, { date });
        return id;
      });
    }
    return { ...result, delivery };
  }
}

export class WeeklyComputeDeliveryWorkflow extends WorkflowEntrypoint<Env, WeeklyComputeDeliveryJob> {
  async run(event: WorkflowEvent<WeeklyComputeDeliveryJob>, step: WorkflowStep): Promise<DeliveryResult> {
    useStore(r2BindingStore(this.env.BUCKET));
    return deliverWeeklyCompute(workflowSteps(step), event.payload);
  }
}

export class ChatDeliveryWorkflow extends WorkflowEntrypoint<Env, ChatDeliveryJob> {
  async run(event: WorkflowEvent<ChatDeliveryJob>, step: WorkflowStep): Promise<ChatDeliveryResult> {
    useStore(r2BindingStore(this.env.BUCKET));
    return deliverChatIssue(workflowSteps(step), event.payload, this.env.CHAT_REGISTRY.getByName("forwardpass-chat-v1"));
  }
}

/** Starts an instance unless one with this id already exists, so a repeated trigger is a no-op. */
async function startOnce<P>(workflow: Workflow<P>, id: string, params: P): Promise<"started" | "exists"> {
  try {
    await workflow.create({ id, params });
    return "started";
  } catch (error) {
    if (error instanceof Error && /already exists|duplicate/i.test(error.message)) return "exists";
    throw error;
  }
}

const today = (at = new Date()) => at.toISOString().slice(0, 10);

/** After the day's issue has had time to go out, and in the evening for a collection that stopped during the day. */
const WATCHDOG_CRONS = new Set(["5 8 * * *", "5 19 * * *"]);

/** Where the watchdog writes: nowhere until ALERT_EMAIL, NEWSLETTER_FROM and RESEND_API_KEY are all set. */
function alertOwner() {
  try { return ownerAlert(resend()); } catch { return undefined; }
}

async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  const at = new Date(controller.scheduledTime);
  if (controller.cron === "30 5 * * *") {
    const date = today(at);
    const publish = autopublish(env);
    console.info("forwardpass.cron_issue", JSON.stringify({ date, publish, result: await startOnce(env.ISSUE, `issue-${date}`, { date, publish, deliver: publish }) }));
    return;
  }
  if (controller.cron === "30 7 * * SUN") {
    // The weekly research is off until the owner turns it on. It runs after the daily issue has been sent, so the two never share Resend's rate.
    if (!weeklyEnabled(env)) return;
    const date = today(at);
    console.info("forwardpass.cron_weekly", JSON.stringify({ date, result: await startOnce(env.WEEKLY, `weekly-${date}`, { date, publish: true, deliver: true }) }));
    return;
  }
  if (controller.cron === "45 7 * * SUN") {
    // The weekly Compute report is off until the owner turns it on. It runs a quarter of an hour after the weekly research, so the sends never share Resend's rate.
    if (!computeWeeklyEnabled(env)) return;
    const date = today(at);
    console.info("forwardpass.cron_weekly_compute", JSON.stringify({ date, result: await startOnce(env.WEEKLY_COMPUTE, `weekly-compute-${date}`, { date, publish: true, deliver: true }) }));
    return;
  }
  if (WATCHDOG_CRONS.has(controller.cron)) {
    // Looks at what the pipeline left in storage and emails the owner what is wrong, once a day for each problem. It starts nothing.
    useStore(r2BindingStore(env.BUCKET));
    const result = await watch({ now: at, autopublish: autopublish(env), alert: alertOwner(), credits: gatewayBalance });
    console[result.findings.length ? "error" : "info"]("forwardpass.watchdog", JSON.stringify({ date: result.date, findings: result.findings.map(({ key }) => key), told: result.alerted.map(({ key }) => key), ...(result.error ? { error: result.error } : {}) }));
    return;
  }
  if (controller.cron === "*/15 * * * *") {
    // The fast lane is off until the owner turns it on; its signals run only if those are on as well.
    if (!fastLaneEnabled(env)) return;
    const minute = at.toISOString().slice(0, 16).replace(/[T:]/g, "-");
    console.info("forwardpass.cron_fast", JSON.stringify({ minute, result: await startOnce(env.COLLECT_FAST, `fast-${minute}`, { now: at.toISOString(), collect: true, signals: signalsEnabled(env) ? "publish" : "off", lane: "fast" }) }));
    return;
  }
  const hour = at.toISOString().slice(0, 13).replace(":", "");
  console.info("forwardpass.cron_collect", JSON.stringify({ hour, result: await startOnce(env.COLLECT, `collect-${hour}`, { now: at.toISOString() }) }));
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

function authorized(request: Request, env: Env): boolean {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !token || token.length !== env.ADMIN_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
  return diff === 0;
}

const editorialBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deep-dive"), date: z.iso.date(), publish: z.boolean().default(false), replace: z.boolean().default(false) }),
  z.object({ kind: z.literal("report"), month: z.string().regex(/^\d{4}-\d{2}$/), publish: z.boolean().default(false) }),
  z.object({ kind: z.literal("attention"), dates: z.array(z.iso.date()).min(1).max(40) }),
]);

/** Runs a deep dive, a monthly report (held as a draft unless publish is true) or attention summaries. */
async function runEditorial(request: Request) {
  const body = editorialBody.parse(await request.json().catch(() => ({})));
  if (body.kind === "deep-dive") return produceDeepDive(body.date, { publish: body.publish, replace: body.replace });
  if (body.kind === "report") return produceMonthlyReport(body.month, { publish: body.publish, publishAt: new Date().toISOString() });
  const results: Record<string, unknown> = {};
  for (const date of body.dates) results[date] = await summarizeAttention(date);
  return results;
}

const imagesBody = z.object({ dates: z.array(z.iso.date()).max(31).optional(), articles: z.boolean().optional(), replace: z.boolean().optional() });

/** Finds or draws missing story images for the given (or the last 14) issues and, if asked, every article. */
async function backfillImages(request: Request) {
  const body = imagesBody.parse(await request.json().catch(() => ({})));
  const dates = body.dates ?? (await publishedDates("daily")).slice(0, 14);
  const failed = (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`;
  const results: Record<string, unknown> = {};
  for (const date of dates) {
    if (body.replace) await clearIssueImages(date);
    results[`daily/${date}`] = await ensureIssueImages(date).catch(failed);
  }
  if (body.articles) {
    for (const article of await listArticles()) results[`editorial/${article.slug}`] = await ensureArticleImage(article.slug, body.replace).catch(failed);
  }
  return results;
}

const adminBody = z.object({
  date: z.iso.date().optional(),
  publish: z.boolean().optional(),
  deliver: z.boolean().optional(),
  test: z.array(z.email()).max(5).optional(),
  /** With `test`: preview the own edition a reader with this profile would get, instead of the shared issue. */
  profile: z.strictObject({
    firstName: z.string().trim().max(40).optional(),
    topics: z.array(z.enum(FEED_TOPICS)).min(1).max(FEED_TOPICS.length),
    content: z.array(z.enum(CONTENT_TYPES)).max(CONTENT_TYPES.length).optional(),
    format: z.enum(["Briefing", "Links only"]).optional(),
    notes: z.string().trim().max(180).optional(),
  }).optional(),
  id: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  browser: z.boolean().optional(),
  now: z.iso.datetime().optional(),
});

const weeklyBody = z.object({ date: z.iso.date().optional(), publish: z.boolean().optional(), deliver: z.boolean().optional(), now: z.iso.datetime().optional(), id: z.string().regex(/^[a-z0-9-]{1,80}$/).optional() });
const weeklyDeliverBody = z.object({ date: z.iso.date().optional(), test: z.array(z.email()).max(5).optional(), topics: z.array(z.enum(FEED_TOPICS)).max(FEED_TOPICS.length).optional(), id: z.string().regex(/^[a-z0-9-]{1,80}$/).optional() });
const weeklyComputeDeliverBody = z.object({ date: z.iso.date().optional(), test: z.array(z.email()).max(5).optional(), id: z.string().regex(/^[a-z0-9-]{1,80}$/).optional() });
const deliveryStatusSchema = z.object({ date: z.string(), recipients: z.number(), sent: z.number(), alreadySent: z.number(), skipped: z.number(), failed: z.number(), needsReconciliation: z.number(), personal: z.number(), subject: z.string().optional(), topics: z.number().optional(), signals: z.number().optional(), stories: z.number().optional(), areas: z.number().optional(), completedAt: z.string() });
const weeklyRunSchema = z.object({ now: z.string(), published: z.boolean(), topics: z.number(), overviews: z.number(), signals: z.number(), cost: z.number() });
const computeWeeklyRunSchema = z.object({ now: z.string(), published: z.boolean(), stories: z.number(), areas: z.number(), overviews: z.number(), cost: z.number() });
const sundayOnOrBefore = (date: string) => { const day = new Date(`${date}T00:00:00Z`); return new Date(day.getTime() - day.getUTCDay() * 86_400_000).toISOString().slice(0, 10); };

/** What is switched on, and how the daily issue and the weekly research last went: the numbers, never a reader. */
async function editionsStatus(env: Env, requested: string | null) {
  const date = z.iso.date().safeParse(requested).data ?? today();
  const sunday = sundayOnOrBefore(date);
  const run = weeklyRunSchema.safeParse(await readPrivateJson(`weekly/runs/${sunday}.json`));
  const delivery = deliveryStatusSchema.safeParse(await readPrivateJson(`delivery/weekly-${sunday}/status.json`));
  const daily = deliveryStatusSchema.safeParse(await readPrivateJson(`delivery/${date}/status.json`));
  const computeRun = computeWeeklyRunSchema.safeParse(await readPrivateJson(`weekly-compute/runs/${sunday}.json`));
  const computeDelivery = deliveryStatusSchema.safeParse(await readPrivateJson(`delivery/weekly-compute-${sunday}/status.json`));
  return {
    personalEditionsEnabled: personalEditionsEnabled(env), weeklyEnabled: weeklyEnabled(env), computeEnabled: computeEnabled(env), computeWeeklyEnabled: computeWeeklyEnabled(env), date,
    daily: daily.success ? daily.data : null,
    weekly: {
      date: sunday, published: (await readPrivateJson(`published/weekly/${sunday}.json`)) !== null,
      run: run.success ? { at: run.data.now, published: run.data.published, topics: run.data.topics, overviews: run.data.overviews, signals: run.data.signals, cost: run.data.cost } : null,
      delivery: delivery.success ? delivery.data : null,
    },
    computeWeekly: {
      date: sunday, published: (await readPrivateJson(`published/weekly-compute/${sunday}.json`)) !== null,
      run: computeRun.success ? { at: computeRun.data.now, published: computeRun.data.published, stories: computeRun.data.stories, areas: computeRun.data.areas, overviews: computeRun.data.overviews, cost: computeRun.data.cost } : null,
      delivery: computeDelivery.success ? computeDelivery.data : null,
    },
  };
}

const signalsRunBody = z.object({ preview: z.boolean().default(true), lane: z.enum(["fast", "main"]).default("main"), now: z.iso.datetime().optional(), collect: z.boolean().default(false) });
const signalsCorrectBody = z.object({
  id: z.string().regex(/^g-[a-f0-9]{16}$/), kind: z.enum(["correction", "retraction"]), note: z.string().trim().min(1).max(500),
  headline: z.string().trim().min(1).max(200).optional(), summary: z.string().trim().min(1).max(700).optional(),
});
const runSummarySchema = z.object({ now: z.string(), lane: z.string(), preview: z.boolean(), considered: z.number(), published: z.number(), failed: z.number(), rejected: z.number(), skippedCap: z.number(), cost: z.number() });

/** The signals' own admin routes: their status, a manual run (a preview unless asked and enabled) and corrections. */
async function signalsAdmin(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/admin/signals/")) return null;
  const service = signalService(env);
  if (request.method === "GET" && path === "/admin/signals/status") {
    const day = today();
    const reports = await Promise.all((await listPrivateJsonKeys(`signals/runs/${day}/`)).sort().slice(-5).map(async (key) => runSummarySchema.safeParse(await readPrivateJson(key))));
    const recentRuns = reports.flatMap((report) => report.success ? [{ at: report.data.now, lane: report.data.lane, preview: report.data.preview, considered: report.data.considered, published: report.data.published, failed: report.data.failed, rejected: report.data.rejected, skippedCap: report.data.skippedCap, cost: report.data.cost }] : []);
    return json({ signalsEnabled: signalsEnabled(env), fastLaneEnabled: fastLaneEnabled(env), publishedToday: await service.publishedToday(day), last7days: await service.stats(new Date(Date.now() - 7 * 86_400_000).toISOString()), recentRuns });
  }
  if (request.method === "POST" && path === "/admin/signals/run") {
    const parsed = signalsRunBody.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.message }, 400);
    const { preview, lane, now, collect } = parsed.data;
    if (!preview && !signalsEnabled(env)) return json({ error: "Signals are not enabled: set FORWARDPASS_SIGNALS_ENABLED to true, or run a preview." }, 409);
    const id = `signals-manual-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await env.COLLECT_FAST.create({ id, params: { ...(now ? { now } : {}), collect, signals: preview ? "preview" : "publish", lane } });
    return json({ workflow: "fast", id, preview });
  }
  if (request.method === "POST" && path === "/admin/signals/correct") {
    const parsed = signalsCorrectBody.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.message }, 400);
    const { id, kind, note, headline, summary } = parsed.data;
    const done = await service.correct(id, kind, note, new Date().toISOString(), { ...(headline ? { headline } : {}), ...(summary ? { summary } : {}) });
    return done ? json({ ok: true, id, kind }) : json({ error: "No such signal, or it is already retracted" }, 404);
  }
  return json({ error: "Not found" }, 404);
}

async function admin(request: Request, env: Env, path: string): Promise<Response> {
  if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
  const workflows = { collect: env.COLLECT, fast: env.COLLECT_FAST, issue: env.ISSUE, deliver: env.DELIVER, weekly: env.WEEKLY, "weekly-deliver": env.WEEKLY_DELIVER, "weekly-compute": env.WEEKLY_COMPUTE, "weekly-compute-deliver": env.WEEKLY_COMPUTE_DELIVER } as const;
  const status = /^\/admin\/(collect|fast|issue|deliver|weekly|weekly-deliver|weekly-compute|weekly-compute-deliver)\/([a-z0-9-]{1,100})$/.exec(path);
  if (request.method === "GET" && status) {
    try {
      const instance = await workflows[status[1] as keyof typeof workflows].get(status[2]);
      return json({ id: status[2], ...await instance.status() });
    } catch {
      return json({ id: status[2], error: "not found" }, 404);
    }
  }
  if (request.method === "POST" && path === "/admin/watchdog") {
    const body = z.object({ notify: z.boolean().default(false), test: z.boolean().default(false) }).safeParse(await request.json().catch(() => ({})));
    if (!body.success) return json({ error: "notify and test are true or false" }, 400);
    if (body.data.test) {
      // Shows the owner that an alert arrives. It checks nothing and records nothing as reported.
      const alert = alertOwner();
      if (!alert) return json({ sent: false, reason: "ALERT_EMAIL, NEWSLETTER_FROM and RESEND_API_KEY must all be set" }, 503);
      try { return json({ sent: true, id: await alert("Forward Pass: alert test", `This is a test of the watchdog's alert email. If you can read it, alerts reach you.\n\nSent ${new Date().toISOString()}.`) ?? null }); }
      catch (error) { return json({ sent: false, reason: error instanceof Error ? error.message : String(error) }, 502); }
    }
    const now = new Date();
    return json(body.data.notify ? await watch({ now, autopublish: autopublish(env), alert: alertOwner(), credits: gatewayBalance }) : { date: today(now), findings: await checkHealth({ now, autopublish: autopublish(env), credits: gatewayBalance }) });
  }
  if (request.method === "GET" && path === "/admin/recall") return json(await weeklyRecall(today()));
  const signalsResponse = await signalsAdmin(request, env, path);
  if (signalsResponse) return signalsResponse;
  const chatStatus = /^\/admin\/chat-deliver\/([a-z0-9-]{1,100})$/.exec(path);
  if (request.method === "GET" && chatStatus) {
    try { return json({ id: chatStatus[1], ...await (await env.CHAT_DELIVER.get(chatStatus[1])).status() }); }
    catch { return json({ error: "not found" }, 404); }
  }
  if (request.method === "POST" && path === "/admin/chat-deliver") {
    const parsed = z.object({ date: z.iso.date(), platform: chatPlatformSchema, destinationId: z.string().regex(/^[a-f0-9]{64}$/).optional(), id: z.string().regex(/^[a-z0-9-]{1,40}$/).optional() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "A valid issue date and chat platform are required." }, 400);
    if (!chatAvailability()[parsed.data.platform]) return json({ error: "Chat platform unavailable." }, 503);
    const id = `chat-${parsed.data.date}-${parsed.data.platform}${parsed.data.destinationId ? `-${parsed.data.destinationId.slice(0, 32)}` : ""}${parsed.data.id ? `-${parsed.data.id}` : ""}`;
    const outcome = await startOnce(env.CHAT_DELIVER, id, { date: parsed.data.date, platform: parsed.data.platform, ...(parsed.data.destinationId ? { destinationId: parsed.data.destinationId } : {}) });
    return json({ workflow: "chat-deliver", id, outcome });
  }
  if (request.method === "GET" && path === "/admin/editions/status") return json(await editionsStatus(env, new URL(request.url).searchParams.get("date")));
  if (request.method === "POST" && path === "/admin/weekly") {
    const parsed = weeklyBody.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.message }, 400);
    const { publish = false, deliver = false, now, id: suffix } = parsed.data;
    if (deliver && !publish) return json({ error: "deliver requires publish" }, 400);
    const date = parsed.data.date ?? today();
    const id = `weekly-${date}${suffix ? `-${suffix}` : publish ? "" : `-preview-${Date.now()}`}`;
    return json({ workflow: "weekly", id, result: await startOnce(env.WEEKLY, id, { date, publish, deliver, ...(now ? { now } : {}) }) });
  }
  if (request.method === "POST" && path === "/admin/weekly-deliver") {
    const parsed = weeklyDeliverBody.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.message }, 400);
    const { test, topics, id: suffix } = parsed.data;
    const date = parsed.data.date ?? today();
    const id = test?.length ? `weekly-deliver-${date}-test-${Date.now()}` : `weekly-deliver-${date}${suffix ? `-${suffix}` : ""}`;
    return json({ workflow: "weekly-deliver", id, result: await startOnce(env.WEEKLY_DELIVER, id, { date, ...(test ? { test } : {}), ...(topics ? { topics } : {}) }) });
  }
  if (request.method === "POST" && path === "/admin/weekly-compute") {
    const parsed = weeklyBody.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.message }, 400);
    const { publish = false, deliver = false, now, id: suffix } = parsed.data;
    if (deliver && !publish) return json({ error: "deliver requires publish" }, 400);
    const date = parsed.data.date ?? today();
    const id = `weekly-compute-${date}${suffix ? `-${suffix}` : publish ? "" : `-preview-${Date.now()}`}`;
    return json({ workflow: "weekly-compute", id, result: await startOnce(env.WEEKLY_COMPUTE, id, { date, publish, deliver, ...(now ? { now } : {}) }) });
  }
  if (request.method === "POST" && path === "/admin/weekly-compute-deliver") {
    const parsed = weeklyComputeDeliverBody.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.message }, 400);
    const { test, id: suffix } = parsed.data;
    const date = parsed.data.date ?? today();
    const id = test?.length ? `weekly-compute-deliver-${date}-test-${Date.now()}` : `weekly-compute-deliver-${date}${suffix ? `-${suffix}` : ""}`;
    return json({ workflow: "weekly-compute-deliver", id, result: await startOnce(env.WEEKLY_COMPUTE_DELIVER, id, { date, ...(test ? { test } : {}) }) });
  }
  if (request.method === "POST" && path === "/admin/images") return json(await backfillImages(request));
  if (request.method === "POST" && path === "/admin/editorial") return json(await runEditorial(request));
  const draft = /^\/admin\/articles\/([a-z0-9-]{1,120})$/.exec(path);
  if (request.method === "GET" && draft) return json(await loadArticle(draft[1]) ?? { error: "not found" });
  if (request.method === "POST" && draft) {
    const at = z.object({ at: z.iso.datetime().optional() }).parse(await request.json().catch(() => ({}))).at ?? new Date().toISOString();
    const published = await publishArticle(draft[1], at);
    if (published) await pingIndexNow(articlePaths(published.slug)).catch(() => undefined);
    return json(published ?? { error: "not found" }, published ? 200 : 404);
  }
  const start = /^\/admin\/(collect|issue|deliver)$/.exec(path);
  if (request.method !== "POST" || !start) return new Response("Not found", { status: 404 });
  const parsed = adminBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return json({ error: parsed.error.message }, 400);
  const body = parsed.data;
  const date = body.date ?? today();
  const suffix = body.id ? `-${body.id}` : "";
  if (start[1] === "collect") {
    const id = `collect-manual-${Date.now()}`;
    await env.COLLECT.create({ id, params: { browser: body.browser ?? false, ...(body.now ? { now: body.now } : {}) } });
    return json({ workflow: "collect", id });
  }
  if (start[1] === "issue") {
    const publish = body.publish ?? false;
    const deliver = body.deliver ?? false;
    if (deliver && !publish) return json({ error: "deliver requires publish" }, 400);
    const id = `issue-${date}${suffix || (publish ? "" : `-preview-${Date.now()}`)}`;
    return json({ workflow: "issue", id, result: await startOnce(env.ISSUE, id, { date, publish, deliver }) });
  }
  if (body.profile && !body.test?.length) return json({ error: "a profile is for a preview: give test addresses" }, 400);
  const id = body.test?.length ? `deliver-${date}-test-${Date.now()}` : `deliver-${date}${suffix}`;
  return json({ workflow: "deliver", id, result: await startOnce(env.DELIVER, id, { date, test: body.test, ...(body.profile ? { profile: body.profile } : {}) }) });
}

const signalsPath = (path: string) => path === "/signals" || path === "/corrections" || path.startsWith("/signals/");

/** The reader API, with the public signals answered from the edge cache for the minute their headers allow, and a limit on what reaches the store. */
async function reader(request: Request, path: string, env: Env): Promise<Response> {
  const reading = request.method === "GET" || request.method === "HEAD";
  if (!signalsPath(path) || !reading) return handleReaderRequest(request, path, signalService(env));
  const cache = caches.default;
  if (request.method === "GET") {
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  const { caller } = whoIs(request);
  if (!(await env.SIGNALS_RATE_LIMITER.limit({ key: caller })).success) {
    return Response.json({ error: "Too many requests, try again in a minute" }, { status: 429, headers: { "Retry-After": "60", "X-AI-Generated": "true", "Cache-Control": "no-store" } });
  }
  const response = await handleReaderRequest(request, path, signalService(env));
  if (request.method === "GET" && response.status === 200 && /s-maxage/.test(response.headers.get("Cache-Control") ?? "")) await cache.put(request, response.clone());
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    useStore(r2BindingStore(env.BUCKET));
    const path = new URL(request.url).pathname;
    if (path === "/health") return json({ ok: true });
    if (path === "/chat-settings" || path === "/chat/oauth/slack" || path.startsWith("/chat/webhooks/")) {
      const registry = env.CHAT_REGISTRY.getByName("forwardpass-chat-v1");
      const backendOrigin = new URL(request.url).origin;
      if (path === "/chat-settings") return handleChatSettings(request, registry, backendOrigin);
      if (path === "/chat/oauth/slack" && request.method === "GET") return handleSlackOAuth(request, registry, backendOrigin);
      const platform = chatPlatformSchema.safeParse(path.slice("/chat/webhooks/".length));
      if (!platform.success || request.method !== "POST") return json({ error: "Not found" }, 404);
      if (!chatAvailability()[platform.data]) return json({ error: "Channel unavailable" }, 503);
      try {
        const bot = createChatRuntime(registry, platform.data);
        return await bot.webhooks[platform.data](request, { waitUntil: task => ctx.waitUntil(task) });
      } catch { return json({ error: "Webhook unavailable" }, 503); }
    }
    const credits = (account: string) => env.AGENT_CREDITS.getByName(account);
    if (path === "/chat/mcp/slack") return handleSlackMcp(request, env.CHAT_REGISTRY.getByName("forwardpass-chat-v1"), { cache: caches.default, limiter: env.AGENT_RATE_LIMITER, credits });
    if (path === "/agent-access") return handleAgentAccess(request, { credits });
    if (path === "/agent-credit-payment") return handleAgentCreditPayment(request, credits);
    if (path === "/mcp") return handleAgentMcp(request, { cache: caches.default, limiter: env.AGENT_RATE_LIMITER, credits, codeExecutor: (account) => agentCodeExecutor(env.AGENT_CODE_LOADER, account) });
    // The free MCP tier: the live signals for any agent, read-only, under a limit of its own.
    if (path === "/mcp/signals") return handleSignalsMcp(request, { service: signalService(env), cache: caches.default, limiter: env.SIGNALS_MCP_RATE_LIMITER, networkLimiter: env.SIGNALS_MCP_NETWORK_RATE_LIMITER });
    if (path.startsWith("/admin/")) return admin(request, env, path);
    return reader(request, path, env);
  },
  scheduled,
} satisfies ExportedHandler<Env>;
