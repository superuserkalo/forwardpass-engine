import { AdapterRateLimitError, AuthenticationError, PermissionError, ResourceNotFoundError, ValidationError } from "@chat-adapter/shared";
import { RateLimitError } from "chat";
import { z } from "zod";
import { loadIssue, publishedMarkerSchema, type IssueV2 } from "../lib/issue.js";
import { readPrivateJson, writePrivateJson } from "../lib/private-store.js";
import { chatAvailability, postChatDigest } from "../lib/chat-bot.js";
import type { ChatDestination, ChatPlatform, ChatSubscriptionService } from "../lib/chat-subscriptions.js";
import { IO_STEP, type Steps } from "../pipeline/steps.js";

export type ChatDeliveryJob = { date: string; platform: ChatPlatform; destinationId?: string };
export type ChatDeliveryOutcome = "sent" | "alreadySent" | "skipped" | "failed" | "needsReconciliation" | "retryable";
export type ChatDeliveryResult = { date: string; platform: ChatPlatform; sent: number; alreadySent: number; skipped: number; failed: number; needsReconciliation: number; retryable: number };
const clip = (value: string, length: number) => value.length <= length ? value : `${value.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
const literal = (text: string) => text.replace(/\s+/g, " ").replace(/@/g, "@\u200b").replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&");
const shortLiteral = (text: string, maximum: number) => clip(literal(text), maximum).replace(/\\+…$/, "…");

/** A single short native message, derived only from the verified edition. */
export function renderChatDigest(issue: IssueV2, origin = "https://theforwardpass.net"): string {
  const archive = new URL(`/archive/daily/${issue.date}`, origin).toString();
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${issue.date}T12:00:00Z`));
  const featured = issue.stories.filter(story => story.role === "featured").slice(0, 3);
  const signals = issue.stories.filter(story => story.role === "signal").slice(0, 3);
  const link = (story: IssueV2["stories"][number]) => `[${shortLiteral(story.headline, 130)}](${archive}#${story.id})`;
  return [
    `**The Forward Pass · ${date}**`, "Daily AI-generated briefing",
    ...(featured.length ? ["**Top stories**", ...featured.map((story, index) => `**${index + 1}. ${link(story)}**`)] : []),
    ...(signals.length ? ["**Quick signals**", ...signals.map(story => `• ${link(story)}`)] : []),
    `**[Read the full edition →](${archive})**`,
  ].join("\n\n");
}

