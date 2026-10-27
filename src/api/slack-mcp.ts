import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Chat } from "chat";
import { serveAccountMcp, serveMcpDiscovery, type AgentOptions } from "./agent.js";
import { slackAdapter } from "../lib/chat-bot.js";
import { chatState } from "../lib/chat-state.js";
import type { ChatSubscriptionService } from "../lib/chat-subscriptions.js";
import { agentCreditAccountId } from "../lib/agent-credits.js";
import { boundedText } from "../lib/request-body.js";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const identity = z.object({
  user_id: z.string().regex(/^[UW][A-Z0-9]+$/),
  team_id: z.string().regex(/^T[A-Z0-9]+$/).nullable(),
  enterprise_id: z.string().regex(/^E[A-Z0-9]+$/).nullable(),
});
const rpc = z.object({ method: z.string(), params: z.object({ _meta: z.object({ slack: identity }).optional() }).optional() });

function signed(request: Request, body: string, secret: string): boolean {
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000 || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Slack identity auth never trusts unsigned metadata or charges another member's account. */
export async function handleSlackMcp(request: Request, service: ChatSubscriptionService, options: AgentOptions = {}): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return json({ error: "Slack is not configured." }, 503);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Expected application/json." }, 415);
  let body: string;
  try { body = await boundedText(request, 16_384); } catch { return json({ error: "Request exceeds 16 KiB." }, 413); }
  if (!signed(request, body, secret)) return json({ error: "Invalid Slack signature." }, 401);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return json({ error: "Invalid JSON." }, 400); }
  const input = rpc.safeParse(parsed);
  if (!input.success) return json({ error: "Invalid MCP request." }, 400);
  const forwarded = new Request(request, { body });
  try {
    if (["initialize", "notifications/initialized", "tools/list", "ping"].includes(input.data.method)) return await serveMcpDiscovery(forwarded, parsed);
    if (input.data.method !== "tools/call") return json({ error: "Unsupported MCP method." }, 400);
    const caller = input.data.params?._meta?.slack;
    if (!caller) return json({ error: "Slack caller identity is required." }, 401);
    const installations = [caller.team_id, caller.enterprise_id].filter((id): id is string => id !== null);
    const adapter = slackAdapter();
    await new Chat({ userName: "forwardpass", adapters: { slack: adapter }, state: chatState(service), logger: "silent" }).initialize();
    const owners = new Set<string>();
    for (const installation of installations) {
      if (!await adapter.getInstallation(installation)) continue;
      const owner = await service.slackAccount(installation, caller.user_id);
      if (owner) owners.add(owner);
    }
    if (owners.size !== 1) return json({ error: "Connect and confirm your personal Slack inbox at theforwardpass.net/preferences#delivery before using coverage tools. Disconnect conflicting accounts first." }, 403);
    const email = [...owners][0];
    if (options.limiter && !(await options.limiter.limit({ key: `slack-mcp:${agentCreditAccountId(email)}` })).success) {
      const response = json({ error: "Too many requests. Try again in a minute." }, 429);
      response.headers.set("Retry-After", "60");
      return response;
    }
    // Same subscription, brief, archive limits and credit ledger as the existing MCP API.
    return await serveAccountMcp(forwarded, email, { ...options, codeExecutor: undefined });
  } catch { return json({ error: "Coverage is temporarily unavailable. Try again shortly." }, 503); }
}
