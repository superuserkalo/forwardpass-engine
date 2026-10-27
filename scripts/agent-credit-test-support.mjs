import { DatabaseSync } from "node:sqlite";
import { AgentCreditAccount } from "../src/lib/agent-credits.ts";

export function creditAccount() {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: { exec(query, ...bindings) {
      if (query.includes(";")) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error("Expected exactly one row"); return rows[0]; } };
    } },
    transactionSync(operation) {
      db.exec("BEGIN");
      try { const result = operation(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  return new AgentCreditAccount(storage);
}

export function memoryCredits() {
  const accounts = new Map();
  return (id) => {
    if (!accounts.has(id)) accounts.set(id, creditAccount());
    const account = accounts.get(id);
    return {
      status: async (plan) => account.status(plan),
      reserve: async (plan) => account.reserve(plan),
      settle: async (id, successful, access) => account.settle(id, successful, new Date(), access),
      applyPayment: async (payment) => account.applyPayment(payment),
      configure: async (settings) => account.configure(settings, settings.enabled ? "11111111-1111-4111-8111-111111111111" : null),
    };
  };
}
