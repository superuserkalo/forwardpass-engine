import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { AdapterRateLimitError, PermissionError, NetworkError } from "@chat-adapter/shared";
import { Chat } from "chat";
import { chatFixture, candidate, activeDestination, issueFixture, configured } from "./chat-test-support.mjs";
import { CHAT_LINK_TTL_MS, destinationId } from "../src/lib/chat-subscriptions.ts";
import { chatState } from "../src/lib/chat-state.ts";
import { createChatRuntime, discordCanManage, slackAdapter, postChatDigest } from "../src/lib/chat-bot.ts";
import { renderChatDigest, sendChatIssue, deliverChatIssue } from "../src/delivery/chat.ts";
import { handleChatSettings, handleSlackOAuth } from "../src/api/chat.ts";
import { preferencesLink } from "../src/lib/preference-link.ts";
import { memoryStore, useStore } from "../src/lib/private-store.ts";

let originalEnv;
beforeEach(() => { originalEnv = Object.fromEntries(Object.keys(configured).map(key => [key, process.env[key]])); Object.assign(process.env, configured); });
afterEach(() => { for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

test("connection links are single-use, expire, and cannot change their platform or mode", () => {
  const { registry } = chatFixture();
  const now = Date.now();
  const first = registry.createLink("Reader@example.com", "telegram", "personal", now);
  const second = registry.createLink("reader@example.com", "telegram", "personal", now);
  assert.equal(registry.link(first.token, now), null);
  assert.equal(registry.attach(second.token, candidate("slack"), now), false);
  assert.equal(registry.attach(second.token, candidate("telegram", "1", "shared"), now), false);
  assert.equal(registry.attach(second.token, candidate(), now), true);
  assert.equal(registry.attach(second.token, candidate("telegram", "2"), now), false);
  assert.equal(registry.audience("telegram").length, 0, "attachment must wait for web confirmation");
  const expires = registry.createLink("reader@example.com", "telegram", "shared", now);
  assert.equal(registry.link(expires.token, now + CHAT_LINK_TTL_MS), null);
});

test("pending consent cannot be bypassed by pause/resume and another reader cannot take over", () => {
  const { registry } = chatFixture();
  const now = Date.now();
  const link = registry.createLink("one@example.com", "telegram", "personal", now);
  const target = candidate();
  assert.equal(registry.attach(link.token, target, now), true);
  const id = destinationId(target);
  assert.equal(registry.update("two@example.com", id, "active"), false);
  assert.equal(registry.update("one@example.com", id, "paused"), false);
  assert.equal(registry.stop(target), false);
  assert.equal(registry.update("one@example.com", id, "active", now + CHAT_LINK_TTL_MS), false);
  const attacker = registry.createLink("two@example.com", "telegram", "personal");
  assert.equal(registry.attach(attacker.token, target), false);
  assert.equal(registry.update("one@example.com", id, "disconnected"), true);
  assert.equal(registry.update("one@example.com", id, "active"), false);
  assert.equal(registry.attach(attacker.token, target), true, "a fresh verified connection may claim a released destination");
});

test("personal inboxes and shared destinations coexist, with platform filtering before pagination", () => {
  const { registry } = chatFixture();
  for (let index = 0; index < 110; index++) {
    activeDestination(registry, candidate(index % 2 ? "slack" : "telegram", String(index), index % 3 ? "personal" : "shared"), `reader${index}@example.com`);
  }
  const first = registry.audience("telegram", "", 30);
  const second = registry.audience("telegram", first.at(-1).id, 30);
  assert.equal(first.length, 30); assert.equal(second.length, 25);
  assert.equal(new Set([...first, ...second].map(item => item.id)).size, 55);
  assert.ok([...first, ...second].every(item => item.platform === "telegram"));
  assert.ok([...first, ...second].some(item => item.mode === "shared"));
});

test("only the connecting platform user can pause, and SDK keys cannot corrupt consent", async () => {
  const { registry, service } = chatFixture();
  const destination = activeDestination(registry);
  assert.equal(registry.stop({ ...destination, actor: "other" }), false);
  await service.setValue(`delivery:2026-10-03:${destination.id}`, { status: "sent" });
  assert.equal(registry.claim("2026-10-03", destination.id), "claimed");
  assert.equal(registry.stop(destination), true);
  assert.equal(registry.claim("2026-10-04", destination.id), "skipped");
});

test("state locks resist stale owners after expiry and list writes preserve the newest entries", async () => {
  const { registry, service } = chatFixture();
  const state = chatState(service);
  const first = await state.acquireLock("thread", 60_000);
  assert.ok(first); assert.equal(await state.acquireLock("thread", 60_000), null);
  registry.set("sdk:lock:thread", { token: first.token }, 1, Date.now() - 2);
  assert.equal(await state.extendLock(first, 60_000), false);
  const second = await state.acquireLock("thread", 60_000);
  assert.ok(second); await state.releaseLock(first);
  assert.equal(await state.acquireLock("thread", 60_000), null);
  await state.releaseLock(second);
  await Promise.all([1, 2, 3].map(value => state.appendToList("history", value, { maxLength: 2 })));
  assert.deepEqual(await state.getList("history"), [2, 3]);
  await state.subscribe("thread"); assert.equal(await state.isSubscribed("thread"), true);
  await state.unsubscribe("thread"); assert.equal(await state.isSubscribed("thread"), false);
});

test("digest stays below Discord's limit even with escaped headlines, includes stable archive links, and suppresses mentions", () => {
  const issue = issueFixture();
  issue.intro[0] = "@everyone `*_[]()<>".repeat(100);
  issue.stories.forEach(story => { story.headline = "@everyone `*_[]()<>".repeat(100); });
  const markdown = renderChatDigest(issue);
  assert.ok(markdown.length < 1900, `digest length ${markdown.length}`);
  assert.ok(!markdown.includes("@everyone"));
  assert.match(markdown, /AI-generated briefing/);
  assert.ok(!markdown.includes("Pause or disconnect"));
  for (const story of issue.stories.slice(0, 6)) assert.ok(markdown.includes(`/archive/daily/${issue.date}#${story.id}`));
  assert.ok(!markdown.includes(issue.stories[6].id));
});

test("Telegram digest uses regular messages with readable paragraph spacing and linked section content", async () => {
  const { registry, service } = chatFixture();
  const destination = activeDestination(registry, candidate("telegram", "123"));
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = new URL(String(url)).pathname.split("/").at(-1);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 100000, is_bot: true, username: "ForwardPassTestBot", first_name: "Forward Pass" } });
    const body = JSON.parse(options.body);
    requests.push({ method, body });
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 42, date: 1, chat: { id: 123, type: "private" }, text: body.text } });
    throw new Error(`Unexpected Telegram method ${method}`);
  };
  try {
    const issue = issueFixture();
    await postChatDigest(service, destination, renderChatDigest(issue));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "sendMessage");
    assert.equal(requests[0].body.parse_mode, "MarkdownV2");
    assert.match(requests[0].body.text, /\n\n\*Top stories\*\n\n/);
    assert.match(requests[0].body.text, /\n\n\*Quick signals\*\n\n/);
    assert.ok(requests[0].body.text.includes(`#${issue.stories[0].id}`));
    assert.ok(!requests[0].body.text.includes("Pause or disconnect"));
  } finally { globalThis.fetch = originalFetch; }
});

