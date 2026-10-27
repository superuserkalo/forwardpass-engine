import { Card, CardText, Chat, ConsoleLogger, type Adapter, type SlashCommandEvent, type Thread, type Message } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createDiscordAdapter, DiscordInteractionResponseFlag } from "@chat-adapter/discord";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { z } from "zod";
import { chatPlatformSchema, type ChatPlatform, type ChatDestination, type ChatSubscriptionService, type DestinationCandidate } from "./chat-subscriptions.js";
import { chatState } from "./chat-state.js";
const silent = new ConsoleLogger("silent");

export function chatAvailability(): Record<ChatPlatform, boolean> {
  const present = (...names: string[]) => names.every(name => !!process.env[name]);
  return {
    slack: present("SLACK_SIGNING_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_ENCRYPTION_KEY"),
    discord: present("DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID"),
    telegram: present("TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET_TOKEN", "TELEGRAM_BOT_USERNAME"),
    teams: present("TEAMS_APP_ID", "TEAMS_APP_PASSWORD", "TEAMS_APP_TENANT_ID", "TEAMS_APP_TYPE"),
  };
}
export function slackAdapter() {
  return createSlackAdapter({
    signingSecret: process.env.SLACK_SIGNING_SECRET, clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET, encryptionKey: process.env.SLACK_ENCRYPTION_KEY,
    // Let the delivery ledger decide retries; the default can retry for 30 minutes.
    webClientOptions: {
      // Axios supplies cache: "default", which Workers rejects before reaching Slack.
      requestInterceptor: config => ({ ...config, adapter: "fetch", fetchOptions: { ...config.fetchOptions, cache: "no-store" } }),
      retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000,
    }, logger: silent,
  });
}
const slackEventSchema = z.object({ team_id: z.string(), enterprise_id: z.string().optional(), is_enterprise_install: z.string().optional(), channel_id: z.string(), channel_name: z.string().optional() });
const discordEventSchema = z.object({ guild_id: z.string().optional(), channel_id: z.string(), member: z.object({ permissions: z.string().optional() }).optional() });
const telegramEventSchema = z.object({ chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional() }), message_thread_id: z.number().optional() });
const teamsEventSchema = z.object({ conversation: z.object({ id: z.string(), name: z.string().optional(), conversationType: z.enum(["personal", "channel", "groupChat"]).optional() }), serviceUrl: z.url(), channelData: z.object({ tenant: z.object({ id: z.string() }), team: z.object({ name: z.string().optional() }).optional(), channel: z.object({ name: z.string().optional(), id: z.string().optional() }).optional() }) });

export function discordCanManage(raw: unknown): boolean {
  const parsed = discordEventSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.member?.permissions) return false;
  try { return (BigInt(parsed.data.member.permissions) & (8n | 16n | 32n)) !== 0n; } catch { return false; }
}

async function telegramCanManage(chatId: number, userId: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ chat_id: chatId, user_id: Number(userId) }),
  });
  if (!response.ok) return false;
  const member = z.object({ ok: z.literal(true), result: z.object({ status: z.string() }) }).safeParse(await response.json());
  return member.success && ["creator", "administrator"].includes(member.data.result.status);
}

