// The durable-step contract shared by Cloudflare Workflows (src/workflows.ts) and the Node
// runner (src/node/steps.ts). A step's result is stored once it succeeds; when a job runs
// again, finished steps return their stored result, so a retry repeats no model call.
// Results must be JSON and stay small (Workflows allows 1 MiB); large data goes to R2.

export type StepConfig = {
  retries?: { limit: number; delay: number; backoff?: "constant" | "linear" | "exponential" };
  /** Milliseconds. */
  timeout?: number;
};

export interface Steps {
  run<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const MODEL_STEP: StepConfig = { retries: { limit: 3, delay: 30_000, backoff: "exponential" }, timeout: 15 * 60_000 };
export const IO_STEP: StepConfig = { retries: { limit: 4, delay: 15_000, backoff: "exponential" }, timeout: 10 * 60_000 };