test("a sent issue is claimed once and uncertain sends never blindly repeat", async () => {
  const { registry, service } = chatFixture(); const issue = issueFixture();
  const destination = activeDestination(registry);
  let count = 0;
  const send = async () => { count++; return "message-1"; };
  const results = await Promise.all([sendChatIssue(service, issue, destination, send), sendChatIssue(service, issue, destination, send)]);
  assert.equal(count, 1); assert.ok(results.some(result => result.outcome === "sent"));
  assert.equal((await sendChatIssue(service, issue, destination, send)).outcome, "alreadySent");
  const uncertain = activeDestination(registry, candidate("telegram", "uncertain"));
  let uncertainCalls = 0;
  const timeout = async () => { uncertainCalls++; throw new Error("Connection lost after write"); };
  assert.equal((await sendChatIssue(service, issue, uncertain, timeout)).outcome, "needsReconciliation");
  assert.equal((await sendChatIssue(service, issue, uncertain, timeout)).outcome, "needsReconciliation");
  assert.equal(uncertainCalls, 1);
});

test("safe provider rate rejections retry while lost permissions disconnect the destination", async () => {
  const { registry, service } = chatFixture(); const issue = issueFixture();
  const destination = activeDestination(registry);
  const limited = await sendChatIssue(service, issue, destination, async () => { throw new AdapterRateLimitError("telegram", 7); });
  assert.deepEqual(limited, { outcome: "retryable", retryAfterMs: 7000 });
  assert.equal((await sendChatIssue(service, issue, destination, async () => "success")).outcome, "sent");
  const blocked = activeDestination(registry, candidate("telegram", "blocked"));
  assert.equal((await sendChatIssue(service, issue, blocked, async () => { throw new PermissionError("telegram", "sendMessage"); })).outcome, "failed");
  assert.equal(registry.destination(blocked.id).status, "disconnected");
});

