import assert from "node:assert/strict";
import test from "node:test";
import { handleSignalsMcp, MCP_TOOLS } from "../src/api/signals-mcp.ts";
import { localSignalService } from "../src/lib/signal-service.ts";
import { signalId } from "../src/lib/signals.ts";
import { at, newStore, record } from "./signals-test-support.mjs";

// The free MCP tier: the live verified signals, read-only, for any agent that can speak MCP, with no key and a limit per caller.
// It is stateless Streamable HTTP with JSON replies, so there is nothing to keep between requests and nothing to log in to.
const URL_OF = "https://api.test/mcp/signals";
const OPEN = { limit: async () => ({ success: true }) };
const rpc = (body, init = {}) => new Request(URL_OF, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "203.0.113.7", ...init.headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const call = (name, args = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function seeded() {
  const service = localSignalService(newStore());
  const rows = [
    ["https://openai.com/index/gpt-6/", { headline: "OpenAI ships GPT-6 to every ChatGPT user today", type: "models", topics: ["LLMs"], publisher: "OpenAI", importance: 9, publishedAt: at(10) }],
    ["https://github.com/acme/agent-kit", { headline: "Acme releases Agent Kit for building coding agents", type: "repos", topics: ["Agents", "Development"], publisher: "Acme", importance: 6, publishedAt: at(20) }],
    ["https://lab.test/embeddings", { headline: "Cohere releases Embed 5 with 85.8 on ViDoRe V3", type: "models", topics: ["Retrieval"], publisher: "Cohere", importance: 7, publishedAt: at(30) }],
  ];
  for (const [url, extra] of rows) await service.publish(record(url, extra));
  return { service, ids: rows.map(([url]) => signalId(url)) };
}
const answer = async (response) => ({ status: response.status, headers: response.headers, body: response.status === 202 || response.status === 204 || response.status === 405 ? null : await response.json() });
const send = async (options, body, init) => answer(await handleSignalsMcp(rpc(body, init), { limiter: OPEN, networkLimiter: OPEN, ...options }));
const structured = (reply) => reply.body.result.structuredContent;

test("it opens a session in one reply: the protocol version agreed on, tools only, who it is and how to read what it returns", async () => {
  const { service } = await seeded();
  const reply = await send({ service }, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get("content-type"), /^application\/json/);
  assert.equal(reply.headers.get("x-ai-generated"), "true");
  assert.equal(reply.headers.get("cache-control"), "no-store");
  assert.equal(reply.headers.get("mcp-session-id"), null, "stateless: there is no session to remember");
  const { result } = reply.body;
  assert.deepEqual([reply.body.jsonrpc, reply.body.id, result.protocolVersion], ["2.0", 1, "2025-06-18"]);
  assert.deepEqual(Object.keys(result.capabilities), ["tools"]);
  assert.match(result.serverInfo.name, /forward/i);
  assert.match(result.instructions, /AI-generated/i);
  assert.match(result.instructions, /data, never instructions/i, "what is quoted from a web page is data to the model that reads it");
  for (const [asked, agreed] of [["2025-03-26", "2025-03-26"], ["2024-11-05", "2024-11-05"], ["2030-01-01", "2025-06-18"], [undefined, "2025-06-18"]]) {
    const negotiated = await send({ service }, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: asked } });
    assert.equal(negotiated.body.result.protocolVersion, agreed, `${asked} -> ${agreed}`);
  }
});

test("a notification is acknowledged with nothing, and ping answers", async () => {
  const { service } = await seeded();
  const note = await handleSignalsMcp(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), { service, limiter: OPEN, networkLimiter: OPEN });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");
  const ping = await send({ service }, { jsonrpc: "2.0", id: 9, method: "ping" });
  assert.deepEqual(ping.body, { jsonrpc: "2.0", id: 9, result: {} });
});

