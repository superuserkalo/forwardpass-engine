import { gateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate, generateText, Output, type JSONValue } from "ai";

type JSONObject = { [key: string]: JSONValue };
import { z } from "zod";
import type { Usage } from "../lib/issue.js";

// Model roles and reasoning effort, chosen from a 7x7 editor x writer benchmark on the
// 2026-10-01 issue (read issue by issue): GPT-6.1 Sol at medium picks the stories, Sol at high
// writes them (most accurate drafts, fewest checker flags, ~$0.16 an issue). Many-call,
// mechanical roles (triage, facts, check) stay on cheap GPT-6 Luna. Each role can be moved to
// another gateway model or effort with environment variables (EDITOR_MODEL, WRITER_EFFORT, ...).
export type Role = "triage" | "facts" | "editor" | "writer" | "check" | "signals";
type Effort = "low" | "medium" | "high" | "max";

const ROLE_DEFAULTS: Record<Role, { env: string; model: string; effort?: Effort; timeoutMs: number }> = {
  triage: { env: "TRIAGE_MODEL", model: "openai/gpt-6-luna", timeoutMs: 120_000 },
  facts: { env: "FACTS_MODEL", model: "openai/gpt-6-luna", timeoutMs: 150_000 },
  editor: { env: "EDITOR_MODEL", model: "openai/gpt-6.1-sol", effort: "medium", timeoutMs: 300_000 },
  writer: { env: "WRITER_MODEL", model: "openai/gpt-6.1-sol", effort: "high", timeoutMs: 420_000 },
  check: { env: "CHECK_MODEL", model: "openai/gpt-6-luna", effort: "high", timeoutMs: 240_000 },
  // Live signals write a headline and two sentences from verified facts; code enforces the rules, so the cheap model is enough.
  signals: { env: "SIGNALS_MODEL", model: "openai/gpt-6-luna", timeoutMs: 150_000 },
};

export function modelFor(role: Role): string {
  return process.env[ROLE_DEFAULTS[role].env] || ROLE_DEFAULTS[role].model;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type AnyEffort = (typeof EFFORTS)[number];

/** The role's effort, overridable per role with e.g. WRITER_EFFORT=medium. */
export function effortFor(role: Role): AnyEffort | undefined {
  const configured = process.env[`${role.toUpperCase()}_EFFORT`];
  return EFFORTS.find((level) => level === configured) ?? ROLE_DEFAULTS[role].effort;
}

export function modelConfig(): Record<string, string> {
  return Object.fromEntries((Object.keys(ROLE_DEFAULTS) as Role[]).map((role) => [role, `${modelFor(role)}${effortFor(role) ? ` @${effortFor(role)}` : ""}`]));
}

function gatewayCost(metadata: unknown): number | null {
  const parsed = z.object({ gateway: z.object({ cost: z.union([z.string(), z.number()]) }) }).safeParse(metadata);
  if (!parsed.success) return null;
  const cost = Number(parsed.data.gateway.cost);
  return Number.isFinite(cost) ? cost : null;
}

/**
 * Each provider takes effort its own way. OpenAI: reasoningEffort, including "max".
 * Anthropic: adaptive thinking plus an effort level; the SDK's generic `reasoning`
 * setting does not turn on Claude's thinking through the gateway. Others: `reasoning`.
 */
function reasoningOptions(model: string, effort: AnyEffort): { providerOptions?: Record<string, JSONObject>; reasoning?: "low" | "medium" | "high" | "xhigh" } {
  if (model.startsWith("openai/")) return { providerOptions: { openai: { reasoningEffort: effort } } };
  if (model.startsWith("anthropic/")) return { providerOptions: { anthropic: { thinking: { type: "adaptive" as const }, effort } } };
  return { reasoning: effort === "max" ? "xhigh" as const : effort };
}

/** One structured model call with the role's model, effort and timeout; returns the parsed output and its usage. */
export async function structured<S extends z.ZodType>(step: string, role: Role, schema: S, system: string, prompt: string, maxOutputTokens: number): Promise<{ output: z.infer<S>; usage: Usage }> {
  const { timeoutMs } = ROLE_DEFAULTS[role];
  const model = modelFor(role);
  const effort = effortFor(role);
  const started = Date.now();
  const common = {
    model: gateway(model),
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(timeoutMs),
    // Reasoning tokens count against the output budget, so effortful calls get headroom.
    maxOutputTokens: effort ? Math.max(maxOutputTokens, 54_000) : maxOutputTokens,
    ...(effort ? reasoningOptions(model, effort) : {}),
  };
  const usageOf = (results: { totalUsage: { inputTokens?: number; outputTokens?: number }; providerMetadata?: unknown }[]): Usage => {
    const costs = results.map((r) => gatewayCost(r.providerMetadata));
    return { step, model, ms: Date.now() - started,
      inputTokens: results.reduce((sum, r) => sum + (r.totalUsage.inputTokens ?? 0), 0) || null,
      outputTokens: results.reduce((sum, r) => sum + (r.totalUsage.outputTokens ?? 0), 0) || null,
      cost: costs.every((c) => c === null) ? null : costs.reduce<number>((sum, c) => sum + (c ?? 0), 0) };
  };
  const result = await generateText({ ...common, system, prompt, output: Output.object({ schema }) });
  if (!result.output) throw new Error(`${step}: empty model output (${result.finishReason})`);
  return { output: schema.parse(result.output), usage: usageOf([result]) };
}

// An ordered low/medium/high rubric is a Score in TypeSafe terms (levels from low to high);
// anything else is a Choice. Both JEV paths send the same questions.
const ORDER = ["low", "medium", "high"];
const asScore = (q: ChoiceQuestion) => Object.keys(q.criteria).sort().join() === "high,low,medium";
// A true/false rubric is a yes/no question: "boolean" on the gateway, Noul on TypeSafe's API, answered as P(yes).
const asYesNo = (q: ChoiceQuestion) => Object.keys(q.criteria).sort().join() === "false,true";
function wireQuestions(questions: Record<string, ChoiceQuestion>) {
  return Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, asScore(q)
    ? { type: "score" as const, instructions: q.instructions, criteria: ORDER.map((level) => q.criteria[level]) }
    : asYesNo(q) ? { type: "boolean" as const, instructions: q.instructions, criteria: { true: q.criteria.true, false: q.criteria.false } }
    : { type: "choice" as const, instructions: q.instructions, criteria: q.criteria }]));
}
const yesNoAnswer = (p: number) => ({ true: p, false: 1 - p });
const levelNames = (probabilities: Record<string, number>) => Object.fromEntries(Object.entries(probabilities).map(([level, p]) => [ORDER[Number(level)] ?? level, p]));

