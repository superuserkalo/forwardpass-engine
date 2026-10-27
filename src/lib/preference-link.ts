import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const payloadSchema = z.object({ email: z.email(), expires: z.number().int() });

export function preferencesLink(email: string, now = Date.now()): string {
  const secret = process.env.PREFERENCES_SIGNING_SECRET;
  if (!secret || secret.length < 32) throw new Error("PREFERENCES_SIGNING_SECRET is not configured.");
  const payload = Buffer.from(JSON.stringify({ email, expires: now + 30 * 86_400_000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`preferences:${payload}`).digest("base64url");
  const origin = process.env.PUBLIC_SITE_URL ?? "https://theforwardpass.net";
  return new URL(`/preferences/open#token=${encodeURIComponent(`${payload}.${signature}`)}`, origin).toString();
}

export function verifyPreferencesToken(token: string, now = Date.now()): string | null {
  const secret = process.env.PREFERENCES_SIGNING_SECRET;
  if (!secret || secret.length < 32) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || payload.length > 2048) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(`preferences:${payload}`).digest("base64url"));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const value = payloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return value.expires > now ? value.email : null;
  } catch {
    return null;
  }
}