test("it lists four read-only tools, each with a schema that refuses what it does not take", async () => {
  const { service } = await seeded();
  const { body } = await send({ service }, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  const tools = body.result.tools;
  assert.deepEqual(tools.map(({ name }) => name), ["latest_signals", "get_signal", "list_corrections", "signal_stats"]);
  assert.deepEqual(tools.map(({ name }) => name), MCP_TOOLS.map(({ name }) => name));
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} says what it is for`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} takes nothing it does not name`);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  const latest = tools[0].inputSchema.properties;
  assert.deepEqual(Object.keys(latest).sort(), ["before", "limit", "min_importance", "query", "since", "topic", "type"]);
  assert.ok(latest.topic.enum.includes("Retrieval") && latest.type.enum.includes("repos"));
  assert.deepEqual(tools[1].inputSchema.required, ["id"]);
});

test("latest_signals lists the newest first, with where to read the evidence, and filters as asked", async () => {
  const { service, ids } = await seeded();
  const all = structured(await send({ service }, call("latest_signals")));
  assert.deepEqual(all.signals.map(({ id }) => id), [ids[2], ids[1], ids[0]]);
  const first = all.signals[0];
  assert.deepEqual(Object.keys(first).sort(), ["evidenceCount", "headline", "id", "importance", "page", "publishedAt", "publisher", "sourcePublishedAt", "status", "summary", "topics", "traction", "type", "url"].sort());
  assert.equal(first.page, `https://theforwardpass.net/signals/${ids[2]}`);
  const full = (await send({ service }, call("latest_signals"))).body.result;
  assert.deepEqual(full._meta, { aiGenerated: true }, "marked as AI-generated in the answer itself, for a client that never sees the headers");
  const text = full.content[0];
  assert.equal(text.type, "text");
  assert.deepEqual(JSON.parse(text.text), all, "the text is the same answer for a client that reads only text");

  const byTopic = structured(await send({ service }, call("latest_signals", { topic: "Retrieval" })));
  assert.deepEqual(byTopic.signals.map(({ id }) => id), [ids[2]]);
  const byType = structured(await send({ service }, call("latest_signals", { type: "repos" })));
  assert.deepEqual(byType.signals.map(({ id }) => id), [ids[1]]);
  const important = structured(await send({ service }, call("latest_signals", { min_importance: 8 })));
  assert.deepEqual(important.signals.map(({ id }) => id), [ids[0]]);
  const found = structured(await send({ service }, call("latest_signals", { query: "agent kit" })));
  assert.deepEqual(found.signals.map(({ id }) => id), [ids[1]]);
  const since = structured(await send({ service }, call("latest_signals", { since: at(25) })));
  assert.deepEqual(since.signals.map(({ id }) => id), [ids[2]]);
  const paged = structured(await send({ service }, call("latest_signals", { limit: 2 })));
  assert.equal(paged.signals.length, 2);
  assert.ok(paged.next, "there is more");
  const rest = structured(await send({ service }, call("latest_signals", { limit: 2, before: paged.next })));
  assert.deepEqual(rest.signals.map(({ id }) => id), [ids[0]]);
  assert.equal(rest.next, null);
});

test("latest_signals asks for little by default, takes at most fifty, and says plainly what it was given wrong", async () => {
  const service = localSignalService(newStore());
  for (let i = 0; i < 60; i++) await service.publish(record(`https://lab${i}.test/post`, { headline: `Lab ${i} releases model ${i} with a number ${i}`, publishedAt: at(i) }));
  assert.equal(structured(await send({ service }, call("latest_signals"))).signals.length, 10, "ten unless asked");
  assert.equal(structured(await send({ service }, call("latest_signals", { limit: 50 }))).signals.length, 50);
  for (const bad of [{ limit: 51 }, { limit: 0 }, { limit: 2.5 }, { topic: "Cooking" }, { type: "poems" }, { min_importance: 11 }, { since: "last week" }, { query: "x".repeat(101) }, { before: "not a cursor" }, { unknown: 1 }]) {
    const reply = await send({ service }, call("latest_signals", bad));
    assert.equal(reply.status, 200, "a mistake in a tool's arguments is the tool's answer, not a failed request");
    assert.equal(reply.body.result.isError, true, JSON.stringify(bad));
    assert.deepEqual(reply.body.result._meta, { aiGenerated: true }, "an answer that is a complaint is marked too");
    assert.match(reply.body.result.content[0].text, /\w/);
    assert.equal(reply.body.error, undefined);
  }
});