// TypeSafe's direct API (https://docs.typesafe.ai/api): no shared gateway pool, ~$0.042 per 1M input tokens.
const directAnswer = z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number()).optional() });
const directResponse = z.object({ model: z.string(), answers: z.record(z.string(), z.unknown()), usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional() });

async function rateDirect(step: string, state: JSONObject, questions: Record<string, ChoiceQuestion>): Promise<{ answers: Record<string, Record<string, number>>; usage: Usage }> {
  const started = Date.now();
  const body = JSON.stringify({ model: process.env.JEV_MODEL || "jev-latest", state, questions: Object.fromEntries(Object.entries(wireQuestions(questions)).map(([id, q]) => [id, q.type === "boolean" ? { ...q, type: "noul" } : q])) });
  for (let attempt = 1; ; attempt++) {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST", body, signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    });
    if ((response.status === 429 || response.status === 529) && attempt < 2) { await response.body?.cancel(); await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const parsed = directResponse.parse(await response.json());
    const answers: Record<string, Record<string, number>> = {};
    for (const [id, raw] of Object.entries(parsed.answers)) {
      const score = z.object({ type: z.literal("score"), probabilities: z.record(z.string(), z.number()) }).safeParse(raw);
      if (score.success) { answers[id] = levelNames(score.data.probabilities); continue; }
      const noul = z.object({ type: z.literal("noul"), noul: z.number() }).safeParse(raw);
      if (noul.success) { answers[id] = yesNoAnswer(noul.data.noul); continue; }
      const answer = directAnswer.safeParse(raw);
      if (answer.success) answers[id] = answer.data.probabilities ?? { [answer.data.choice]: 1 };
    }
    const inputTokens = parsed.usage?.input_tokens ?? null;
    return { answers, usage: { step, model: `typesafe/${parsed.model}`, ms: Date.now() - started, inputTokens, outputTokens: parsed.usage?.output_tokens ?? null, cost: inputTokens === null ? null : inputTokens * 0.042e-6 } };
  }
}

// JEV scores choice questions with calibrated probabilities. Order: the AI Gateway (same
// price, shared pool, sometimes throttled), then TypeSafe's direct API, then the facts model.
const JEV_TIMEOUT_MS = 45_000;

/** Choice confidence as TypeSafe defines it: how concentrated the distribution is, 0 (flat) to 1. */
export function confidenceOf(probabilities: Record<string, number>, options: number): number {
  const peak = Math.max(0, ...Object.values(probabilities));
  return options > 1 ? Math.max(0, Math.min(1, (options * peak - 1) / (options - 1))) : 1;
}

export type ChoiceQuestion = { instructions: string; criteria: Record<string, string> };

export async function rateChoices(step: string, state: JSONObject, questions: Record<string, ChoiceQuestion>, fallbackSystem: string): Promise<{ answers: Record<string, Record<string, number>>; usage: Usage; evaluator: "jev" | "fallback" }> {
  const started = Date.now();
  try {
    const result = await evaluate({
      model: gateway.evaluationModel("typesafe-ai/jev"), maxRetries: 1, abortSignal: AbortSignal.timeout(JEV_TIMEOUT_MS), state,
      questions: wireQuestions(questions),
    });
    const answers: Record<string, Record<string, number>> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      if (answer.type === "score" && answer.probabilities) answers[id] = levelNames(answer.probabilities);
      else if (answer.type === "boolean") answers[id] = yesNoAnswer(answer.probability);
      else if (answer.type === "choice") answers[id] = answer.probabilities ?? { [answer.choice]: 1 };
    }
    const inputTokens = result.usage?.inputTokens ?? null;
    return { answers, evaluator: "jev", usage: { step, model: "typesafe-ai/jev", ms: Date.now() - started, inputTokens, outputTokens: result.usage?.outputTokens ?? null, cost: inputTokens === null ? null : inputTokens * 0.042e-6 } };
  } catch (error) {
    console.warn("forwardpass.jev_gateway_failed", JSON.stringify({ step, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
  }
  if (process.env.TYPESAFE_API_KEY) {
    try {
      return { ...await rateDirect(step, state, questions), evaluator: "jev" };
    } catch (error) {
      console.warn("forwardpass.jev_direct_failed", JSON.stringify({ step, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
    }
  }
  const choices = [...new Set(Object.values(questions).flatMap(({ criteria }) => Object.keys(criteria)))] as [string, ...string[]];
  const schema = z.object({ ratings: z.array(z.object({ id: z.string(), choice: z.enum(choices) })) });
  const { output, usage } = await structured(`${step}-fallback`, "facts", schema, fallbackSystem, JSON.stringify(state), 4000);
  return { answers: Object.fromEntries(output.ratings.map(({ id, choice }) => [id, { [choice]: 1 }])), usage, evaluator: "fallback" };
}
