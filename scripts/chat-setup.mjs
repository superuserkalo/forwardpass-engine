import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const mode = process.argv[2] ?? "assets";
if (!["assets", "register-discord", "register-telegram"].includes(mode)) throw new Error("Use assets, register-discord, or register-telegram.");
const backend = new URL(process.env.CHAT_BACKEND_URL ?? "https://forwardpass-engine.REPLACE.workers.dev");
if (backend.protocol !== "https:" || backend.username || backend.password || backend.search || backend.hash || backend.pathname !== "/") throw new Error("CHAT_BACKEND_URL must be a public HTTPS origin.");
if (mode !== "assets" && backend.hostname.includes("replace")) throw new Error("Set CHAT_BACKEND_URL to the deployed Forward Pass Worker origin first.");
const endpoint = platform => `${backend.origin}/chat/webhooks/${platform}`;
const command = {
  name: "forwardpass", description: "Connect or pause your Forward Pass daily digest", type: 1,
  integration_types: [0, 1], contexts: [0, 1],
  options: [{ name: "code", description: "Connection code from your reading brief, or stop", type: 3, required: true, max_length: 64 }],
};

if (mode === "assets") {
  const directory = resolve(process.argv[3] ?? "docs/chat-apps/generated");
  await mkdir(directory, { recursive: true });
  const json = (name, value) => writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`);
  const slack = {
    display_information: { name: "Forward Pass", description: "Your daily AI newsletter in your inbox or team channel.", background_color: "#171717" },
    features: {
      bot_user: { display_name: "Forward Pass", always_online: false },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      slash_commands: [{ command: "/forwardpass", url: endpoint("slack"), description: "Connect or pause your daily digest", usage_hint: "<connection-code or stop>", should_escape: false }],
    },
    oauth_config: {
      redirect_urls: [`${backend.origin}/chat/oauth/slack`],
      scopes: { bot: ["chat:write", "commands", "im:write", "channels:join", "channels:read", "groups:read", "users:read", "mcp:connect"] },
    },
    mcp_servers: { forwardpass: { url: `${backend.origin}/chat/mcp/slack`, auth_type: "slack_identity_auth" } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
  // Keep the generated package ID stable across reruns by setting TEAMS_PACKAGE_ID.
  const packageId = process.env.TEAMS_PACKAGE_ID ?? randomUUID();
  const teams = {
    $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json", manifestVersion: "1.19", version: "1.0.0", id: packageId,
    packageName: "net.theforwardpass.newsletter",
    developer: { name: "The Forward Pass", websiteUrl: "https://theforwardpass.net", privacyUrl: "https://theforwardpass.net/privacy", termsOfUseUrl: "https://theforwardpass.net/terms" },
    name: { short: "Forward Pass", full: "The Forward Pass newsletter" },
    description: { short: "Daily AI news in your personal chat or team channel.", full: "Receive a compact AI-generated daily digest with links to the full Forward Pass edition. Connect a personal chat, group chat or team channel from your reading brief. Confirm, pause and disconnect each destination independently." },
    icons: { outline: "outline.png", color: "color.png" }, accentColor: "#171717",
    bots: [{ botId: process.env.TEAMS_APP_ID ?? "REPLACE_WITH_TEAMS_BOT_APP_ID", scopes: ["personal", "team", "groupchat"], supportsFiles: false, isNotificationOnly: false,
      commandLists: [{ scopes: ["personal", "team", "groupchat"], commands: [{ title: "connect", description: "Connect using the code from your Forward Pass reading brief" }, { title: "stop", description: "Pause daily delivery to this conversation" }] }] }],
    validDomains: ["theforwardpass.net"],
  };
  await json("slack-manifest.json", slack);
  await json("discord-command.json", command);
  await json("teams-manifest.json", teams);
  await json("endpoints.json", { backend: backend.origin, slackOAuth: `${backend.origin}/chat/oauth/slack`, webhooks: Object.fromEntries(["slack", "discord", "telegram", "teams"].map(platform => [platform, endpoint(platform)])), teamsPackageId: packageId });
  console.log(`Public registration assets written to ${directory}. Replace placeholder IDs/origin before importing.`);
} else {
  const required = mode === "register-discord" ? ["DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN"] : ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET_TOKEN"];
  for (const name of required) if (!process.env[name]) throw new Error(`Set ${name} in your local environment file.`);
  async function providerRequest(url, body, headers = {}) {
    let response;
    try { response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error("Provider request failed. Check the provider dashboard before repeating setup."); }
    if (!response.ok) throw new Error(`Provider rejected setup (HTTP ${response.status}).`);
    let result;
    try { result = await response.json(); } catch { throw new Error("Provider returned an unreadable setup response. Check its dashboard before repeating setup."); }
    if (result.ok === false) throw new Error("Telegram rejected setup. Check the bot configuration in BotFather.");
  }
  if (mode === "register-discord") {
    if (!/^\d{17,20}$/.test(process.env.DISCORD_APPLICATION_ID)) throw new Error("Invalid Discord application ID.");
    await providerRequest(`https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/commands`, command, { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` });
    console.log("Forward Pass slash command registered. Set the interactions URL in the Discord dashboard using endpoints.json.");
  } else {
    await providerRequest(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setMyCommands`, { commands: [{ command: "start", description: "Connect from your Forward Pass reading brief" }, { command: "forwardpass", description: "Connect with a code or pause with stop" }] });
    await providerRequest(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, { url: endpoint("telegram"), secret_token: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN, allowed_updates: ["message"] });
    console.log("Forward Pass Telegram commands and authenticated webhook configured.");
  }
}
