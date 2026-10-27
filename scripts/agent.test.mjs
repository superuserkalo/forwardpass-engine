import { memoryCredits } from "./agent-credit-test-support.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleAgentAccess, handleAgentMcp } from "../src/api/agent.ts";
import { createAgentKey, agentKeyOwner, revokeAgentKey } from "../src/lib/agent-access.ts";
import { agentCreditAccountId } from "../src/lib/agent-credits.ts";
import { coverageQuerySchema, getCoverageStory, queryCoverage } from "../src/lib/agent-coverage.ts";
import { preferencesLink } from "../src/lib/preference-link.ts";
import { memoryStore, useStore } from "../src/lib/private-store.ts";

process.env.PREFERENCES_SIGNING_SECRET = "agent-tests-only-secret".repeat(3);
process.env.PUBLIC_SITE_URL = "https://site.example";
const credits = memoryCredits();
const NOW = new Date("2026-10-03T12:00:00Z");
const contact = (plan = "professional", status = "active", interests = "agents", trialEndsAt) => ({ contacts: { get: async ({ email }) => ({
  data: { email, properties: { personal_status: { value: status }, personal_plan: { value: plan }, personal_trial_ends_at: { value: trialEndsAt }, interests: { value: interests } } }, error: null,
}) } });
const humanToken = (email = "pro@example.test") => new URLSearchParams(new URL(preferencesLink(email)).hash.slice(1)).get("token");
const management = (method, token = humanToken(), origin) => new Request("https://worker.example/agent-access", { method, headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } });
const rpc = (token, body, extra = {}) => new Request("https://worker.example/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra }, body: JSON.stringify(body) });

function story(id, headline, url, topics = ["Agents"]) {
  return { id, headline, url, topics, role: "featured", position: 0, label: "Release", type: "news", body: `A sourced change relevant to ${topics.join(" and ").toLowerCase()}.`, sources: [{ label: "Original source", url }], traction: null, project: null, publishedAt: "2026-10-01T12:00:00Z", facts: [] };
}
function issue(date, stories) {
  return { version: 2, date, createdAt: `${date}T06:00:00Z`, subject: "Issue", preview: "Preview", intro: ["One", "Two", "Three"], stories, markdown: "# Issue", pipeline: { candidates: 1, clusters: 1, shortlisted: 1, kept: 1, models: {}, usage: [], checks: {} } };
}
function published(date, stories) {
  return { [`issues/${date}.json`]: issue(date, stories), [`published/daily/${date}.json`]: { version: 2, kind: "daily", date, publishedAt: `${date}T07:00:00Z` } };
}
const seed = () => ({
  ...published("2026-10-02", [story("s-0123456789abcdef", "Agent SDK release", "https://source.example/sdk")]),
  ...published("2026-10-01", [story("s-fedcba9876543210", "Agent SDK repost", "https://source.example/sdk"), story("s-aaaaaaaaaaaaaaaa", "Retrieval research", "https://source.example/retrieval", ["Retrieval"])]),
  "issues/2026-10-03.json": issue("2026-10-03", [story("s-bbbbbbbbbbbbbbbb", "Unpublished secret", "https://secret.example")]),
  ...published("2026-10-04", [story("s-cccccccccccccccc", "Future secret", "https://future.example")]),
});

test("agent keys are hashed, rotate atomically, revoke, and never act as human sessions", async () => {
  const store = memoryStore(); useStore(store);
  const first = await createAgentKey("pro@example.test");
  assert.equal(await agentKeyOwner(first.token), "pro@example.test");
  assert.ok(![...store.objects.values()].join().includes(first.token));
  assert.equal(await agentKeyOwner(`${first.token}x`), null);
  assert.equal((await handleAgentAccess(management("POST", first.token), { credits, resend: contact() })).status, 401);
  const second = await createAgentKey("pro@example.test");
  assert.equal(await agentKeyOwner(first.token), null);
  assert.equal(await agentKeyOwner(second.token), "pro@example.test");
  assert.equal(store.objects.size, 1);
  const mixedCase = await createAgentKey("PRO@example.test");
  assert.equal(store.objects.size, 1);
  assert.equal(await agentKeyOwner(second.token), null);
  assert.equal(await agentKeyOwner(mixedCase.token), "PRO@example.test");
  await revokeAgentKey("pro@example.test");
  assert.equal(await agentKeyOwner(mixedCase.token), null);
});

test("active Personal and Professional readers can create keys, and only for their own account", async () => {
  useStore(memoryStore());
  for (const [plan, status] of [["free", "active"], ["professional", "trial"], ["professional", "revoked"], ["free", "active"]]) {
    assert.equal((await handleAgentAccess(management("POST"), { credits, resend: contact(plan, status) })).status, 403);
  }
  assert.equal((await handleAgentAccess(management("POST", humanToken(), "https://evil.example"), { credits, resend: contact() })).status, 403);
  const response = await handleAgentAccess(management("POST"), { credits, resend: contact() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const key = await response.json();
  assert.equal(await agentKeyOwner(key.token), "pro@example.test");
  const another = await handleAgentAccess(management("GET", humanToken("other@example.test")), { credits, resend: contact() });
  assert.equal((await another.json()).createdAt, null);
  const personal = await handleAgentAccess(management("POST", humanToken("personal@example.test")), { credits, resend: contact("personal") });
  assert.equal(personal.status, 200);
  assert.equal((await personal.json()).credits.monthlyAllowance, 500);
  await handleAgentAccess(management("DELETE"), { credits, resend: contact("personal") });
  assert.equal(await agentKeyOwner(key.token), null);
});

test("MCP fails closed for preferences tokens, revoked subscriptions and subscriber outages", async () => {
  useStore(memoryStore());
  const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
  assert.equal((await handleAgentMcp(rpc(humanToken(), body), { credits, resend: contact() })).status, 401);
  const { token } = await createAgentKey("pro@example.test");
  assert.equal((await handleAgentMcp(rpc(token, body), { credits, resend: contact("professional", "revoked") })).status, 403);
  const down = { contacts: { get: async () => ({ data: null, error: { name: "rate_limit_exceeded" } }) } };
  assert.equal((await handleAgentMcp(rpc(token, body), { credits, resend: down })).status, 503);
  assert.equal((await handleAgentMcp(rpc(token, body, { origin: "null" }), { credits, resend: contact() })).status, 403);
  const limited = await handleAgentMcp(rpc(token, body), { credits, resend: contact(), limiter: { limit: async () => ({ success: false }) } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal((await handleAgentMcp(rpc(token, "x".repeat(17_000)), { credits, resend: contact() })).status, 400);
});

test("coverage filters, deduplicates and excludes unpublished, future and old stories", async () => {
  useStore(memoryStore(seed()));
  const updates = await queryCoverage(coverageQuerySchema.parse({}), "agents", NOW);
  assert.deepEqual(updates.stories.map((s) => s.headline), ["Agent SDK release"]);
  assert.equal(updates.updated_at, "2026-10-02T07:00:00Z");
  const retrieval = await queryCoverage(coverageQuerySchema.parse({ topic: "Retrieval" }), "", NOW);
  assert.equal(retrieval.stories[0].headline, "Retrieval research");
  assert.equal(retrieval.stories[0].source_url, "https://source.example/retrieval");
  assert.equal((await queryCoverage(coverageQuerySchema.parse({ since: "2026-10-02T07:00:00Z" }), "", NOW)).stories.length, 0);
  assert.equal((await queryCoverage(coverageQuerySchema.parse({ query: "nonexistent" }), "", NOW)).stories.length, 0);
  const first = await queryCoverage(coverageQuerySchema.parse({ query: "", limit: 1 }), "", NOW);
  assert.equal(first.next_offset, 1);
  const second = await queryCoverage(coverageQuerySchema.parse({ query: "", limit: 1, offset: first.next_offset }), "", NOW);
  assert.notEqual(first.stories[0].id, second.stories[0].id);
  assert.equal(await getCoverageStory("daily:2026-10-03:s-bbbbbbbbbbbbbbbb", NOW), null);
  assert.equal(await getCoverageStory("daily:2026-10-04:s-cccccccccccccccc", NOW), null);
  assert.equal(await getCoverageStory("daily:2020-01-01:s-cccccccccccccccc", NOW), null);
  assert.equal(await getCoverageStory("daily:2026-99-99:s-cccccccccccccccc", NOW), null);
  assert.ok(coverageQuerySchema.safeParse({ limit: 1000 }).success === false);
});

test("coverage scan is bounded and exposes a cursor to older editions", async () => {
  const objects = {};
  for (let index = 0; index < 35; index++) {
    const date = new Date(NOW.getTime() - (index + 1) * 86_400_000).toISOString().slice(0, 10);
    Object.assign(objects, published(date, [story(`s-${index.toString(16).padStart(16, "0")}`, `Agent ${index}`, `https://source.example/${index}`)]));
  }
  useStore(memoryStore(objects));
  const first = await queryCoverage(coverageQuerySchema.parse({}), "", NOW);
  assert.equal(first.scanned_editions, 31);
  assert.equal(first.stories.length, 10);
  const older = await queryCoverage(coverageQuerySchema.parse({ before: first.next_before }), "", NOW);
  assert.equal(older.scanned_editions, 4);
  assert.equal(older.next_before, null);
});

test("Personal coverage cannot retrieve Professional-only archive stories through search or shared cache", async () => {
  useStore(memoryStore(published("2025-05-01", [story("s-aaaaaaaaaaaaaaaa", "Older SDK", "https://source.example/old")])));
  const entries = new Map();
  const cache = { match: async (request) => entries.get(request.url)?.clone(), put: async (request, response) => { entries.set(request.url, response.clone()); } };
  const pro = await queryCoverage(coverageQuerySchema.parse({}), "", NOW, cache, "professional");
  assert.equal(pro.stories.length, 1);
  assert.equal((await queryCoverage(coverageQuerySchema.parse({}), "", NOW, cache, "personal")).stories.length, 0);
  assert.equal(await getCoverageStory(pro.stories[0].id, NOW, cache, "personal"), null);
});

test("MCP charges only successful tool calls and reports exhausted balances without spending or exposing paid results", async () => {
  const credits = memoryCredits();
  useStore(memoryStore(seed()));
  const email = "personal@example.test";
  const { token } = await createAgentKey(email);
  const ledger = credits(agentCreditAccountId(email));
  const originalFetch = globalThis.fetch;
  const client = new Client({ name: "credit-test", version: "1" });
  globalThis.fetch = async (input, init) => handleAgentMcp(input instanceof Request ? input : new Request(input, init), { credits, resend: contact("personal") });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://worker.example/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    await client.listTools();
    assert.equal((await ledger.status("personal")).available, 500);
    const missing = await client.callTool({ name: "get_story", arguments: { id: "daily:2026-10-03:s-bbbbbbbbbbbbbbbb" } });
    assert.equal(missing.isError, true);
    assert.equal((await ledger.status("personal")).available, 500);
    const invalid = await client.callTool({ name: "get_updates", arguments: { limit: 10000 } });
    assert.equal(invalid.isError, true);
    assert.equal((await ledger.status("personal")).available, 500);
    const success = await client.callTool({ name: "get_updates", arguments: { query: "nonexistent" } });
    assert.ok(!success.isError);
    assert.equal((await ledger.status("personal")).available, 499);
    for (let i = 0; i < 499; i++) { const pending = await ledger.reserve("personal"); await ledger.settle(pending.reservation, true); }
    const exhausted = await client.callTool({ name: "get_updates", arguments: {} });
    assert.equal(exhausted.isError, true);
    assert.equal(JSON.parse(exhausted.content[0].text).error, "insufficient_credits");
    assert.equal((await ledger.status("personal")).available, 0);
  } finally { await client.close(); globalThis.fetch = originalFetch; }
});

test("immutable published coverage shares cache entries between different readers and searches", async () => {
  const store = memoryStore(seed());
  let reads = 0;
  useStore({ ...store, get: async (key) => { reads++; return store.get(key); } });
  const entries = new Map();
  const cache = { match: async (request) => entries.get(request.url)?.clone(), put: async (request, response) => { entries.set(request.url, response.clone()); } };
  await queryCoverage(coverageQuerySchema.parse({ query: "sdk" }), "", NOW, cache);
  const coldReads = reads;
  const second = await queryCoverage(coverageQuerySchema.parse({ query: "retrieval" }), "", NOW, cache);
  assert.equal(reads, coldReads);
  assert.equal(second.stories[0].headline, "Retrieval research");
  const detail = await getCoverageStory(second.stories[0].id, NOW, cache);
  assert.equal(reads, coldReads);
  assert.ok(detail.body);
  for (const entry of entries.values()) assert.equal(entry.headers.get("cache-control"), "max-age=300");
});

test("using the returned publication checkpoint catches updates hidden by a stale date cache", async () => {
  const store = memoryStore(published("2026-10-01", [story("s-aaaaaaaaaaaaaaaa", "Earlier SDK", "https://source.example/earlier")]));
  useStore(store);
  const entries = new Map();
  const cache = { match: async (request) => entries.get(request.url)?.clone(), put: async (request, response) => { entries.set(request.url, response.clone()); } };
  const first = await queryCoverage(coverageQuerySchema.parse({}), "", NOW, cache);
  for (const [key, value] of Object.entries(published("2026-10-02", [story("s-bbbbbbbbbbbbbbbb", "Later SDK", "https://source.example/later")]))) await store.put(key, JSON.stringify(value));
  const stale = await queryCoverage(coverageQuerySchema.parse({ since: first.updated_at }), "", NOW, cache);
  assert.equal(stale.stories.length, 0);
  assert.equal(stale.updated_at, first.updated_at);
  entries.clear();
  const refreshed = await queryCoverage(coverageQuerySchema.parse({ since: stale.updated_at }), "", NOW, cache);
  assert.equal(refreshed.stories[0].headline, "Later SDK");
});

for (const protocolVersion of ["2026-07-28", "2025-11-25"]) {
  test(`official MCP client connects, lists and calls tools using ${protocolVersion}`, async () => {
    useStore(memoryStore(seed()));
    const { token } = await createAgentKey("pro@example.test");
    const client = new Client({ name: "forward-pass-test", version: "1" }, protocolVersion === "2026-07-28" ? { versionNegotiation: { mode: { pin: protocolVersion } } } : {});
    const transport = new StreamableHTTPClientTransport(new URL("https://worker.example/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => handleAgentMcp(new Request(url, init), { credits, resend: contact() }),
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), ["get_updates", "search_coverage", "get_story"]);
      assert.ok(tools.tools.every((tool) => tool.annotations.readOnlyHint));
      const result = await client.callTool({ name: "search_coverage", arguments: { query: "retrieval" } });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.stories[0].headline, "Retrieval research");
      const detail = await client.callTool({ name: "get_story", arguments: { id: result.structuredContent.stories[0].id } });
      assert.match(detail.structuredContent.body, /sourced change/);
      const invalid = await client.callTool({ name: "get_updates", arguments: { limit: 1000 } });
      assert.equal(invalid.isError, true);
      await revokeAgentKey("pro@example.test");
      await assert.rejects(client.listTools());
    } finally { await client.close(); }
  });
}

for (const protocolVersion of ["2026-07-28", "2025-11-25"]) {
  test(`code mode reuses validated paid coverage and credits with ${protocolVersion}`, async () => {
    const credits = memoryCredits();
    useStore(memoryStore(seed()));
    const email = `code-${protocolVersion}@example.test`;
    const { token } = await createAgentKey(email);
    const ledger = credits(agentCreditAccountId(email));
    let executions = 0;
    const codeExecutor = (account) => {
      assert.equal(account, agentCreditAccountId(email));
      return { execute: async (code, providers) => {
        executions++;
        const tools = providers[0].fns;
        if (code === "invalid") {
          try { await tools.get_updates({ limit: 1000 }); } catch { return { result: null, error: "invalid" }; }
        }
        if (code === "missing") {
          try { await tools.get_story({ id: "daily:2026-10-03:s-bbbbbbbbbbbbbbbb" }); } catch { return { result: null, error: "missing" }; }
        }
        const page = await tools.search_coverage({ query: "retrieval" });
        const story = await tools.get_story({ id: page.stories[0].id });
        return { result: { headline: story.headline }, ...(code === "partial" ? { error: "Script failed afterwards" } : {}) };
      } };
    };
    const client = new Client({ name: "code-test", version: "1" }, protocolVersion === "2026-07-28" ? { versionNegotiation: { mode: { pin: protocolVersion } } } : {});
    const transport = new StreamableHTTPClientTransport(new URL("https://worker.example/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => handleAgentMcp(new Request(url, init), { credits, resend: contact("personal"), codeExecutor }),
    });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["get_updates", "search_coverage", "get_story", "code"]);
      const combined = await client.callTool({ name: "code", arguments: { code: "combined" } });
      assert.equal(combined.structuredContent.result.headline, "Retrieval research");
      assert.equal(combined.structuredContent.credits_used, 2);
      for (const code of ["invalid", "missing"]) {
        const failed = await client.callTool({ name: "code", arguments: { code } });
        assert.equal(failed.isError, true);
        assert.equal(failed.structuredContent.credits_used, 0);
      }
      const partial = await client.callTool({ name: "code", arguments: { code: "partial" } });
      assert.equal(partial.isError, true);
      assert.equal(partial.structuredContent.credits_used, 2);
      assert.equal((await ledger.status("personal")).available, 496);
      for (let i = 0; i < 496; i++) { const held = await ledger.reserve("personal"); await ledger.settle(held.reservation, true); }
      const before = executions;
      const exhausted = await client.callTool({ name: "code", arguments: { code: "combined" } });
      assert.equal(exhausted.isError, true);
      assert.equal(executions, before);
      await revokeAgentKey(email);
      await assert.rejects(client.listTools());
    } finally { await client.close(); }
  });
}

