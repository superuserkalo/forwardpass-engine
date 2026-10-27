import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { localSignalService } from "../src/lib/signal-service.ts";
import { stubCloudflareWorkers } from "./cloudflare-workers-stub.mjs";
import { at, newStore, record } from "./signals-test-support.mjs";

stubCloudflareWorkers();
const worker = await import("../src/worker.ts");

// The free MCP route: where it is, which limiter it answers to, and that it is not the public signals' limiter or cache.
const bucket = () => ({ async get() { return null; }, async put() { return {}; }, async list() { return { objects: [], truncated: false }; }, async delete() {} });
function makeEnv(mcpLimit = async () => ({ success: true })) {
  const service = localSignalService(newStore());
  const limits = { mcp: [], network: [], signals: [] };
  const env = { BUCKET: bucket(), SIGNALS: { getByName: () => service }, SIGNALS_RATE_LIMITER: { limit: async ({ key }) => { limits.signals.push(key); return { success: true }; } }, SIGNALS_MCP_RATE_LIMITER: { limit: async ({ key }) => { limits.mcp.push(key); return mcpLimit({ key }); } }, SIGNALS_MCP_NETWORK_RATE_LIMITER: { limit: async ({ key }) => { limits.network.push(key); return { success: true }; } }, ADMIN_TOKEN: "t".repeat(40) };
  return { env, service, limits };
}
const stored = new Map();
globalThis.caches = { default: { async match(request) { return stored.get(request.url)?.clone(); }, async put(request, response) { stored.set(request.url, response); } } };
const post = (env, body, headers = {}) => worker.default.fetch(new Request("https://api.test/mcp/signals", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9", ...headers }, body: JSON.stringify(body) }), env, { waitUntil() {} });

test("the free MCP route answers at /mcp/signals, from the signal service, under its own limiter", async () => {
  const { env, service, limits } = makeEnv();
  await service.publish(record("https://lab.test/post", { publishedAt: at(5) }));
  const init = await post(env, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.name, "forwardpass-signals");
  const listed = await (await post(env, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "latest_signals", arguments: {} } })).json();
  assert.equal(listed.result.structuredContent.signals.length, 1, "it reads the service the public routes read");
  assert.deepEqual(limits.mcp, ["198.51.100.9", "198.51.100.9"], "each request is counted against the caller");
  assert.deepEqual(limits.signals, [], "and never against the public signals' allowance");
  await post(env, { jsonrpc: "2.0", id: 3, method: "ping" }, { "cf-connecting-ip": "2001:db8:abcd:1::7" });
  assert.deepEqual(limits.network, ["2001:db8:abcd::/48"], "an IPv6 caller is counted by its network too");
  assert.ok([...stored.keys()].some((key) => key.startsWith("https://mcp.internal/signals/latest_signals/")), "a good answer is kept at the edge for a minute");
});

test("a caller over the MCP limit is refused with a retry time, and only POST is answered", async () => {
  const { env } = makeEnv(async () => ({ success: false }));
  const refused = await post(env, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "60");
  const { env: open } = makeEnv();
  const get = await worker.default.fetch(new Request("https://api.test/mcp/signals"), open, { waitUntil() {} });
  assert.equal(get.status, 405);
  const other = await worker.default.fetch(new Request("https://api.test/mcp/signals/extra", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }), open, { waitUntil() {} });
  assert.notEqual(other.status, 200, "only the one path is the server");
});

test("a deployment without either MCP limiter serves no MCP, rather than serving it unlimited", async () => {
  for (const missing of ["SIGNALS_MCP_RATE_LIMITER", "SIGNALS_MCP_NETWORK_RATE_LIMITER"]) {
    const { env } = makeEnv();
    delete env[missing];
    const reply = await post(env, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(reply.status, 503, missing);
    const listed = await post(env, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(listed.status, 503, "not even to list the tools");
  }
});

test("wrangler.jsonc declares the MCP limiters, apart from the others", () => {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"));
  const limiter = config.ratelimits.find((limit) => limit.name === "SIGNALS_MCP_RATE_LIMITER");
  assert.ok(limiter, "declared");
  assert.deepEqual([limiter.simple.limit, limiter.simple.period], [60, 60], "a minute's allowance an agent can live in and a crawler cannot");
  const network = config.ratelimits.find((limit) => limit.name === "SIGNALS_MCP_NETWORK_RATE_LIMITER");
  assert.ok(network, "and one for a network");
  assert.ok(network.simple.limit > limiter.simple.limit && network.simple.period === 60, "which holds many callers, so it allows more");
  const spaces = config.ratelimits.map(({ namespace_id: id }) => id);
  assert.equal(new Set(spaces).size, spaces.length, "no two limiters share a namespace");
});
