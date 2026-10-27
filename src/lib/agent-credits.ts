import { z } from "zod";
import { createHash } from "node:crypto";

export const agentPlanSchema = z.enum(["personal", "professional"]);
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export const MONTHLY_AGENT_CREDITS: Record<AgentPlan, number> = { personal: 500, professional: 2500 };
export type AgentCreditAccess = AgentPlan | { plan: "personal"; trialEndsAt: string };
export const AGENT_CREDIT_PACK = { credits: 1000, usd: 500, eur: 549 } as const;
// Financial identity must survive signing-secret and agent-key rotation.
export const agentCreditAccountId = (email: string) => createHash("sha256").update(`forwardpass-agent-credits:${email.toLowerCase()}`).digest("hex");
export const refillSettingsSchema = z.object({
  enabled: z.boolean(), currency: z.enum(["usd", "eur"]).default("usd"),
  maxPacksPerMonth: z.number().int().min(1).max(10).default(2),
});
export type RefillSettings = z.infer<typeof refillSettingsSchema>;
export const creditPaymentSchema = z.object({
  orderId: z.uuid(), email: z.email(), customerId: z.uuid(), productId: z.uuid(),
  paid: z.boolean(), netAmount: z.number().int().positive(), refundedAmount: z.number().int().min(0),
  currency: z.enum(["usd", "eur"]), automaticAttempt: z.uuid().nullable().default(null),
});
export type CreditPayment = z.infer<typeof creditPaymentSchema>;
const savedRefillSchema = refillSettingsSchema.extend({ customerId: z.uuid().nullable(), pending: z.uuid().nullable(), error: z.string().nullable() });
type SavedRefill = z.infer<typeof savedRefillSchema>;
type StateRow = { month: string; used: number; purchased: number; refill: string };
type ReservationRow = { id: string; bucket: string; month: string; created: number };
type PurchaseRow = { id: string; granted: number; revoked: number };
export type CreditStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
const defaultRefill: SavedRefill = { enabled: false, currency: "usd", maxPacksPerMonth: 2, customerId: null, pending: null, error: null };
const monthAt = (now: Date) => now.toISOString().slice(0, 7);
const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