export function createChatRuntime(service: ChatSubscriptionService, platform: ChatPlatform) {
  if (!chatAvailability()[platform]) throw new Error("Chat platform is not configured.");
  const adapters: Record<string, Adapter> = {};
  if (platform === "slack") adapters.slack = slackAdapter();
  if (platform === "discord") adapters.discord = createDiscordAdapter({ interactionFlags: () => DiscordInteractionResponseFlag.Ephemeral, logger: silent });
  if (platform === "telegram") adapters.telegram = createTelegramAdapter({ mode: "webhook", logger: silent });
  if (platform === "teams") adapters.teams = createTeamsAdapter({ appType: z.enum(["SingleTenant", "MultiTenant"]).parse(process.env.TEAMS_APP_TYPE), logger: silent });
  const bot = new Chat({ userName: "forwardpass", adapters, state: chatState(service), logger: "silent" });

  async function command(event: SlashCommandEvent) {
    const requested = chatPlatformSchema.parse(event.adapter.name);
    const argument = event.text.trim().replace(/^connect\s+/i, "");
    const ticket = argument === "stop" ? null : await service.link(argument);
    const respond = async (text: string) => {
      if (requested === "slack") await event.channel.postEphemeral(event.user, text, { fallbackToDM: false });
      else await event.channel.post(text);
    };
    if (argument !== "stop" && (!ticket || ticket.platform !== requested)) {
      await respond("Open the Delivery section of your Forward Pass reading brief to create a new connection code."); return;
    }
    const mode = ticket?.mode ?? (event.channel.isDM ? "personal" : "shared");
    let target: string;
    let installation: string | null = null;
    let label = `${requested} ${mode === "personal" ? `inbox · ${event.user.fullName ?? event.user.userName ?? event.user.userId}` : "channel"}`;
    if (requested === "slack") {
      const raw = slackEventSchema.parse(event.raw);
      installation = raw.is_enterprise_install === "true" ? raw.enterprise_id ?? raw.team_id : raw.team_id;
      if (mode === "personal") { if (!event.adapter.openDM) throw new Error("DMs unavailable"); target = await event.adapter.openDM(event.user.userId); }
      else {
        if (!/^[CG][A-Z0-9]+$/.test(raw.channel_id)) { await respond("Run this command in the team channel you want to connect."); return; }
        target = `slack:${raw.channel_id}:`;
        label = `#${raw.channel_name ?? raw.channel_id}`;
        // Slack's app installation and channel policy control whether the app can join.
        const installed = await slackAdapterFor(service, installation);
        await installed.adapter.withBotToken(installed.token, () => installed.adapter.webClient.conversations.join({ channel: raw.channel_id }), { installationId: installation });
      }
    } else if (requested === "discord") {
      const raw = discordEventSchema.parse(event.raw);
      if (mode === "personal") { if (!event.adapter.openDM) throw new Error("DMs unavailable"); target = await event.adapter.openDM(event.user.userId); }
      else {
        if (!raw.guild_id || !discordCanManage(event.raw)) { await respond("A server administrator or channel manager must connect a shared channel."); return; }
        installation = raw.guild_id;
        target = `discord:${raw.guild_id}:${raw.channel_id}`;
        label = `Discord channel ${raw.channel_id}`;
      }
    } else if (requested === "telegram") {
      const raw = telegramEventSchema.parse(event.raw);
      if (mode === "personal" && (raw.chat.type !== "private" || String(raw.chat.id) !== event.user.userId)) {
        await respond("Open the bot directly to connect your personal inbox."); return;
      }
      if (mode === "shared" && (!["group", "supergroup"].includes(raw.chat.type) || !await telegramCanManage(raw.chat.id, event.user.userId))) {
        await respond("A group administrator must connect a shared group."); return;
      }
      target = `telegram:${raw.chat.id}${raw.message_thread_id ? `:${raw.message_thread_id}` : ""}`;
      label = `${raw.chat.title ?? `Telegram inbox · ${event.user.fullName ?? event.user.userName ?? event.user.userId}`}${raw.message_thread_id ? ` · topic ${raw.message_thread_id}` : ""}`;
    } else { return; }
    const candidate: DestinationCandidate = { platform: requested, mode, target, installation, actor: event.user.userId, label: label.slice(0, 160) };
    if (argument === "stop") { await respond(await service.stop(candidate) ? "Daily delivery paused." : "Manage this destination from its owner's reading brief."); return; }
    await respond(await service.attach(argument, candidate)
      ? "Connection found. Return to your Forward Pass reading brief and confirm this destination to start daily delivery."
      : "Could not connect this destination. Create a fresh code in your reading brief.");
  }
  bot.onSlashCommand(["/forwardpass", "/start"], command);
  async function teamsMessage(thread: Thread, message: Message) {
    if (platform !== "teams" || message.author.isBot || message.author.isMe) return;
    const argument = /(?:^|\s)(?:connect\s+)?([A-Za-z0-9_-]{32}|stop)\s*$/i.exec(message.text)?.[1];
    if (!argument) return;
    const raw = teamsEventSchema.parse(message.raw);
    const mode = thread.isDM ? "personal" : "shared";
    const ticket = argument === "stop" ? null : await service.link(argument);
    if (argument !== "stop" && (!ticket || ticket.platform !== "teams" || ticket.mode !== mode)) {
      await thread.post("Create a connection code for this inbox or shared conversation in your Forward Pass reading brief."); return;
    }
    const conversationType = raw.conversation.conversationType ?? (mode === "personal" ? "personal" : raw.channelData.team ? "channel" : "groupChat");
    const conversationId = conversationType === "channel" ? raw.conversation.id.replace(/;messageid=\d+/g, "") : raw.conversation.id;
    const target = bot.getAdapter("teams").encodeThreadId({ conversationId, serviceUrl: raw.serviceUrl, conversationType });
    const sharedLabel = [raw.channelData.team?.name, raw.channelData.channel?.name ?? raw.conversation.name ?? raw.channelData.channel?.id ?? raw.conversation.id].filter(Boolean).join(" · ");
    const candidate: DestinationCandidate = { platform: "teams", mode, target, installation: raw.channelData.tenant.id, actor: message.author.userId, label: (mode === "personal" ? `Teams inbox · ${message.author.fullName}` : sharedLabel).slice(0, 160) };
    const attached = argument === "stop" ? await service.stop(candidate) : await service.attach(argument, candidate);
    await thread.post(attached ? (argument === "stop" ? "Daily delivery paused." : "Return to your Forward Pass reading brief and confirm this destination to start daily delivery.") : "Could not update this destination. Open your reading brief to try again.");
  }
  bot.onDirectMessage(teamsMessage);
  bot.onNewMention(teamsMessage);
  return bot;
}

async function slackAdapterFor(service: ChatSubscriptionService, installationId: string) {
  const adapter = slackAdapter();
  const bot = new Chat({ userName: "forwardpass", adapters: { slack: adapter }, state: chatState(service), logger: "silent" });
  await bot.initialize();
  const installation = await adapter.getInstallation(installationId);
  if (!installation) throw new Error("Slack installation is unavailable.");
  return { adapter, token: installation.botToken };
}

export async function postChatDigest(service: ChatSubscriptionService, destination: ChatDestination, markdown: string): Promise<string> {
  if (destination.platform === "slack") {
    const installed = await slackAdapterFor(service, destination.installation ?? "");
    const result = await installed.adapter.withBotToken(installed.token, () => installed.adapter.postMessage(destination.target, { markdown }), { installationId: destination.installation ?? undefined });
    return result.id;
  }
  const bot = createChatRuntime(service, destination.platform);
  await bot.initialize();
  // Telegram cards use regular MarkdownV2 messages, preserving paragraph spacing.
  const message = destination.platform === "telegram" ? Card({ children: [CardText(markdown)] }) : { markdown };
  const result = await bot.getAdapter(destination.platform).postMessage(destination.target, message);
  return result.id;
}
