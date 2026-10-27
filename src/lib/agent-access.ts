import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Resend } from "resend";
import { z } from "zod";
import { deletePrivateJson, readPrivateJson, writePrivateJson } from "./private-store.js";
import { agentPlanSchema, type AgentPlan } from "./agent-credits.js";

const keySchema = z.object({ email: z.email(), hash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() });
const tokenPattern = /^fp_agent_([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const objectKey = (id: string) => `agent-access/${id}.json`;

export function agentAccountId(email: string): string {
  const secret = process.env.PREFERENCES_SIGNING_SECRET;
  if (!secret || secret.length < 32) throw new Error("Agent access is not configured.");
  return createHmac("sha256", secret).update(`agent-account:${email.toLowerCase()}`).digest("hex");
}

/** One read-only key per reader. Replacing it invalidates the old key atomically in R2. */
export async function createAgentKey(email: string, now = new Date()) {
  const id = agentAccountId(email);
  const token = `fp_agent_${id}.${Buffer.from(randomBytes(32)).toString("base64url")}`;
  const createdAt = now.toISOString();
  await writePrivateJson(objectKey(id), { email, hash: hash(token), createdAt });
  return { token, createdAt };
}

export async function agentKeyStatus(email: string) {
  const parsed = keySchema.safeParse(await readPrivateJson(objectKey(agentAccountId(email))));
  return { createdAt: parsed.success ? parsed.data.createdAt : null };
}

export async function revokeAgentKey(email: string): Promise<void> {
  await deletePrivateJson(objectKey(agentAccountId(email)));
}

export function agentKeyId(token: string): string | null {
  return tokenPattern.exec(token)?.[1] ?? null;
}

export async function agentKeyOwner(token: string): Promise<string | null> {
  const id = agentKeyId(token);
  if (!id) return null;
  const parsed = keySchema.safeParse(await readPrivateJson(objectKey(id)));
  if (!parsed.success || agentAccountId(parsed.data.email) !== id) return null;
  return timingSafeEqual(Buffer.from(parsed.data.hash, "hex"), Buffer.from(hash(token), "hex")) ? parsed.data.email : null;
}

/** Billing webhooks keep these properties authoritative. Upstream errors never grant access. */
export async function agentProfile(email: string, resend?: Resend): Promise<{ interests: string; plan: AgentPlan; trialEndsAt: string | null } | null> {
  const key = process.env.RESEND_API_KEY;
  if (!resend && !key) throw new Error("Subscriber service unavailable.");
  const { data, error } = await (resend ?? new Resend(key)).contacts.get({ email });
  if (error) {
    if (error.name === "not_found") return null;
    throw new Error("Subscriber service unavailable.");
  }
  if (!data) return null;
  const plan = agentPlanSchema.safeParse(data.properties.personal_plan?.value);
  if (!plan.success) return null;
  const status = data.properties.personal_status?.value;
  const end = data.properties.personal_trial_ends_at?.value;
  const trialEndsAt = status === "trial" && plan.data === "personal" && typeof end === "string" && z.iso.datetime().safeParse(end).success && Date.parse(end) > Date.now() ? end : null;
  if (status !== "active" && !trialEndsAt) return null;
  const interests = data.properties.interests?.value;
  return { interests: typeof interests === "string" ? interests.slice(0, 500) : "", plan: plan.data, trialEndsAt };
}
