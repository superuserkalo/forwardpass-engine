import { DatabaseSync } from "node:sqlite";
import { SignalStore, signalId, signalRecordSchema } from "../src/lib/signals.ts";

// Durable Object storage as the signals code sees it, on node:sqlite (as scripts/chat-test-support.mjs does for chat).
export function newStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    sql: { exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings); return { toArray: () => rows }; } },
    transactionSync(operation) {
      db.exec("BEGIN");
      try { const result = operation(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
export const newStore = () => new SignalStore(newStorage());

/** A valid signal for a URL; `extra` overrides any field. */
export const record = (url, extra = {}) => signalRecordSchema.parse({
  version: 1, id: signalId(url), url, sources: [{ label: "Lab", url }],
  headline: "Cohere releases Embed 5 with 85.8 on ViDoRe V3", summary: "Embed 5 is generally available on the Cohere API.", type: "models", topics: ["Retrieval"],
  project: "cohere/embed-5", publisher: "Cohere", sourcePublishedAt: "2026-10-03T09:40:00.000Z", firstSeenAt: "2026-10-03T10:00:00.000Z", publishedAt: "2026-10-03T10:20:00.000Z",
  traction: null, importance: 7, facts: [{ fact: "Embed 5 scores 85.8 on ViDoRe V3.", quote: "85.8 on ViDoRe V3", impact: 3 }],
  evidence: { documentIds: ["a".repeat(64)], capturedAt: "2026-10-03T10:10:00.000Z", basis: "page", grounding: { evaluator: "jev", verdicts: [] } }, status: "live", ...extra,
});

/** An ISO time `minutes` after 2026-10-03T10:00:00Z. */
export const at = (minutes) => new Date(Date.parse("2026-10-03T10:00:00Z") + minutes * 60_000).toISOString();