test("get_signal returns the facts with the quotes they were checked against, and what was corrected", async () => {
  const { service, ids } = await seeded();
  await service.correct(ids[2], "correction", "The score is 85.8, not 85.", at(100), { headline: "Cohere releases Embed 5 with 85.8 on ViDoRe V3" });
  await service.correct(ids[1], "correction", "A note about another signal.", at(101), { headline: "Acme releases Agent Kit for building agents that code" });
  const one = structured(await send({ service }, call("get_signal", { id: ids[2] })));
  assert.equal(one.id, ids[2]);
  assert.equal(one.page, `https://theforwardpass.net/signals/${ids[2]}`);
  assert.deepEqual(one.facts, [{ fact: "Embed 5 scores 85.8 on ViDoRe V3.", quote: "85.8 on ViDoRe V3", impact: 3 }]);
  assert.equal(one.evidence.basis, "page");
  assert.equal("documentIds" in one.evidence, false, "internal hashes are not an answer");
  assert.deepEqual(one.corrections.map(({ kind, note }) => [kind, note]), [["correction", "The score is 85.8, not 85."]]);
  assert.deepEqual(one.sources, [{ label: "Lab", url: "https://lab.test/embeddings" }]);

  const missing = await send({ service }, call("get_signal", { id: "g-0123456789abcdef" }));
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /not found/i);
  for (const bad of [{ id: "x" }, { id: "g-NOPE" }, {}, { id: ids[0], extra: true }]) assert.equal((await send({ service }, call("get_signal", bad))).body.result.isError, true, JSON.stringify(bad));
});

test("a retracted signal says it was retracted and why, and nothing else of it", async () => {
  const { service, ids } = await seeded();
  await service.correct(ids[0], "retraction", "The source was withdrawn.", at(100), {});
  const gone = await send({ service }, call("get_signal", { id: ids[0] }));
  assert.equal(gone.body.result.isError, undefined);
  assert.deepEqual(structured(gone), { id: ids[0], status: "retracted", note: "The source was withdrawn.", retractedAt: at(100) });
  const listed = structured(await send({ service }, call("latest_signals")));
  assert.ok(!listed.signals.some(({ id }) => id === ids[0]) || listed.signals.find(({ id }) => id === ids[0]).status === "retracted", "a retracted signal is never offered as live");
});

test("list_corrections and signal_stats answer from the same service as the website's pages", async () => {
  const { service, ids } = await seeded();
  await service.correct(ids[1], "correction", "Stars were 279, not 297.", at(90), { summary: "Acme releases Agent Kit, which had 279 stars today." });
  const log = structured(await send({ service }, call("list_corrections", { limit: 5 })));
  assert.deepEqual(log.corrections.map(({ signalId, kind, note }) => [signalId, kind, note]), [[ids[1], "correction", "Stars were 279, not 297."]]);
  assert.equal(log.corrections[0].page, `https://theforwardpass.net/signals/${ids[1]}`);
  const stats = structured(await send({ service }, call("signal_stats")));
  assert.deepEqual(Object.keys(stats).sort(), ["last30days", "last7days"]);
  assert.equal(typeof stats.last30days.published, "number");
  assert.equal((await send({ service }, call("list_corrections", { limit: 201 }))).body.result.isError, true);
});

