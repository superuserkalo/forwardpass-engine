import type { Executor } from "@cloudflare/codemode";

export type AgentCodeExecutor = Pick<Executor, "execute"> & { close?: () => void };
export type AgentCodeInvoke = (name: string, input: unknown, active: () => boolean) => Promise<Record<string, unknown>>;
export const AGENT_CODE_MAX_CALLS = 20;
export const AGENT_CODE_TIMEOUT_MS = 20_000;
export const AGENT_CODE_OUTPUT_BYTES = 24_000;

/** All capabilities, validation and metering stay in the host, outside generated code. */
export async function executeAgentCode(code: string, executor: AgentCodeExecutor, invoke: AgentCodeInvoke) {
  const deadline = Date.now() + AGENT_CODE_TIMEOUT_MS;
  let open = true;
  let calls = 0;
  let successful = 0;
  const pending = new Set<Promise<unknown>>();
  const active = () => open && Date.now() < deadline;
  const methods = Object.fromEntries(["get_updates", "search_coverage", "get_story"].map((name) => [name, async (...args: unknown[]) => {
    if (!active()) throw new Error("Code execution has ended.");
    if (++calls > AGENT_CODE_MAX_CALLS) throw new Error("Code mode allows at most 20 coverage calls per execution.");
    if (args.length > 1) throw new Error("Pass one argument object to a coverage method.");
    const operation = invoke(name, args[0] ?? {}, active).then((value) => { successful++; return value; });
    pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); }
  }]));
  let output: { result: unknown; error?: string; logs?: string[] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    output = await Promise.race([
      executor.execute(code, [{ name: "codemode", fns: methods }]),
      new Promise<{ result: null; error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ result: null, error: "Code execution timed out after 20 seconds." }), AGENT_CODE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    output = { result: null, error: "Code execution failed. Check JavaScript syntax and the execution limits." };
  } finally {
    clearTimeout(timer);
    open = false;
    executor.close?.();
    // Fire-and-forget calls cannot continue spending after the script returns.
    await Promise.allSettled(pending);
  }
  const value = { result: output.result ?? null, ...(output.error ? { error: output.error.slice(0, 1000) } : {}), logs: (output.logs ?? []).slice(0, 20).map((line) => line.slice(0, 500)), coverage_calls: successful, credits_used: successful };
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength <= AGENT_CODE_OUTPUT_BYTES) return value;
  } catch { /* Circular or non-JSON results must not break the MCP response after spending. */ }
  return { result: null, error: "Code result exceeds 24 KB or is not JSON serializable. Return fewer fields or summarize in your script.", logs: [], coverage_calls: successful, credits_used: successful };
}