test("native Slack rate errors and Discord API status errors retain safe retry semantics", async () => {
  const { registry, service } = chatFixture(); const issue = issueFixture();
  const slack = activeDestination(registry, candidate("slack"));
  const slackError = Object.assign(new Error("Limited"), { code: "slack_webapi_rate_limited_error", retryAfter: 4 });
  assert.equal((await sendChatIssue(service, issue, slack, async () => { throw slackError; })).retryAfterMs, 4000);
  const discord = activeDestination(registry, candidate("discord"));
  const native = Object.assign(new Error('{"retry_after":2.5}'), { name: "DiscordApiError", status: 429 });
  const error = new NetworkError("discord", "Rejected", native);
  assert.equal((await sendChatIssue(service, issue, discord, async () => { throw error; })).retryAfterMs, 2500);
  const ambiguous = activeDestination(registry, candidate("slack", "ambiguous"));
  const internal = Object.assign(new Error("Unknown result"), { code: "slack_webapi_platform_error", data: { error: "internal_error" } });
  assert.equal((await sendChatIssue(service, issue, ambiguous, async () => { throw internal; })).outcome, "needsReconciliation");
});

test("published delivery paginates, honors pauses after the snapshot, and replays without duplicate sends", async () => {
  const { registry, service } = chatFixture(); const issue = issueFixture();
  const store = memoryStore({ [`issues/${issue.date}.json`]: issue, [`published/daily/${issue.date}.json`]: { version: 2, kind: "daily", date: issue.date, publishedAt: issue.createdAt } });
  useStore(store);
  for (let index = 0; index < 105; index++) activeDestination(registry, candidate("telegram", String(index)), `reader${index}@example.com`);
  const paused = registry.audience("telegram")[0];
  const cache = new Map();
  const steps = { async run(name, _config, callback) {
    if (cache.has(name)) return cache.get(name);
    const value = await callback(); cache.set(name, value);
    if (name === "audience-0") registry.update(paused.owner, paused.id, "paused");
    return value;
  }, async sleep() {} };
  const calls = new Set();
  const send = async destination => { assert.ok(!calls.has(destination.id)); calls.add(destination.id); return `message-${destination.id}`; };
  const result = await deliverChatIssue(steps, { date: issue.date, platform: "telegram" }, service, send);
  assert.equal(result.sent, 104); assert.equal(result.skipped, 1);
  assert.ok(cache.has("audience-1"));
  assert.deepEqual(await deliverChatIssue(steps, { date: issue.date, platform: "telegram" }, service, send), result);
  assert.equal(calls.size, 104);
  store.objects.delete(`published/daily/${issue.date}.json`);
  await assert.rejects(deliverChatIssue(steps, { date: issue.date, platform: "telegram" }, service, send), /published/);
});

