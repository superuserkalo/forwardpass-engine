import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { AgentCreditAccount, AGENT_CREDIT_PACK, creditPaymentSchema, type AgentCreditAccess, type CreditPayment, type RefillSettings } from "./lib/agent-credits.js";

export interface AgentCreditEnv {
  POLAR_ACCESS_TOKEN?: string;
  POLAR_PRODUCT_AGENT_CREDITS?: string;
  POLAR_OFF_SESSION_ENABLED?: string;
  POLAR_ENVIRONMENT?: string;
}
const customerSchema = z.object({ id: z.uuid(), email: z.email(), default_payment_method_id: z.string().nullable().optional() });
const orderSchema = z.object({
  id: z.uuid(), customer_id: z.uuid(), product_id: z.uuid(), paid: z.boolean(),
  net_amount: z.number().int().positive(), refunded_amount: z.number().int().min(0), currency: z.enum(["usd", "eur"]),
  customer: z.object({ email: z.email() }),
});
class CreditBillingError extends Error {
  constructor(readonly status: number) { super("Credit payment unavailable."); }
}

async function polar(env: AgentCreditEnv, path: string, body?: Record<string, unknown>): Promise<unknown> {
  if (!env.POLAR_ACCESS_TOKEN) throw new Error("Credit billing is not configured.");
  const base = env.POLAR_ENVIRONMENT === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";
  const response = await fetch(`${base}/v1/${path}`, {
    method: body ? "POST" : "GET", signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new CreditBillingError(response.status);
  return response.json();
}

export class AgentCreditLedger extends DurableObject<AgentCreditEnv> {
  private readonly account: AgentCreditAccount;
  constructor(ctx: DurableObjectState, env: AgentCreditEnv) {
    super(ctx, env);
    this.account = new AgentCreditAccount(ctx.storage);
  }
  async status(plan: AgentCreditAccess) { return this.account.status(plan); }
  async settle(id: string, successful: boolean, plan: AgentCreditAccess) {
    const settled = this.account.settle(id, successful, new Date(), plan);
    if (settled && successful) this.ctx.waitUntil(this.refill(plan));
    return settled;
  }
  async applyPayment(input: CreditPayment) { return this.account.applyPayment(input); }
  async configure(settings: RefillSettings, email: string) {
    if (!settings.enabled) { this.account.configure(settings, null); return; }
    if (this.env.POLAR_OFF_SESSION_ENABLED !== "true" || !this.env.POLAR_PRODUCT_AGENT_CREDITS) throw new Error("Auto-refill is not enabled for this billing account.");
    const customer = customerSchema.parse(await polar(this.env, `customers/external/${encodeURIComponent(email)}/state`));
    if (customer.email.toLowerCase() !== email.toLowerCase() || !customer.default_payment_method_id) throw new Error("Add a saved payment method in Polar first.");
    this.account.configure(settings, customer.id);
  }
  async reserve(plan: AgentCreditAccess) {
    let result = this.account.reserve(plan);
    if (!result.reservation) { await this.refill(plan); result = this.account.reserve(plan); }
    return result;
  }
  private async refill(plan: AgentCreditAccess) {
    if (this.env.POLAR_OFF_SESSION_ENABLED !== "true" || !this.env.POLAR_PRODUCT_AGENT_CREDITS) return;
    const attempt = this.account.beginRefill(plan);
    if (!attempt) return;
    let orderId: string | null = null;
    try {
      const currency = z.enum(["usd", "eur"]).parse(attempt.currency);
      const order = orderSchema.parse(await polar(this.env, "orders/", {
        customer_id: attempt.customer, product_id: this.env.POLAR_PRODUCT_AGENT_CREDITS,
        amount: AGENT_CREDIT_PACK[currency], currency,
        metadata: { forwardpass_agent_refill: attempt.id },
      }));
      orderId = order.id;
      this.account.recordRefillOrder(attempt.id, order.id);
      const paid = orderSchema.parse(await polar(this.env, `orders/${order.id}/finalize`, {}));
      if (!paid.paid || paid.customer_id !== attempt.customer || paid.product_id !== this.env.POLAR_PRODUCT_AGENT_CREDITS) throw new Error("Payment not confirmed.");
      this.account.applyPayment(creditPaymentSchema.parse({ orderId: paid.id, email: paid.customer.email, customerId: paid.customer_id, productId: paid.product_id, paid: paid.paid, netAmount: paid.net_amount, refundedAmount: paid.refunded_amount, currency: paid.currency, automaticAttempt: attempt.id }));
    } catch (error) {
      // Never retry an ambiguous payment. Its paid webhook reconciles the same order exactly once.
      const declined = error instanceof CreditBillingError && error.status >= 400 && error.status < 500 && error.status !== 412;
      this.account.pauseRefill(attempt.id, orderId !== null && !declined);
    }
  }
}
