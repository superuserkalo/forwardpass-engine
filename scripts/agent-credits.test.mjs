import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { creditAccount, memoryCredits } from "./agent-credit-test-support.mjs";
import { handleAgentCreditPayment } from "../src/api/agent-credit-payment.ts";
import { agentCreditAccountId } from "../src/lib/agent-credits.ts";

const OCTOBER = new Date("2026-10-03T12:00:00Z");
const NOVEMBER = new Date("2026-11-01T00:00:00Z");
const UUID = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const payment = (input = {}) => ({ orderId: UUID, customerId: UUID, productId: PRODUCT, email: "reader@example.test", paid: true, netAmount: 500, refundedAmount: 0, currency: "usd", automaticAttempt: null, ...input });

test("credit identity survives credential rotation and email case changes", () => {
  const previous = process.env.PREFERENCES_SIGNING_SECRET;
  const id = agentCreditAccountId("reader@example.test");
  try {
    process.env.PREFERENCES_SIGNING_SECRET = "rotated-secret";
    assert.equal(agentCreditAccountId("READER@example.test"), id);
  } finally {
    if (previous === undefined) delete process.env.PREFERENCES_SIGNING_SECRET;
    else process.env.PREFERENCES_SIGNING_SECRET = previous;
  }
});

test("credits reserve exactly once under concurrent calls, refund failures and recover abandoned calls", async () => {
  const account = creditAccount();
  const calls = await Promise.all(Array.from({ length: 520 }, async () => account.reserve("personal", OCTOBER)));
  assert.equal(calls.filter(call => call.reservation).length, 500);
  assert.equal(account.status("personal", OCTOBER).available, 0);
  assert.equal(account.settle(calls[0].reservation, false, OCTOBER), true);
  assert.equal(account.settle(calls[0].reservation, false, OCTOBER), false);
  assert.equal(account.status("personal", OCTOBER).available, 1);
  for (const call of calls.slice(1)) if (call.reservation) account.settle(call.reservation, true, OCTOBER);
  const pending = account.reserve("personal", OCTOBER);
  const later = new Date(OCTOBER.getTime() + 300_001);
  assert.equal(account.status("personal", later).available, 1);
  assert.equal(account.settle(pending.reservation, true, later), false);
});

test("monthly allowances reset independently of subscription cadence and tier changes preserve usage", () => {
  const account = creditAccount();
  for (let index = 0; index < 100; index++) account.settle(account.reserve("personal", OCTOBER).reservation, true, OCTOBER);
  assert.equal(account.status("personal", OCTOBER).available, 400);
  assert.equal(account.status("professional", OCTOBER).available, 2400);
  assert.equal(account.status("personal", OCTOBER).available, 400);
  assert.equal(account.status("professional", OCTOBER).available, 2400);
  account.applyPayment(payment());
  assert.equal(account.status("personal", NOVEMBER).available, 1500);
  assert.equal(account.status("personal", NOVEMBER).resetsAt, "2026-12-01T00:00:00.000Z");
});

test("purchased credits are used after included credits and refunds are cumulative and idempotent", () => {
  const account = creditAccount();
  account.applyPayment(payment());
  account.applyPayment(payment());
  assert.equal(account.status("personal", OCTOBER).purchasedRemaining, 1000);
  for (let index = 0; index < 510; index++) account.settle(account.reserve("personal", OCTOBER).reservation, true, OCTOBER);
  assert.equal(account.status("personal", OCTOBER).purchasedRemaining, 990);
  account.applyPayment(payment({ refundedAmount: 250 }));
  account.applyPayment(payment({ refundedAmount: 250 }));
  account.applyPayment(payment());
  assert.equal(account.status("personal", OCTOBER).purchasedRemaining, 490);
  account.applyPayment(payment({ refundedAmount: 500 }));
  assert.equal(account.status("personal", OCTOBER).purchasedRemaining, -10);
  assert.equal(account.reserve("personal", OCTOBER).reservation, null);
  const outOfOrder = creditAccount();
  outOfOrder.applyPayment(payment({ paid: false, refundedAmount: 500 }));
  outOfOrder.applyPayment(payment());
  assert.equal(outOfOrder.status("personal", OCTOBER).purchasedRemaining, 0);
});

test("auto-refill requires explicit consent, prevents overlapping charges and enforces a monthly pack cap", () => {
  const account = creditAccount();
  for (let index = 0; index < 451; index++) account.settle(account.reserve("personal", OCTOBER).reservation, true, OCTOBER);
  assert.equal(account.beginRefill("personal", OCTOBER), null);
  assert.throws(() => account.configure({ enabled: true, currency: "usd", maxPacksPerMonth: 1 }, null));
  account.configure({ enabled: true, currency: "usd", maxPacksPerMonth: 1 }, UUID);
  const attempt = account.beginRefill("personal", OCTOBER);
  assert.ok(attempt);
  assert.equal(account.beginRefill("personal", OCTOBER), null);
  account.applyPayment(payment({ automaticAttempt: attempt.id }));
  for (let index = 0; index < 1000; index++) account.settle(account.reserve("personal", OCTOBER).reservation, true, OCTOBER);
  assert.equal(account.beginRefill("personal", OCTOBER), null);
  assert.equal(account.status("personal", OCTOBER).autoRefill.automaticPacks, 1);
  account.configure({ enabled: false, currency: "usd", maxPacksPerMonth: 1 }, null);
  assert.equal(account.beginRefill("personal", OCTOBER), null);
});

