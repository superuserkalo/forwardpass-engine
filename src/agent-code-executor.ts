import { createHash } from "node:crypto";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { AGENT_CODE_TIMEOUT_MS } from "./lib/agent-code.js";

export function agentCodeExecutor(loader: WorkerLoader, account: string) {
  const handles: unknown[] = [];
  const dispose = (value: unknown) => {
    if (typeof value !== "object" || value === null || !(Symbol.dispose in value) || typeof value[Symbol.dispose] !== "function") return;
    try { (value as { [Symbol.dispose]: () => void })[Symbol.dispose](); } catch { /* SDK may already have released the handle. */ }
  };
  // Repeated scripts reuse their Worker ID within one account only. Warm globals must never cross accounts.
  const cachedLoader: WorkerLoader = {
    get: (id, getCode) => loader.get(id, getCode),
    load: (code) => {
      const bounded = { ...code, limits: { cpuMs: 50, subRequests: 30 } };
      const id = `forwardpass-code-${createHash("sha256").update(account).update(JSON.stringify(bounded)).digest("hex")}`;
      const worker = loader.get(id, () => bounded);
      handles.push(worker);
      const tracked: WorkerStub & { [Symbol.dispose]: () => void } = {
        getEntrypoint<T extends Rpc.WorkerEntrypointBranded | undefined>(name?: string, options?: WorkerStubEntrypointOptions): Fetcher<T> {
          const entrypoint = worker.getEntrypoint<T>(name, options);
          handles.push(entrypoint);
          return entrypoint;
        },
        getDurableObjectClass: (...args) => worker.getDurableObjectClass(...args),
        [Symbol.dispose]: () => dispose(worker),
      };
      return tracked;
    },
  };
  const executor = new DynamicWorkerExecutor({ loader: cachedLoader, timeout: AGENT_CODE_TIMEOUT_MS, globalOutbound: null });
  return {
    execute: executor.execute.bind(executor),
    // Closing RPC handles also cancels a sandbox that disabled its own timeout.
    close: () => { for (const handle of handles.reverse()) dispose(handle); handles.length = 0; },
  };
}