/** One account's durable credit ledger. Every mutation is a synchronous SQLite transaction. */
export class AgentCreditAccount {
  constructor(private readonly storage: CreditStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id = 1), month TEXT NOT NULL, used INTEGER NOT NULL, purchased INTEGER NOT NULL, refill TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trial_usage (id INTEGER PRIMARY KEY CHECK(id = 1), used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, month TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, granted INTEGER NOT NULL, revoked INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refill_attempts (id TEXT PRIMARY KEY, month TEXT NOT NULL, customer TEXT NOT NULL, currency TEXT NOT NULL, order_id TEXT);
      CREATE INDEX IF NOT EXISTS reservations_created ON reservations(created);
      CREATE INDEX IF NOT EXISTS refill_attempts_month ON refill_attempts(month);
    `);
    storage.sql.exec("INSERT OR IGNORE INTO trial_usage VALUES (1, 0)");
    storage.sql.exec("INSERT OR IGNORE INTO account VALUES (1, '', 0, 0, ?)", JSON.stringify(defaultRefill));
  }

  private row(): StateRow { return this.storage.sql.exec<StateRow>("SELECT month, used, purchased, refill FROM account WHERE id = 1").one(); }
  private refill(row = this.row()): SavedRefill { return savedRefillSchema.parse(JSON.parse(row.refill)); }
  private saveRefill(value: SavedRefill) { this.storage.sql.exec("UPDATE account SET refill = ? WHERE id = 1", JSON.stringify(value)); }
  private refresh(now: Date) {
    const month = monthAt(now);
    this.storage.sql.exec("UPDATE account SET month = ?, used = 0 WHERE id = 1 AND month != ?", month, month);
    // Abandoned calls cannot leave a reader permanently charged. Work taking over five minutes must fail settlement.
    const expired = this.storage.sql.exec<ReservationRow>("SELECT * FROM reservations WHERE created <= ?", now.getTime() - 300_000).toArray();
    for (const item of expired) this.refund(item);
    this.storage.sql.exec("DELETE FROM reservations WHERE created <= ?", now.getTime() - 300_000);
  }
  private refund(item: ReservationRow) {
    if (item.bucket === "purchased") this.storage.sql.exec("UPDATE account SET purchased = purchased + 1 WHERE id = 1");
    else if (item.bucket === "trial") this.storage.sql.exec("UPDATE trial_usage SET used = MAX(0, used - 1) WHERE id = 1");
    else this.storage.sql.exec("UPDATE account SET used = MAX(0, used - 1) WHERE id = 1 AND month = ?", item.month);
  }
  private snapshot(access: AgentCreditAccess, now: Date) {
    const plan = typeof access === "string" ? access : access.plan;
    const trialEndsAt = typeof access === "string" ? null : access.trialEndsAt;
    const row = this.row();
    const refill = this.refill(row);
    const automaticPacks = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM refill_attempts WHERE month = ?", monthAt(now)).one().count;
    const trialUsed = this.storage.sql.exec<{ used: number }>("SELECT used FROM trial_usage WHERE id = 1").one().used;
    const includedRemaining = trialEndsAt ? (Date.parse(trialEndsAt) > now.getTime() ? Math.max(0, 500 - trialUsed) : 0) : Math.max(0, MONTHLY_AGENT_CREDITS[plan] - row.used);
    const purchasedRemaining = trialEndsAt ? 0 : row.purchased;
    return {
      plan, monthlyAllowance: MONTHLY_AGENT_CREDITS[plan], includedRemaining, purchasedRemaining, trialEndsAt,
      available: Math.max(0, includedRemaining + purchasedRemaining), resetsAt: trialEndsAt ?? nextMonth(now),
      autoRefill: { enabled: !trialEndsAt && refill.enabled, currency: refill.currency, maxPacksPerMonth: refill.maxPacksPerMonth, automaticPacks, pending: !!refill.pending, error: refill.error },
    };
  }
  status(plan: AgentCreditAccess, now = new Date()) {
    return this.storage.transactionSync(() => { this.refresh(now); return this.snapshot(plan, now); });
  }
  reserve(plan: AgentCreditAccess, now = new Date()) {
    return this.storage.transactionSync(() => {
      this.refresh(now);
      const status = this.snapshot(plan, now);
      if (status.available <= 0) return { reservation: null, credits: status };
      const bucket = typeof plan !== "string" ? "trial" : status.includedRemaining > 0 ? "included" : "purchased";
      const id = crypto.randomUUID();
      this.storage.sql.exec(bucket === "trial" ? "UPDATE trial_usage SET used = used + 1 WHERE id = 1" : bucket === "included" ? "UPDATE account SET used = used + 1 WHERE id = 1" : "UPDATE account SET purchased = purchased - 1 WHERE id = 1");
      this.storage.sql.exec("INSERT INTO reservations VALUES (?, ?, ?, ?)", id, bucket, monthAt(now), now.getTime());
      return { reservation: id, credits: this.snapshot(plan, now) };
    });
  }
  settle(id: string, successful: boolean, now = new Date(), access?: AgentCreditAccess): boolean {
    return this.storage.transactionSync(() => {
      this.refresh(now);
      const item = this.storage.sql.exec<ReservationRow>("SELECT * FROM reservations WHERE id = ?", id).toArray()[0];
      if (!item) return false;
      const expired = item.bucket === "trial" && access !== undefined && typeof access !== "string" && !(Date.parse(access.trialEndsAt) > now.getTime());
      if (!successful || expired) this.refund(item);
      this.storage.sql.exec("DELETE FROM reservations WHERE id = ?", id);
      return !expired;
    });
  }
  applyPayment(input: CreditPayment) {
    const payment = creditPaymentSchema.parse(input);
    return this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<PurchaseRow>("SELECT * FROM purchases WHERE id = ?", payment.orderId).toArray()[0] ?? { id: payment.orderId, granted: 0, revoked: 0 };
      const granted = Math.max(previous.granted, payment.paid ? AGENT_CREDIT_PACK.credits : 0);
      // Refunds are cumulative and may arrive before paid events. Never restore refunded credits on a stale delivery.
      const revoked = Math.max(previous.revoked, Math.min(AGENT_CREDIT_PACK.credits, Math.ceil(AGENT_CREDIT_PACK.credits * payment.refundedAmount / payment.netAmount)));
      const delta = granted - previous.granted - (revoked - previous.revoked);
      this.storage.sql.exec("INSERT INTO purchases VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET granted = excluded.granted, revoked = excluded.revoked", payment.orderId, granted, revoked);
      this.storage.sql.exec("UPDATE account SET purchased = purchased + ? WHERE id = 1", delta);
      const refill = this.refill();
      if (payment.paid && payment.automaticAttempt && refill.pending === payment.automaticAttempt) this.saveRefill({ ...refill, pending: null });
      return { applied: delta };
    });
  }
  configure(settings: RefillSettings, customerId: string | null) {
    const input = refillSettingsSchema.parse(settings);
    return this.storage.transactionSync(() => {
      const current = this.refill();
      if (input.enabled && (!customerId || current.pending)) throw new Error("A saved card is required and no refill may be pending.");
      this.saveRefill({ ...current, ...input, customerId: customerId ?? current.customerId, error: null });
    });
  }
  beginRefill(plan: AgentCreditAccess, now = new Date()) {
    if (typeof plan !== "string") return null;
    return this.storage.transactionSync(() => {
      this.refresh(now);
      const refill = this.refill();
      const held = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM reservations WHERE bucket = 'purchased' OR month = ?", monthAt(now)).one().count;
      // A failed call must not trigger a purchase merely by temporarily holding credits.
      if (!refill.enabled || !refill.customerId || refill.pending || this.snapshot(plan, now).available + held > 50) return null;
      const month = monthAt(now);
      const count = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM refill_attempts WHERE month = ?", month).one().count;
      if (count >= refill.maxPacksPerMonth) return null;
      const attempt = { id: crypto.randomUUID(), month, customer: refill.customerId, currency: refill.currency };
      this.storage.sql.exec("INSERT INTO refill_attempts (id, month, customer, currency) VALUES (?, ?, ?, ?)", attempt.id, month, attempt.customer, attempt.currency);
      this.saveRefill({ ...refill, pending: attempt.id });
      return attempt;
    });
  }
  recordRefillOrder(attempt: string, orderId: string) { this.storage.sql.exec("UPDATE refill_attempts SET order_id = ? WHERE id = ?", orderId, attempt); }
  pauseRefill(attempt: string, uncertain: boolean) {
    const refill = this.refill();
    if (refill.pending === attempt) this.saveRefill({ ...refill, enabled: false, pending: uncertain ? attempt : null, error: uncertain ? "Payment confirmation is pending. Auto-refill is paused to prevent duplicate charges." : "Auto-refill failed. Check your saved payment method, then enable it again." });
  }
}
export type AgentCreditStatus = ReturnType<AgentCreditAccount["status"]>;
export type AgentCreditReservation = ReturnType<AgentCreditAccount["reserve"]>;
export interface AgentCreditService {
  status(plan: AgentCreditAccess): Promise<AgentCreditStatus>;
  reserve(plan: AgentCreditAccess): Promise<AgentCreditReservation>;
  settle(id: string, successful: boolean, plan: AgentCreditAccess): Promise<boolean>;
  configure(settings: RefillSettings, email: string): Promise<void>;
  applyPayment(input: CreditPayment): Promise<{ applied: number }>;
}