test("an unknown tool or method is a protocol error, and so is a request that is not one", async () => {
  const { service } = await seeded();
  const tool = await send({ service }, call("delete_everything"));
  assert.equal(tool.body.error.code, -32602);
  assert.match(tool.body.error.message, /unknown tool/i);
  const method = await send({ service }, { jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.deepEqual([method.body.error.code, method.body.id], [-32601, 4]);
  const noName = await send({ service }, { jsonrpc: "2.0", id: 5, method: "tools/call", params: {} });
  assert.equal(noName.body.error.code, -32602);
  const notJson = await send({ service }, "{not json");
  assert.deepEqual([notJson.status, notJson.body.error.code, notJson.body.id], [400, -32700, null]);
  for (const bad of [42, "text", null, { id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "1.0", id: 1, method: "ping" }]) {
    const reply = await send({ service }, typeof bad === "string" ? JSON.stringify(bad) : bad);
    assert.equal(reply.status, 400, JSON.stringify(bad));
    assert.equal(reply.body.error.code, -32600, JSON.stringify(bad));
  }
});

test("a batch is answered in order, a notification in it is not answered, and an empty batch is refused", async () => {
  const { service } = await seeded();
  const reply = await send({ service }, [{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "b", method: "tools/list" }]);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.map(({ id }) => id), ["a", "b"]);
  assert.equal((await send({ service }, [])).status, 400);
  assert.equal((await send({ service }, Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })))).status, 400, "a batch is ten at most");
  const onlyNotes = await handleSignalsMcp(rpc([{ jsonrpc: "2.0", method: "notifications/initialized" }]), { service, limiter: OPEN, networkLimiter: OPEN });
  assert.equal(onlyNotes.status, 202);
});

test("only POST is served, a browser's preflight is answered, and a body that is too big or not JSON is refused before it is read", async () => {
  const { service } = await seeded();
  for (const method of ["GET", "DELETE", "PUT"]) {
    const reply = await handleSignalsMcp(new Request(URL_OF, { method }), { service, limiter: OPEN, networkLimiter: OPEN });
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers.get("allow"), "POST, OPTIONS");
  }
  const preflight = await handleSignalsMcp(new Request(URL_OF, { method: "OPTIONS", headers: { origin: "https://inspector.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type, mcp-protocol-version" } }), { service, limiter: OPEN, networkLimiter: OPEN });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /content-type/i);
  assert.match(preflight.headers.get("access-control-allow-headers"), /mcp-protocol-version/i);
  const answered = await handleSignalsMcp(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://inspector.example" } }), { service, limiter: OPEN, networkLimiter: OPEN });
  assert.equal(answered.headers.get("access-control-allow-origin"), "*", "a public read-only API has no credentials to protect from a page");
  const big = await handleSignalsMcp(rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "latest_signals", arguments: { query: "x".repeat(40_000) } } })), { service, limiter: OPEN, networkLimiter: OPEN });
  assert.equal(big.status, 413);
  let read = false;
  const declared = rpc("{}", { headers: { "content-length": "99999" } });
  const original = declared.body.getReader.bind(declared.body);
  declared.body.getReader = (...args) => { read = true; return original(...args); };
  assert.equal((await handleSignalsMcp(declared, { service, limiter: OPEN, networkLimiter: OPEN })).status, 413, "a body that says it is too big is refused");
  assert.equal(read, false, "without being read");
  const plain = await handleSignalsMcp(new Request(URL_OF, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), { service, limiter: OPEN, networkLimiter: OPEN });
  assert.equal(plain.status, 415);
});

