import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAgentCode } from "../src/lib/agent-code.ts";

const executor = (run) => ({ execute: async (_code, providers) => run(providers[0].fns) });

test("code mode limits attempted calls before host work, including concurrent calls", async () => {
  let calls = 0;
  const output = await executeAgentCode("unused", executor(async (fns) => {
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => fns.get_updates({})));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 20);
    return { result: "done" };
  }), async () => { calls++; return { stories: [] }; });
  assert.equal(calls, 20);
  assert.equal(output.credits_used, 20);
});

test("failed calls and invalid argument arity do not count as successful coverage", async () => {
  const output = await executeAgentCode("unused", executor(async (fns) => {
    await assert.rejects(fns.get_updates({}, {}), /one argument/);
    await assert.rejects(fns.get_story({ id: "missing" }), /not found/);
    await fns.get_updates();
    return { result: [], error: "Later script failure" };
  }), async (name) => { if (name === "get_story") throw new Error("not found"); return { stories: [] }; });
  assert.equal(output.credits_used, 1);
  assert.equal(output.error, "Later script failure");
});

test("fire-and-forget calls cannot spend after code returns", async () => {
  let release;
  let work;
  const output = await executeAgentCode("unused", executor(async (fns) => {
    work = fns.get_updates({}).catch((e) => e.message);
    setTimeout(() => release(), 0);
    return { result: "finished" };
  }), async (_name, _input, active) => {
    await new Promise((resolve) => { release = resolve; });
    assert.equal(active(), false);
    throw new Error("ended");
  });
  assert.equal(await work, "ended");
  assert.equal(output.credits_used, 0);
});

test("non-JSON and oversized output preserves usage without leaking an unbounded result", async () => {
  for (const result of ["x".repeat(25_000), 1n, (() => { const x = {}; x.self = x; return x; })()]) {
    const output = await executeAgentCode("unused", executor(async (fns) => {
      await fns.get_updates({});
      return { result, logs: Array.from({ length: 50 }, () => "x".repeat(1000)) };
    }), async () => ({ stories: [] }));
    assert.equal(output.result, null);
    assert.match(output.error, /24 KB|JSON/);
    assert.equal(output.credits_used, 1);
  }
});

test("the host deadline ends an executor that never returns", async () => {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds) => {
    assert.equal(milliseconds, 20_000);
    return original(callback, 0);
  };
  try {
    const output = await executeAgentCode("unused", { execute: () => new Promise(() => {}) }, async () => ({ stories: [] }));
    assert.match(output.error, /timed out after 20 seconds/);
    assert.equal(output.credits_used, 0);
  } finally { globalThis.setTimeout = original; }
});