test("Personal trial includes normal MCP and code mode, persists across key rotation and cannot manage billing", async () => {
  useStore(memoryStore(seed()));
  const credits = memoryCredits();
  const end = new Date(Date.now() + 14 * 86400_000).toISOString();
  const resend = contact("personal", "trial", "agents", end);
  const email = "trial@example.test";
  const created = await handleAgentAccess(management("POST", humanToken(email)), { credits, resend });
  assert.equal(created.status, 200);
  const access = await created.json();
  assert.equal(access.credits.available, 500);
  assert.equal(access.credits.trialEndsAt, end);
  assert.equal(access.topUpAvailable, false);
  assert.equal(access.autoRefillAvailable, false);
  assert.equal((await handleAgentAccess(management("PATCH", humanToken(email)), { credits, resend })).status, 403);
  const codeExecutor = () => ({ execute: async (_code, providers) => ({ result: await providers[0].fns.search_coverage({ query: "retrieval" }) }) });
  const client = new Client({ name: "trial-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("https://worker.example/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${access.token}` } },
    fetch: async (url, init) => handleAgentMcp(new Request(url, init), { credits, resend, codeExecutor }),
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 4);
    assert.equal((await client.callTool({ name: "get_updates", arguments: {} })).isError, undefined);
    const result = await client.callTool({ name: "code", arguments: { code: "trial" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.credits_used, 1);
  } finally { await client.close(); }
  const rotated = await (await handleAgentAccess(management("POST", humanToken(email)), { credits, resend })).json();
  assert.equal(rotated.credits.available, 498);
  assert.equal(await agentKeyOwner(access.token), null);
});

test("missing, malformed, expired and Professional trial dates deny access, including cached expiry", async () => {
  useStore(memoryStore());
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const { token } = await createAgentKey("trial@example.test");
  for (const [plan, end] of [["personal", undefined], ["personal", "broken"], ["personal", "2020-01-01T00:00:00.000Z"], ["professional", "2099-01-01T00:00:00.000Z"]]) {
    const resend = contact(plan, "trial", "agents", end);
    assert.equal((await handleAgentAccess(management("GET", humanToken("trial@example.test")), { credits, resend })).status, 403);
    assert.equal((await handleAgentMcp(rpc(token, body), { credits, resend })).status, 403);
  }
  const cache = { match: async () => Response.json({ interests: "agents", plan: "personal", trialEndsAt: "2020-01-01T00:00:00.000Z" }) };
  assert.equal((await handleAgentMcp(rpc(token, body), { credits, resend: contact("personal"), cache })).status, 403);
});