test("a caller over their limit is told when to come back, and nothing reaches the store", async () => {
  const { service } = await seeded();
  const keys = [];
  let calls = 0;
  const counted = new Proxy(service, { get: (target, name) => typeof target[name] === "function" ? (...args) => { calls++; return target[name](...args); } : target[name] });
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: keys.length <= 2 }; } };
  assert.equal((await send({ service: counted, limiter }, call("latest_signals"))).status, 200);
  assert.equal((await send({ service: counted, limiter }, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 200, "a ping counts too: it is a request");
  const before = calls;
  const refused = await handleSignalsMcp(rpc(call("latest_signals")), { service: counted, limiter, networkLimiter: OPEN });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "60");
  assert.equal(calls, before, "the service was not asked");
  const body = await refused.json();
  assert.equal(body.error.code, -32000);
  assert.match(body.error.message, /too many requests/i);
  assert.deepEqual(keys, ["203.0.113.7", "203.0.113.7", "203.0.113.7"], "by caller");
  const anonymous = [];
  await handleSignalsMcp(new Request(URL_OF, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }), { service, networkLimiter: OPEN, limiter: { limit: async ({ key }) => { anonymous.push(key); return { success: true }; } } });
  assert.deepEqual(anonymous, ["anonymous"]);
});

test("the same question within a minute is answered from the cache, a different one is not, and a failure is never kept", async () => {
  const { service } = await seeded();
  const store = new Map();
  const cache = { match: async (request) => store.get(request.url)?.clone(), put: async (request, response) => { store.set(request.url, response); } };
  let calls = 0;
  const counted = new Proxy(service, { get: (target, name) => typeof target[name] === "function" ? (...args) => { calls++; return target[name](...args); } : target[name] });
  const ask = (args) => send({ service: counted, cache }, call("latest_signals", args));
  await ask({ topic: "LLMs" });
  const first = calls;
  const again = await ask({ topic: "LLMs" });
  assert.equal(calls, first, "the second asking did not reach the service");
  assert.equal(structured(again).signals.length, 1);
  await ask({ topic: "Retrieval" });
  assert.ok(calls > first, "another question is another asking");
  const reordered = await send({ service: counted, cache }, call("latest_signals", { limit: 10, topic: "LLMs" }));
  const spent = calls;
  await send({ service: counted, cache }, call("latest_signals", { topic: "LLMs", limit: 10 }));
  assert.equal(calls, spent, "the order of the arguments is not a different question");
  assert.equal(structured(reordered).signals.length, 1);
  const stored = [...store.values()][0];
  assert.match(stored.headers.get("cache-control"), /max-age=60/);
  let puts = 0;
  const counting = { match: async () => undefined, put: async () => { puts++; } };
  const failing = new Proxy(service, { get: (target, name) => name === "list" ? async () => { throw new Error("database is down"); } : target[name] });
  const broken = await send({ service: failing, cache: counting }, call("latest_signals", { topic: "Agents" }));
  assert.equal(broken.body.result.isError, true);
  assert.doesNotMatch(JSON.stringify(broken.body), /database is down/, "no internals in an answer");
  assert.match(broken.body.result.content[0].text, /unavailable/i);
  const bad = await send({ service, cache: counting }, call("latest_signals", { topic: "Cooking" }));
  assert.equal(bad.body.result.isError, true);
  const missing = await send({ service, cache: counting }, call("get_signal", { id: "g-0123456789abcdef" }));
  assert.equal(missing.body.result.isError, true);
  assert.equal(puts, 0, "a failure, a mistake and a signal that is not there are never kept");
  await send({ service, cache: counting }, call("latest_signals", { topic: "Agents" }));
  assert.equal(puts, 1, "a good answer is");
  const unreachable = { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); } };
  const still = await send({ service, cache: unreachable }, call("latest_signals", { topic: "Agents" }));
  assert.equal(still.status, 200, "a cache that cannot be reached is no reason to refuse");
  assert.equal(still.body.result.isError, undefined);
});