type Sender = (destination: ChatDestination, markdown: string) => Promise<string>;
function deliveryError(error: unknown, platform: ChatPlatform) {
  const wait = error instanceof AdapterRateLimitError ? (error.retryAfter ?? 30) * 1000 : error instanceof RateLimitError ? error.retryAfterMs ?? 30_000 : null;
  if (wait !== null) return { outcome: "retryable" as const, wait, disconnect: false };
  if (error instanceof AuthenticationError || error instanceof PermissionError || error instanceof ResourceNotFoundError || error instanceof ValidationError) {
    return { outcome: "failed" as const, wait: 0, disconnect: !(error instanceof ValidationError) };
  }
  // The installed Slack and Discord adapters retain native API rejection errors.
  if (platform === "slack") {
    const native = z.object({ code: z.string(), retryAfter: z.number().optional(), data: z.object({ error: z.string() }).optional() }).safeParse(error);
    if (native.success) {
      if (native.data.code === "slack_webapi_rate_limited_error") return { outcome: "retryable" as const, wait: (native.data.retryAfter ?? 30) * 1000, disconnect: false };
      const disconnected = ["invalid_auth", "token_revoked", "account_inactive", "channel_not_found", "not_in_channel", "missing_scope", "is_archived"];
      const rejected = [...disconnected, "invalid_blocks", "invalid_arguments", "msg_too_long", "no_text", "not_authed"];
      const reason = native.data.data?.error ?? "";
      if (native.data.code === "slack_webapi_platform_error" && rejected.includes(reason)) return { outcome: "failed" as const, wait: 0, disconnect: disconnected.includes(reason) };
    }
  }
  if (platform === "discord") {
    const native = z.object({ originalError: z.object({ name: z.literal("DiscordApiError"), status: z.number(), message: z.string() }) }).safeParse(error);
    if (native.success) {
      const { status, message } = native.data.originalError;
      if (status === 429) {
        let wait = 30_000;
        try { wait = z.object({ retry_after: z.number().nonnegative() }).parse(JSON.parse(message)).retry_after * 1000; } catch { /* Conservative provider cooldown. */ }
        return { outcome: "retryable" as const, wait, disconnect: false };
      }
      if (status >= 400 && status < 500) return { outcome: "failed" as const, wait: 0, disconnect: [401, 403, 404].includes(status) };
    }
  }
  return { outcome: "needsReconciliation" as const, wait: 0, disconnect: false };
}
export async function sendChatIssue(service: ChatSubscriptionService, issue: IssueV2, destination: ChatDestination, send: Sender) {
  const claim = await service.claim(issue.date, destination.id);
  if (claim !== "claimed") return { outcome: claim, retryAfterMs: 0 };
  try {
    const messageId = await send(destination, renderChatDigest(issue));
    if (typeof messageId !== "string" || !messageId) throw new Error("The provider did not acknowledge a message ID.");
    await service.finish(issue.date, destination.id, "sent", messageId);
    return { outcome: "sent" as const, retryAfterMs: 0 };
  } catch (error) {
    const failure = deliveryError(error, destination.platform);
    if (failure.outcome === "retryable") {
      await service.finish(issue.date, destination.id, "retryable", null);
      return { outcome: "retryable" as const, retryAfterMs: Math.max(1000, failure.wait) };
    }
    const rejected = failure.outcome === "failed";
    await service.finish(issue.date, destination.id, rejected ? "failed" : "ambiguous", null);
    if (failure.disconnect) await service.update(destination.owner, destination.id, "disconnected");
    // No blind retry when the provider may have accepted a message before the connection failed.
    return { outcome: rejected ? "failed" as const : "needsReconciliation" as const, retryAfterMs: 0 };
  }
}

export async function deliverChatIssue(steps: Steps, job: ChatDeliveryJob, service: ChatSubscriptionService, send: Sender = (destination, markdown) => postChatDigest(service, destination, markdown)): Promise<ChatDeliveryResult> {
  if (!chatAvailability()[job.platform]) throw new Error("Chat platform is not configured.");
  const totals: ChatDeliveryResult = { ...job, sent: 0, alreadySent: 0, skipped: 0, failed: 0, needsReconciliation: 0, retryable: 0 };
  const issue = await loadIssue(job.date);
  const publication = publishedMarkerSchema.safeParse(await readPrivateJson(`published/daily/${job.date}.json`));
  if (!issue || issue.version !== 2 || !publication.success || publication.data.version !== 2 || publication.data.kind !== "daily" || publication.data.date !== job.date) throw new Error("A published story-record issue is required for chat delivery.");
  let after = "";
  for (let page = 0; ; page++) {
    const audience = await steps.run(`audience-${page}`, IO_STEP, async () => {
      if (!job.destinationId) return service.audience(job.platform, after, 100);
      const destination = await service.destination(job.destinationId);
      if (!destination || destination.platform !== job.platform) throw new Error("Destination unavailable for this platform.");
      return [destination];
    });
    if (!audience.length) break;
    for (const destination of audience) {
      let result = { outcome: "retryable" as ChatDeliveryOutcome, retryAfterMs: 0 };
      for (let attempt = 0; attempt < 4; attempt++) {
        result = await steps.run(`send-${destination.id}-${attempt}`, IO_STEP, () => sendChatIssue(service, issue, destination, send));
        if (result.outcome !== "retryable") break;
        await steps.sleep(`rate-limit-${destination.id}-${attempt}`, result.retryAfterMs);
      }
      totals[result.outcome]++;
      // One job per platform prevents Telegram broadcast bursts and channel flooding.
      await steps.sleep(`pace-${destination.id}`, job.platform === "telegram" ? 100 : 1100);
    }
    after = audience.at(-1)?.id ?? after;
    if (audience.length < 100) break;
  }
  await steps.run("status", IO_STEP, async () => {
    const scope = job.destinationId ? `${job.platform}-${job.destinationId}` : job.platform;
    await writePrivateJson(`delivery/${job.date}/chat/${scope}.json`, { ...totals, completedAt: new Date().toISOString() });
    return true;
  });
  return totals;
}
