import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { createHmac } from "node:crypto";
import { handleSlackMcp } from "../src/api/slack-mcp.ts";
import { agentCreditAccountId } from "../src/lib/agent-credits.ts";
import { memoryStore, useStore } from "../src/lib/private-store.ts";
import { memoryCredits } from "./agent-credit-test-support.mjs";
import { chatFixture, activeDestination, configured } from "./chat-test-support.mjs";

beforeEach(() => { Object.assign(process.env, configured); useStore(memoryStore()); });
const caller = { user_id: "U123", team_id: "T123", enterprise_id: null };
const tool = (slack = caller) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_updates", arguments: { query: "missing" }, _meta: { slack } } });
const request = (value, seconds = Math.floor(Date.now() / 1000)) => {
  const body = JSON.stringify(value);
  return new Request("https://engine.example.com/chat/mcp/slack", { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
    "X-Slack-Request-Timestamp": String(seconds),
    "X-Slack-Signature": `v0=${createHmac("sha256", configured.SLACK_SIGNING_SECRET).update(`v0:${seconds}:${body}`).digest("hex")}`,
  }, body });
};
const contact = (plan = "personal", status = "active") => ({ contacts: { get: async () => ({ data: { properties: {
  personal_plan: { value: plan }, personal_status: { value: status }, interests: { value: "agents" },
} }, error: null }) } });
const connect = (registry, owner = "reader@example.test", overrides = {}) => activeDestination(registry, {
  platform: "slack", mode: "personal", installation: "T123", actor: "U123", target: "slack:D123:", label: "Personal Slack", ...overrides,
}, owner);
const install = service => service.setValue("slack:installation:T123", { botToken: "xoxb-test-only", botUserId: "U456" });

test("Slack MCP rejects forged and stale signatures before trusting caller metadata", async () => {
  const { service } = chatFixture();
  const forged = request(tool());
  forged.headers.set("X-Slack-Signature", `v0=${"0".repeat(64)}`);
  assert.equal((await handleSlackMcp(forged, service)).status, 401);
  assert.equal((await handleSlackMcp(request(tool(), Math.floor(Date.now() / 1000) - 301), service)).status, 401);
  const modified = request(tool());
  const body = JSON.stringify(tool({ ...caller, user_id: "U999" }));
  assert.equal((await handleSlackMcp(new Request(modified, { body }), service)).status, 401);
});

test("signed setup discovers tools without an account or consuming credits", async () => {
  const { service } = chatFixture();
  const response = await handleSlackMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), service);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /get_updates/);
  assert.match(text, /search_coverage/);
  assert.match(text, /get_story/);
  assert.ok(!text.includes('"name":"code"'));
  assert.equal((await handleSlackMcp(request({ ...tool(), params: { name: "get_updates", arguments: {} } }), service)).status, 401);
});

test("shared and pending destinations cannot grant coverage access, nor can another workspace or user", async () => {
  const { registry, service } = chatFixture();
  await install(service);
  connect(registry, "owner@example.test", { mode: "shared", target: "slack:C123:" });
  assert.equal((await handleSlackMcp(request(tool()), service)).status, 403);
  const pending = registry.createLink("reader@example.test", "slack", "personal");
  registry.attach(pending.token, { platform: "slack", mode: "personal", installation: "T123", actor: "U123", target: "slack:D123:", label: "Inbox" });
  assert.equal((await handleSlackMcp(request(tool()), service)).status, 403);
  const personal = registry.list("reader@example.test")[0];
  registry.update("reader@example.test", personal.id, "active");
  assert.equal((await handleSlackMcp(request(tool({ ...caller, user_id: "U999" })), service)).status, 403);
  assert.equal((await handleSlackMcp(request(tool({ ...caller, team_id: "T999" })), service)).status, 403);
});

test("confirmed caller uses only their own plan and credits; pause preserves account link and disconnect revokes it", async () => {
  const { registry, service } = chatFixture();
  await install(service);
  const destination = connect(registry);
  const credits = memoryCredits();
  const options = { credits, resend: contact() };
  const ledger = credits(agentCreditAccountId("reader@example.test"));
  assert.equal((await handleSlackMcp(request(tool()), service, options)).status, 200);
  assert.equal((await ledger.status("personal")).available, 499);
  assert.equal((await credits(agentCreditAccountId("other@example.test")).status("personal")).available, 500);
  registry.update("reader@example.test", destination.id, "paused");
  assert.equal((await handleSlackMcp(request(tool()), service, options)).status, 200);
  assert.equal((await ledger.status("personal")).available, 498);
  registry.update("reader@example.test", destination.id, "disconnected");
  assert.equal((await handleSlackMcp(request(tool()), service, options)).status, 403);
  assert.equal((await ledger.status("personal")).available, 498);
});

test("revoked plans, missing installations, ambiguous account bindings and rate limits fail closed", async () => {
  const { registry, service } = chatFixture();
  connect(registry);
  const credits = memoryCredits();
  assert.equal((await handleSlackMcp(request(tool()), service, { credits, resend: contact() })).status, 403);
  await install(service);
  assert.equal((await handleSlackMcp(request(tool()), service, { credits, resend: contact("personal", "revoked") })).status, 403);
  const limited = await handleSlackMcp(request(tool()), service, { credits, resend: contact(), limiter: { limit: async () => ({ success: false }) } });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "60");
  connect(registry, "another@example.test", { target: "slack:D456:" });
  assert.equal((await handleSlackMcp(request(tool()), service, { credits, resend: contact() })).status, 403);
});