test("ambiguous auto-refill payments pause charging until a paid webhook reconciles the pending attempt", () => {
  const account = creditAccount();
  for (let index = 0; index < 451; index++) account.settle(account.reserve("personal", OCTOBER).reservation, true, OCTOBER);
  account.configure({ enabled: true, currency: "eur", maxPacksPerMonth: 2 }, UUID);
  const attempt = account.beginRefill("personal", OCTOBER);
  account.pauseRefill(attempt.id, true);
  assert.equal(account.status("personal", OCTOBER).autoRefill.enabled, false);
  assert.equal(account.status("personal", OCTOBER).autoRefill.pending, true);
  assert.equal(account.beginRefill("personal", OCTOBER), null);
  assert.throws(() => account.configure({ enabled: true, currency: "eur", maxPacksPerMonth: 2 }, UUID));
  account.applyPayment(payment({ currency: "eur", automaticAttempt: attempt.id }));
  assert.equal(account.status("personal", OCTOBER).autoRefill.pending, false);
});

test("pending and failed calls cannot trigger auto-refill through temporary credit holds", () => {
  const account = creditAccount();
  account.configure({ enabled: true, currency: "usd", maxPacksPerMonth: 2 }, UUID);
  const held = Array.from({ length: 451 }, () => account.reserve("personal", OCTOBER));
  assert.equal(account.status("personal", OCTOBER).available, 49);
  assert.equal(account.beginRefill("personal", OCTOBER), null);
  for (const call of held) account.settle(call.reservation, false, OCTOBER);
  assert.equal(account.status("personal", OCTOBER).available, 500);
  assert.equal(account.beginRefill("personal", OCTOBER), null);
});

test("only signed canonical credit payments can grant credits, and delivery retries cannot grant twice", async () => {
  process.env.PREFERENCES_SIGNING_SECRET = "credit-tests-only-secret".repeat(3);
  process.env.POLAR_PRODUCT_AGENT_CREDITS = PRODUCT;
  const credits = memoryCredits();
  const body = JSON.stringify(payment());
  const timestamp = Date.now().toString();
  const sign = (text) => createHmac("sha256", process.env.PREFERENCES_SIGNING_SECRET).update(`agent-credit-payment:${timestamp}:${text}`).digest("hex");
  const request = (text = body, signature = sign(text), at = timestamp) => new Request("https://worker.example/agent-credit-payment", { method: "POST", body: text, headers: { "x-forwardpass-signature": signature, "x-forwardpass-timestamp": at } });
  assert.equal((await handleAgentCreditPayment(request(body, "0".repeat(64)), credits)).status, 401);
  assert.equal((await handleAgentCreditPayment(request(body, sign(body), "1000000000000"), credits)).status, 401);
  assert.equal((await handleAgentCreditPayment(request(JSON.stringify(payment({ productId: UUID }))), credits)).status, 400);
  assert.equal((await handleAgentCreditPayment(request("{broken"), credits)).status, 400);
  assert.equal((await handleAgentCreditPayment(request("x".repeat(5000)), credits)).status, 413);
  assert.equal((await handleAgentCreditPayment(request(), credits)).status, 200);
  assert.deepEqual(await (await handleAgentCreditPayment(request(), credits)).json(), { applied: 0 });
});

test("Personal trial grants 500 free credits total across months and preserves a separate paid allowance", async () => {
  const account = creditAccount();
  const trial = { plan: "personal", trialEndsAt: "2026-11-10T12:00:00.000Z" };
  account.applyPayment(payment());
  account.configure({ enabled: true, currency: "usd", maxPacksPerMonth: 2 }, UUID);
  for (let i = 0; i < 490; i++) account.settle(account.reserve(trial, OCTOBER).reservation, true, OCTOBER, trial);
  assert.equal(account.status(trial, NOVEMBER).available, 10);
  assert.equal(account.status(trial, NOVEMBER).purchasedRemaining, 0);
  assert.equal(account.status(trial, NOVEMBER).autoRefill.enabled, false);
  assert.equal(account.beginRefill(trial, NOVEMBER), null);
  const calls = await Promise.all(Array.from({ length: 20 }, async () => account.reserve(trial, NOVEMBER)));
  assert.equal(calls.filter(call => call.reservation).length, 10);
  for (const call of calls) if (call.reservation) account.settle(call.reservation, true, NOVEMBER, trial);
  assert.equal(account.reserve(trial, NOVEMBER).reservation, null);
  assert.equal(account.status({ ...trial, trialEndsAt: "2026-11-11T12:00:00.000Z" }, NOVEMBER).available, 0);
  assert.equal(account.status("personal", NOVEMBER).available, 1500);
});

test("trial failures refund credits; expired trials cannot reserve or settle successful work", () => {
  const account = creditAccount();
  const trial = { plan: "personal", trialEndsAt: "2026-10-03T12:00:01.000Z" };
  const failed = account.reserve(trial, OCTOBER);
  assert.equal(account.settle(failed.reservation, false, OCTOBER, trial), true);
  assert.equal(account.status(trial, OCTOBER).available, 500);
  const held = account.reserve(trial, OCTOBER);
  const expired = new Date("2026-10-03T12:00:02.000Z");
  assert.equal(account.status(trial, expired).available, 0);
  assert.equal(account.reserve(trial, expired).reservation, null);
  assert.equal(account.settle(held.reservation, true, expired, trial), false);
  assert.equal(account.status(trial, OCTOBER).available, 500);
});