test("a batch is charged for every message in it, so it cannot be a way round the limit, and none of it is run when it is refused", async () => {
  const { service } = await seeded();
  let calls = 0;
  const counted = new Proxy(service, { get: (target, name) => typeof target[name] === "function" ? (...args) => { calls++; return target[name](...args); } : target[name] });
  const allowance = (n) => { let used = 0; return { limit: async () => ({ success: ++used <= n }) }; };
  const batch = (n) => Array.from({ length: n }, (_, i) => call("latest_signals", { limit: 1 + i }, i));
  const fits = await handleSignalsMcp(rpc(batch(4)), { service: counted, limiter: allowance(4), networkLimiter: OPEN });
  assert.equal(fits.status, 200, "four messages, four allowed");
  assert.equal((await fits.json()).length, 4);
  calls = 0;
  const over = await handleSignalsMcp(rpc(batch(4)), { service: counted, limiter: allowance(3), networkLimiter: OPEN });
  assert.equal(over.status, 429, "four messages, three allowed");
  assert.equal(over.headers.get("retry-after"), "60");
  assert.equal(calls, 0, "and not one of them was run");
  const seen = [];
  await handleSignalsMcp(rpc(batch(3)), { service: counted, networkLimiter: OPEN, limiter: { limit: async ({ key }) => { seen.push(key); return { success: true }; } } });
  assert.deepEqual(seen, ["203.0.113.7", "203.0.113.7", "203.0.113.7"], "one charge per message, to the caller");
  const refusedBatch = await handleSignalsMcp(rpc([]), { service: counted, limiter: allowance(0), networkLimiter: OPEN });
  assert.equal(refusedBatch.status, 429, "the request itself is counted before anything is looked at");
});

test("the messages of a batch are answered one at a time, so a batch is no burst on the store", async () => {
  const { service } = await seeded();
  let running = 0, peak = 0;
  const slow = new Proxy(service, { get: (target, name) => name === "list" ? async (...args) => { running++; peak = Math.max(peak, running); await new Promise((resolve) => setTimeout(resolve, 5)); running--; return target.list(...args); } : target[name] });
  const reply = await handleSignalsMcp(rpc(Array.from({ length: 5 }, (_, i) => call("latest_signals", { limit: i + 1 }, i))), { service: slow, limiter: OPEN, networkLimiter: OPEN });
  assert.equal(reply.status, 200);
  assert.equal(peak, 1);
});

test("without both limiters it answers nothing: a server that is missing a limit does not run without it", async () => {
  const { service } = await seeded();
  for (const options of [{ service }, { service, limiter: OPEN }, { service, networkLimiter: OPEN }]) {
    const reply = await handleSignalsMcp(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }), options);
    assert.equal(reply.status, 503, Object.keys(options).join(","));
    assert.match((await reply.json()).error.message, /not available/i);
  }
});

test("an IPv6 caller is also counted by its /48, which is one customer however many /64s it rotates through, and an IPv4 one is not", async () => {
  const { service } = await seeded();
  const record = async (ip, { network = OPEN, caller = OPEN } = {}) => {
    const seen = { callers: [], networks: [] };
    const reply = await handleSignalsMcp(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "cf-connecting-ip": ip } }), {
      service,
      limiter: { limit: async ({ key }) => { seen.callers.push(key); return caller.limit({ key }); } },
      networkLimiter: { limit: async ({ key }) => { seen.networks.push(key); return network.limit({ key }); } },
    });
    return { ...seen, status: reply.status };
  };
  const a = await record("2001:db8:abcd:1::1");
  const b = await record("2001:db8:abcd:2::1");
  const c = await record("2001:db8:abce:1::1");
  assert.deepEqual([a.callers[0] === b.callers[0], a.networks[0] === b.networks[0]], [false, true], "two /64s of one /48: two callers, one network");
  assert.equal(a.networks[0], "2001:db8:abcd::/48");
  assert.notEqual(c.networks[0], a.networks[0], "another /48 is another network");
  const mapped = await record("::ffff:203.0.113.7");
  const v4 = await record("203.0.113.7");
  assert.deepEqual([mapped.networks, v4.networks], [[], []], "an IPv4 address is its own caller and has no network: unrelated hosts share a /24");
  assert.deepEqual([mapped.callers, v4.callers], [["203.0.113.7"], ["203.0.113.7"]]);
  assert.deepEqual((await record("garbage:text")).networks, [], "what cannot be read has none");
  assert.equal((await record("2001:db8:abcd:1::1", { network: { limit: async () => ({ success: false }) } })).status, 429, "a network over its limit is refused, whichever address it comes from");
  assert.equal((await record("2001:db8:abcd:1::1", { caller: { limit: async () => ({ success: false }) } })).status, 429);
});

