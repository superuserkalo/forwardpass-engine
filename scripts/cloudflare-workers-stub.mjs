import { registerHooks } from "node:module";

// `cloudflare:workers` only exists inside the Workers runtime, so a Durable Object class cannot be imported in a test
// without it. Call this first, then import the class dynamically:
//   stubCloudflareWorkers();
//   const { SignalsIndex } = await import("../src/signals-index.ts");
// The base classes keep what the real ones keep (the state and the environment); RpcTarget has nothing to keep.
const STUB = [
  "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  "export class RpcTarget {}",
  "export const env = {}; export const exports = {};",
].join("\n");

export function stubCloudflareWorkers() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "cloudflare:workers" ? { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true } : nextResolve(specifier, context);
    },
  });
}
