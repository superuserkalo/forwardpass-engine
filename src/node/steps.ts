import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "../lib/private-store.js";
import type { StepConfig, Steps } from "../pipeline/steps.js";

// Runs a job's steps in Node with the same contract as Cloudflare Workflows: each finished
// step's result is stored under pipeline/steps/<job>/, so re-running the job resumes.

const stored = z.object({ value: z.unknown() });

export function nodeSteps(jobId: string, options: { log?: (line: string) => void } = {}): Steps {
  const log = options.log ?? ((line: string) => console.log(line));
  const key = (name: string) => `pipeline/steps/${jobId.toLowerCase()}/${name.toLowerCase()}.json`;
  return {
    async run<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T> {
      const saved = await readPrivateJson(key(name));
      if (saved !== null) return stored.parse(saved).value as T;
      const attempts = (config.retries?.limit ?? 0) + 1;
      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        try {
          const value = await callback();
          // Round-trip through JSON so Node sees exactly what a replayed Workflow step returns.
          const result = JSON.parse(JSON.stringify({ value: value ?? null }));
          await writePrivateJson(key(name), result);
          log(`step ${name} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
          return result.value as T;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= attempts) { log(`step ${name} failed: ${message}`); throw error; }
          const base = config.retries?.delay ?? 1000;
          const delay = config.retries?.backoff === "exponential" ? base * 2 ** (attempt - 1) : config.retries?.backoff === "linear" ? base * attempt : base;
          log(`step ${name} attempt ${attempt} failed (${message.slice(0, 160)}); retrying in ${Math.round(delay / 1000)}s`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    },
    async sleep(name, ms) {
      log(`sleep ${name} ${Math.round(ms / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
