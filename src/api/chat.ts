import { randomBytes } from "node:crypto";
import { Chat } from "chat";
import { z } from "zod";
import { chatAvailability, slackAdapter } from "../lib/chat-bot.js";
import { chatState } from "../lib/chat-state.js";
import { chatModeSchema, chatPlatformSchema, type ChatSubscriptionService } from "../lib/chat-subscriptions.js";
import { verifyPreferencesToken } from "../lib/preference-link.js";
import { boundedText } from "../lib/request-body.js";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
export const slackScopes = "chat:write,commands,im:write,channels:join,channels:read,groups:read,users:read,mcp:connect";
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), platform: chatPlatformSchema, mode: chatModeSchema }),
  z.object({ action: z.literal("update"), id: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(["active", "paused", "disconnected"]) }),
  z.object({ action: z.literal("install-slack") }),
]);
const oauthKey = (state: string) => `oauth-slack:${state}`;

export async function handleChatSettings(request: Request, service: ChatSubscriptionService, backendOrigin: string): Promise<Response> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const email = bearer ? verifyPreferencesToken(bearer) : null;
  if (!email) return json({ error: "Sign in to manage delivery." }, 401);
  if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed." }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== (process.env.PUBLIC_SITE_URL ?? "https://theforwardpass.net")) return json({ error: "Origin not allowed." }, 403);
  try {
    if (request.method === "GET") return json({ available: chatAvailability(), destinations: (await service.list(email)).map(({ id, platform, mode, label, status, createdAt }) => ({ id, platform, mode, label, status, createdAt })) });
    const input = mutationSchema.parse(JSON.parse(await boundedText(request, 4096)));
    if (input.action === "update") return await service.update(email, input.id, input.status) ? json({ updated: true }) : json({ error: "Destination unavailable. Create a fresh connection if it expired." }, 404);
    if (input.action === "install-slack") {
      if (!chatAvailability().slack) return json({ error: "Slack setup is not available yet." }, 503);
      const state = Buffer.from(randomBytes(24)).toString("base64url");
      await service.setValue(oauthKey(state), { email }, 10 * 60_000);
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.search = new URLSearchParams({ client_id: process.env.SLACK_CLIENT_ID ?? "", scope: slackScopes, redirect_uri: `${backendOrigin}/chat/oauth/slack`, state }).toString();
      return json({ url: url.toString() });
    }
    if (!chatAvailability()[input.platform]) return json({ error: "This channel is not available yet." }, 503);
    const link = await service.createLink(email, input.platform, input.mode);
    let url: string | null = null;
    if (input.platform === "telegram") {
      const name = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
      if (name && /^[A-Za-z0-9_]+$/.test(name)) url = `https://t.me/${name}?${input.mode === "personal" ? "start" : "startgroup"}=${link.token}`;
    }
    if (input.platform === "discord" && input.mode === "shared") {
      const install = new URL("https://discord.com/oauth2/authorize");
      install.search = new URLSearchParams({ client_id: process.env.DISCORD_APPLICATION_ID ?? "", scope: "bot applications.commands", permissions: "68608" }).toString();
      url = install.toString();
    }
    if (input.platform === "discord" && input.mode === "personal") url = `https://discord.com/users/${process.env.DISCORD_APPLICATION_ID}`;
    if (input.platform === "teams" && process.env.TEAMS_PACKAGE_ID) url = `https://teams.microsoft.com/l/app/${encodeURIComponent(process.env.TEAMS_PACKAGE_ID)}`;
    return json({ ...link, url, command: input.platform === "teams" ? `connect ${link.token}` : `/forwardpass ${link.token}` });
  } catch (error) {
    return error instanceof z.ZodError || error instanceof SyntaxError
      ? json({ error: "Invalid delivery request." }, 400)
      : json({ error: "Could not update delivery. Try again shortly." }, 503);
  }
}

/** OAuth state is one-use and required before exchanging or persisting tokens. */
export async function handleSlackOAuth(request: Request, service: ChatSubscriptionService, backendOrigin: string): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{32}$/.test(state) || !await service.getValue(oauthKey(state))) return json({ error: "Installation link expired. Start again from your reading brief." }, 400);
  if (!await service.setIfAbsent(`${oauthKey(state)}:used`, true, 10 * 60_000)) return json({ error: "Installation link already used." }, 400);
  await service.deleteValue(oauthKey(state));
  if (url.searchParams.has("error")) return json({ error: "Slack installation was canceled." }, 400);
  try {
    const adapter = slackAdapter();
    const bot = new Chat({ userName: "forwardpass", adapters: { slack: adapter }, state: chatState(service), logger: "silent" });
    await bot.initialize();
    await adapter.handleOAuthCallback(request, { redirectUri: `${backendOrigin}/chat/oauth/slack` });
    return new Response(null, { status: 303, headers: { Location: `${process.env.PUBLIC_SITE_URL ?? "https://theforwardpass.net"}/preferences#delivery`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch { return json({ error: "Slack installation failed. Start again from your reading brief." }, 503); }
}