function settingsRequest(body, token, origin = configured.PUBLIC_SITE_URL) {
  return new Request("https://engine.example.com/chat-settings", { method: body ? "POST" : "GET", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const readerToken = email => new URL(preferencesLink(email)).hash.slice("#token=".length);

test("a targeted delivery sends only the selected inbox, shares the edition ledger, and preserves platform totals", async () => {
  const { registry, service } = chatFixture();
  const issue = issueFixture();
  const aggregate = { sent: 123 };
  const store = memoryStore({ [`issues/${issue.date}.json`]: issue, [`published/daily/${issue.date}.json`]: { version: 2, kind: "daily", date: issue.date, publishedAt: issue.createdAt }, [`delivery/${issue.date}/chat/telegram.json`]: aggregate });
  useStore(store);
  const selected = activeDestination(registry, candidate("telegram", "selected"));
  const other = activeDestination(registry, candidate("telegram", "other"), "other@example.com");
  const steps = { async run(name, config, callback) { return callback(); }, async sleep() {} };
  const sent = [];
  const send = async destination => { sent.push(destination.id); return "provider-message"; };
  const job = { date: issue.date, platform: "telegram", destinationId: selected.id };
  assert.equal((await deliverChatIssue(steps, job, service, send)).sent, 1);
  assert.deepEqual(sent, [selected.id]);
  assert.deepEqual(JSON.parse(store.objects.get(`delivery/${issue.date}/chat/telegram.json`)), aggregate);
  assert.equal((await deliverChatIssue(steps, job, service, send)).alreadySent, 1);
  assert.deepEqual(sent, [selected.id]);
  registry.update(other.owner, other.id, "paused");
  assert.equal((await deliverChatIssue(steps, { ...job, destinationId: other.id }, service, send)).skipped, 1);
  await assert.rejects(deliverChatIssue(steps, { ...job, platform: "discord" }, service, send), /Destination unavailable/);
});

test("settings enforce signed reader identity, origin, ownership, and hide destination credentials", async () => {
  const { registry, service } = chatFixture(); const origin = "https://engine.example.com";
  assert.equal((await handleChatSettings(settingsRequest(null, null), service, origin)).status, 401);
  const token = readerToken("reader@example.com");
  assert.equal((await handleChatSettings(settingsRequest(null, token, "https://evil.example.com"), service, origin)).status, 403);
  const destination = activeDestination(registry);
  const response = await handleChatSettings(settingsRequest(null, token), service, origin);
  const text = await response.text();
  assert.ok(text.includes(destination.id)); assert.ok(!text.includes("reader@example.com")); assert.ok(!text.includes('"target"')); assert.ok(!text.includes('"actor"'));
  const other = readerToken("other@example.com");
  assert.equal((await handleChatSettings(settingsRequest({ action: "update", id: destination.id, status: "paused" }, other), service, origin)).status, 404);
  assert.equal(registry.destination(destination.id).status, "active");
  assert.equal((await handleChatSettings(settingsRequest({ action: "bogus" }, token), service, origin)).status, 400);
  const unavailable = { ...service, list: async () => { throw new Error("Unavailable"); } };
  assert.equal((await handleChatSettings(settingsRequest(null, token), unavailable, origin)).status, 503);
});

test("provider links use private Telegram Start, group Start, Discord bot DM, and one-use OAuth state", async () => {
  const { service } = chatFixture(); const origin = "https://engine.example.com"; const token = readerToken("reader@example.com");
  for (const mode of ["personal", "shared"]) {
    const response = await handleChatSettings(settingsRequest({ action: "connect", platform: "telegram", mode }, token), service, origin);
    const connection = await response.json();
    assert.equal(new URL(connection.url).searchParams.get(mode === "personal" ? "start" : "startgroup"), connection.token);
  }
  const dm = await (await handleChatSettings(settingsRequest({ action: "connect", platform: "discord", mode: "personal" }, token), service, origin)).json();
  assert.equal(dm.url, `https://discord.com/users/${configured.DISCORD_APPLICATION_ID}`);
  const install = await (await handleChatSettings(settingsRequest({ action: "install-slack" }, token), service, origin)).json();
  const state = new URL(install.url).searchParams.get("state");
  assert.equal((await handleSlackOAuth(new Request(`${origin}/chat/oauth/slack?state=${state}&error=access_denied`), service, origin)).status, 400);
  assert.equal(await service.getValue(`oauth-slack:${state}`), null);
  assert.equal((await handleSlackOAuth(new Request(`${origin}/chat/oauth/slack?state=${state}&code=never-exchange`), service, origin)).status, 400);
});

test("Slack OAuth uses Worker-compatible fetch, stores encrypted tokens, and rejects callback replay", async () => {
  const { service } = chatFixture();
  const origin = "https://engine.example.com";
  const install = await (await handleChatSettings(settingsRequest({ action: "install-slack" }, readerToken("reader@example.com")), service, origin)).json();
  const state = new URL(install.url).searchParams.get("state");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async request => {
    assert.ok(request instanceof Request);
    assert.equal(request.cache, "no-store", "Workers rejects Axios's default cache mode");
    calls.push(request.url);
    const body = new URLSearchParams(await request.text());
    assert.equal(request.url, "https://slack.com/api/oauth.v2.access");
    assert.equal(body.get("redirect_uri"), `${origin}/chat/oauth/slack`);
    assert.equal(body.get("code"), "test-only-authorization-code");
    return Response.json({ ok: true, access_token: "xoxb-test-only-installation", bot_user_id: "U123", team: { id: "T123", name: "Test workspace" } });
  };
  try {
    const callback = new Request(`${origin}/chat/oauth/slack?state=${state}&code=test-only-authorization-code`);
    const response = await handleSlackOAuth(callback, service, origin);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "https://theforwardpass.net/preferences#delivery");
    const stored = await service.getValue("slack:installation:T123");
    assert.equal(typeof stored.botToken, "object");
    assert.ok(!JSON.stringify(stored).includes("xoxb-test-only-installation"));
    const adapter = slackAdapter();
    await new Chat({ userName: "forwardpass", adapters: { slack: adapter }, state: chatState(service), logger: "silent" }).initialize();
    assert.equal((await adapter.getInstallation("T123")).botToken, "xoxb-test-only-installation");
    assert.equal((await handleSlackOAuth(callback, service, origin)).status, 400);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord shared subscriptions require signed member permissions", () => {
  assert.equal(discordCanManage({ guild_id: "guild", channel_id: "channel", member: { permissions: "16" } }), true);
  assert.equal(discordCanManage({ channel_id: "channel", member: { permissions: "1024" } }), false);
  assert.equal(discordCanManage({ channel_id: "channel", member: { permissions: "not-an-integer" } }), false);
});

test("SDK webhooks reject forged Slack signatures and Telegram secrets before linking", async () => {
  const { registry, service } = chatFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/getMe")) return Response.json({ ok: true, result: { id: 100000, is_bot: true, first_name: "Forward Pass", username: configured.TELEGRAM_BOT_USERNAME } });
    throw new Error("Unexpected provider request");
  };
  try {
    const telegram = createChatRuntime(service, "telegram");
    const body = JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "Reader" }, text: "/start forged" } });
    const response = await telegram.webhooks.telegram(new Request("https://engine.example.com/chat/webhooks/telegram", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "forged" }, body }));
    assert.ok(response.status >= 400);
    const slack = createChatRuntime(service, "slack");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slackBody = "command=%2Fforwardpass&text=forged&team_id=T1&channel_id=C1&user_id=U1";
    const signature = createHmac("sha256", "wrong-secret").update(`v0:${timestamp}:${slackBody}`).digest("hex");
    const forged = await slack.webhooks.slack(new Request("https://engine.example.com/chat/webhooks/slack", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": `v0=${signature}` }, body: slackBody }));
    assert.ok(forged.status >= 400); assert.equal(registry.list("reader@example.com").length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("verified Telegram Start links both private inboxes and administrator-owned group topics", async () => {
  const { registry, service } = chatFixture();
  const originalFetch = globalThis.fetch; const replies = [];
  let administrator = true;
  globalThis.fetch = async (url, options) => {
    const method = new URL(String(url)).pathname.split("/").at(-1);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 100000, is_bot: true, first_name: "Forward Pass", username: configured.TELEGRAM_BOT_USERNAME } });
    if (method === "getChatMember") return Response.json({ ok: true, result: { status: administrator ? "administrator" : "member" } });
    if (method === "sendMessage") { replies.push(JSON.parse(options.body)); return Response.json({ ok: true, result: { message_id: replies.length, date: 1, chat: { id: 7, type: "private" } } }); }
    throw new Error(`Unexpected Telegram method ${method}`);
  };
  try {
    let updateId = 100;
    async function start(mode, id, topic) {
      const link = registry.createLink("reader@example.com", "telegram", mode);
      const text = `/start ${link.token}`;
      const update = { update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id, type: mode === "personal" ? "private" : "supergroup", title: mode === "shared" ? "AI team" : undefined }, from: { id: 7, is_bot: false, first_name: "Reader" }, text, entities: [{ type: "bot_command", offset: 0, length: 6 }], ...(topic ? { message_thread_id: topic } : {}) } };
      const tasks = [];
      const bot = createChatRuntime(service, "telegram");
      const response = await bot.webhooks.telegram(new Request("https://engine.example.com/chat/webhooks/telegram", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": configured.TELEGRAM_WEBHOOK_SECRET_TOKEN }, body: JSON.stringify(update) }), { waitUntil: task => tasks.push(task) });
      await Promise.all(tasks); assert.equal(response.status, 200);
    }
    await start("personal", 7);
    await start("shared", -100123, 42);
    const destinations = registry.list("reader@example.com");
    assert.equal(destinations.length, 2); assert.ok(destinations.every(item => item.status === "pending"));
    assert.ok(destinations.some(item => item.target === "telegram:-100123:42" && item.label.includes("topic 42")));
    administrator = false; await start("shared", -100456);
    assert.equal(registry.list("reader@example.com").length, 2);
    assert.match(replies.at(-1).text, /administrator/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord HTTP interactions require a valid Ed25519 signature and can attach a managed channel", async () => {
  const { registry, service } = chatFixture();
  const keys = generateKeyPairSync("ed25519");
  process.env.DISCORD_PUBLIC_KEY = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const originalFetch = globalThis.fetch; const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    if (String(url).endsWith("/users/@me")) return Response.json({ id: configured.DISCORD_APPLICATION_ID, username: "Forward Pass", bot: true });
    if (String(url).includes("/webhooks/")) return Response.json({ id: "reply", channel_id: "300000000000000000", content: "Connected" });
    throw new Error(`Unexpected Discord request ${String(url)}`);
  };
  try {
    const { token } = registry.createLink("reader@example.com", "discord", "shared");
    const body = JSON.stringify({ id: "500000000000000000", application_id: configured.DISCORD_APPLICATION_ID, type: 2, token: "test-only-interaction", version: 1,
      guild_id: "200000000000000000", channel_id: "300000000000000000", channel: { id: "300000000000000000", type: 0 },
      member: { permissions: "16", user: { id: "400000000000000000", username: "reader" } },
      data: { id: "600000000000000000", name: "forwardpass", type: 1, options: [{ name: "code", type: 3, value: token }] } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex");
    const tasks = [];
    const bot = createChatRuntime(service, "discord");
    const response = await bot.webhooks.discord(new Request("https://engine.example.com/chat/webhooks/discord", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": signature }, body }), { waitUntil: task => tasks.push(task) });
    await Promise.all(tasks);
    assert.equal(response.status, 200);
    const destination = registry.list("reader@example.com")[0];
    assert.equal(destination?.status, "pending"); assert.equal(destination?.target, "discord:200000000000000000:300000000000000000");
    const denied = await bot.webhooks.discord(new Request("https://engine.example.com/chat/webhooks/discord", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": "00".repeat(64) }, body }));
    assert.equal(denied.status, 401);
    assert.ok(requests.some(url => url.includes("/webhooks/")));
  } finally { globalThis.fetch = originalFetch; }
});

test("a user-installed Discord command can connect a personal bot DM without guild metadata", async () => {
  const { registry, service } = chatFixture();
  const keys = generateKeyPairSync("ed25519");
  process.env.DISCORD_PUBLIC_KEY = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const originalFetch = globalThis.fetch;
  const requests = [];
  const actor = "400000000000000000";
  const channel = "300000000000000000";
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    if (path.endsWith("/users/@me")) return Response.json({ id: configured.DISCORD_APPLICATION_ID, username: "Forward Pass", bot: true });
    if (path.endsWith("/users/@me/channels")) return Response.json({ id: channel, type: 1, recipients: [{ id: actor, username: "reader" }] });
    if (path.includes("/webhooks/")) return Response.json({ id: "reply", channel_id: channel, content: "Connected" });
    throw new Error(`Unexpected Discord request ${path}`);
  };
  try {
    const { token } = registry.createLink("reader@example.com", "discord", "personal");
    const body = JSON.stringify({ id: "500000000000000000", application_id: configured.DISCORD_APPLICATION_ID, type: 2, token: "test-only-interaction", version: 1,
      context: 1, authorizing_integration_owners: { "1": actor }, channel_id: channel, channel: { id: channel, type: 1 }, user: { id: actor, username: "reader" },
      data: { id: "600000000000000000", name: "forwardpass", type: 1, options: [{ name: "code", type: 3, value: token }] } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex");
    const tasks = [];
    const bot = createChatRuntime(service, "discord");
    const response = await bot.webhooks.discord(new Request("https://engine.example.com/chat/webhooks/discord", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": signature }, body }), { waitUntil: task => tasks.push(task) });
    await Promise.all(tasks);
    assert.equal(response.status, 200);
    const destination = registry.list("reader@example.com")[0];
    assert.equal(destination?.mode, "personal");
    assert.equal(destination?.actor, actor);
    assert.equal(destination?.installation, null);
    assert.equal(destination?.target, `discord:@me:${channel}`);
    assert.equal(destination?.status, "pending");
    assert.equal(registry.audience("discord").length, 0);
    assert.ok(requests.some(request => request.path.endsWith("/users/@me/channels") && request.body.recipient_id === actor));
  } finally { globalThis.fetch = originalFetch; }
});

test("Slack installations encrypt bot tokens and concurrent workspaces keep their own token context", async () => {
  const { registry, service } = chatFixture();
  const adapter = slackAdapter();
  const bot = new Chat({ userName: "forwardpass", adapters: { slack: adapter }, state: chatState(service), logger: "silent" });
  await bot.initialize();
  await adapter.setInstallation("TONE", { botToken: "test-only-workspace-one", botUserId: "UONE" });
  await adapter.setInstallation("TTWO", { botToken: "test-only-workspace-two", botUserId: "UTWO" });
  const stored = JSON.stringify(registry.get("sdk:slack:installation:TONE"));
  assert.ok(!stored.includes("test-only-workspace-one"));
  assert.equal((await adapter.getInstallation("TONE")).botToken, "test-only-workspace-one");
  const tokens = await Promise.all(["TONE", "TTWO"].map(async installationId => {
    const installation = await adapter.getInstallation(installationId);
    return adapter.withBotToken(installation.botToken, async () => { await Promise.resolve(); return adapter.webClient.token; }, { installationId });
  }));
  assert.deepEqual(tokens, ["test-only-workspace-one", "test-only-workspace-two"]);
  assert.throws(() => adapter.webClient, /No bot token/);
});

test("Teams destination ownership follows the tenant and conversation when the service URL moves", () => {
  const first = { ...candidate("teams"), installation: "tenant", target: "teams:Y29udmVyc2F0aW9u:c2VydmljZS1vbmU" };
  const moved = { ...first, target: "teams:Y29udmVyc2F0aW9u:c2VydmljZS10d28" };
  assert.equal(destinationId(first), destinationId(moved));
  assert.notEqual(destinationId(first), destinationId({ ...first, installation: "another-tenant" }));
});