test("one abusive caller cannot use up its network's allowance for the others: its own limit stops it before the network is charged", async () => {
  const { service } = await seeded();
  const windowed = (limit) => { const counts = new Map(); return { counts, limit: async ({ key }) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return { success: n <= limit }; } }; };
  const caller = windowed(3), network = windowed(10);
  const ping = (ip) => handleSignalsMcp(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "cf-connecting-ip": ip } }), { service, limiter: caller, networkLimiter: network });
  const statuses = [];
  for (let i = 0; i < 50; i++) statuses.push((await ping("2001:db8:abcd:1::1")).status);
  assert.equal(statuses.filter((status) => status === 200).length, 3, "the abuser has its own allowance, and no more");
  assert.equal(network.counts.get("2001:db8:abcd::/48"), 3, "and has charged the network for no more than that");
  assert.equal((await ping("2001:db8:abcd:2::1")).status, 200, "a neighbour in the same /48 is served");
  assert.equal((await ping("2001:db8:abcd:3::1")).status, 200);
});

test("a batch is charged to the network as well, message by message, and a refusal by the network runs none of it", async () => {
  const { service } = await seeded();
  let calls = 0;
  const counted = new Proxy(service, { get: (target, name) => typeof target[name] === "function" ? (...args) => { calls++; return target[name](...args); } : target[name] });
  let used = 0;
  const network = { limit: async () => ({ success: ++used <= 3 }) };
  const batch = Array.from({ length: 4 }, (_, i) => call("latest_signals", { limit: 1 + i }, i));
  const refused = await handleSignalsMcp(rpc(batch, { headers: { "cf-connecting-ip": "2001:db8:abcd:1::1" } }), { service: counted, limiter: OPEN, networkLimiter: network });
  assert.equal(refused.status, 429);
  assert.equal(calls, 0);
  assert.equal(used, 4, "four messages, four charges, the fourth refused");
});

test("a caller is counted by network, not by address: an IPv6 caller holds a whole /64, and an IPv4-mapped address is the IPv4 one", async () => {
  const { service } = await seeded();
  const keyFor = async (ip) => { const keys = []; await handleSignalsMcp(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "cf-connecting-ip": ip } }), { service, networkLimiter: OPEN, limiter: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } }); return keys[0]; };
  const same = ["2001:db8:1234:5678::1", "2001:DB8:1234:5678:aaaa:bbbb:cccc:dddd", "2001:0db8:1234:5678:0:0:0:2"];
  const keys = await Promise.all(same.map(keyFor));
  assert.equal(new Set(keys).size, 1, "every address in the /64 is one caller");
  assert.equal(keys[0], "2001:db8:1234:5678::/64");
  assert.notEqual(await keyFor("2001:db8:1234:5679::1"), keys[0], "a different /64 is a different caller");
  assert.equal(await keyFor("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(await keyFor("203.0.113.7"), "203.0.113.7");
  assert.equal(await keyFor("::1"), "0:0:0:0::/64", "the loopback, short as it is");
  assert.equal(await keyFor("not an address"), "not an address", "what cannot be read is kept as it is, not guessed at");
  for (const odd of ["garbage:text", "1:2:3:4:5:6:7:8:9", "xyz1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7"]) assert.equal(await keyFor(odd), odd, odd);
});
