import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { agentCreditAccountId, creditPaymentSchema, type AgentCreditService } from "../lib/agent-credits.js";
import { boundedText } from "../lib/request-body.js";

/** Internal, signed payment reconciliation. Human sessions and agent keys cannot grant credits. */
export async function handleAgentCreditPayment(request: Request, credits: (account: string) => AgentCreditService): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const signature = request.headers.get("x-forwardpass-signature") ?? "";
  const timestamp = request.headers.get("x-forwardpass-timestamp") ?? "";
  const secret = process.env.PREFERENCES_SIGNING_SECRET;
  if (!secret || secret.length < 32 || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300_000 || !/^[a-f0-9]{64}$/.test(signature)) return json({ error: "Unauthorized." }, 401);
  // The caller is authenticated only after the bounded body has been signed and verified.
  let text: string;
  try { text = await boundedText(request, 4096); }
  catch { return json({ error: "Body too large." }, 413); }
  const expected = createHmac("sha256", secret).update(`agent-credit-payment:${timestamp}:${text}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return json({ error: "Unauthorized." }, 401);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return json({ error: "Invalid JSON." }, 400); }
  const parsed = creditPaymentSchema.safeParse(value);
  if (!parsed.success) return json({ error: "Invalid payment." }, 400);
  const configuredProduct = z.uuid().safeParse(process.env.POLAR_PRODUCT_AGENT_CREDITS);
  if (!configuredProduct.success || parsed.data.productId !== configuredProduct.data) return json({ error: "Unknown credit product." }, 400);
  try { return json(await credits(agentCreditAccountId(parsed.data.email)).applyPayment(parsed.data)); }
  catch { return json({ error: "Credit reconciliation unavailable." }, 503); }
}
