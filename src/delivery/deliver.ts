import { createHash } from "node:crypto";
import { Resend } from "resend";
import { z } from "zod";
import { loadIssue, type IssueV2 } from "../lib/issue.js";
import { preferencesLink } from "../lib/preference-link.js";
import { createPrivateJson, readPrivateJson, writePrivateJson } from "../lib/private-store.js";
import { CONTENT_TYPES, readerFromProperties, type ReaderProfile } from "../lib/reader-profile.js";
import { compileBrief, poolItemSchema, selectForReader, type Brief, type PoolItem } from "../pipeline/personal.js";
import { IO_STEP, type Steps } from "../pipeline/steps.js";
import { renderIssueEmail } from "./email.js";
import { renderPersonalEmail } from "./personal-email.js";

// Delivery of a saved issue. The ledger is main's: a create-only attempt claim before every
// send, sent/skipped/failed markers, a Resend idempotency key per date and recipient, and a
// consent re-check at send time. New: the audience is staged page by page, and an attempt
// with no recorded outcome is resent with the same idempotency key while Resend still
// deduplicates it (24 hours), so an interrupted send neither duplicates nor drops a reader.
//
// A reader who pays and has a reading profile gets their own edition, chosen from what was already verified (src/pipeline/personal.ts),
// when the owner has turned personal editions on. Everyone else gets the shared issue, and so does any reader whose edition cannot be
// built for any reason: building an edition can never stop a send.

export const NEWSLETTER_TOPIC = "418f8071-0c80-4e3f-a076-b21ccfd40318";
const PAGE_SIZE = 100;
const IDEMPOTENCY_WINDOW_MS = 23 * 3_600_000;
export const delivery = {
  pauseMs: 600,
  /** How long to wait to try again when Resend says the rate was exceeded and does not say when to come back; doubled each time. */
  retryMs: 1000,
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;

type Answer = { error: { name?: string } | null; headers?: Record<string, string> | null };
/**
 * A Resend call, tried again after the time Resend asks for when it says the rate was exceeded, up to three more times. A quota is not a
 * rate and is not waited out. Every call it wraps is safe to repeat: a read, or a send whose idempotency key makes a second one the first.
 */
async function withRetry<T extends Answer>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const answer = await call();
    if (answer.error?.name !== "rate_limit_exceeded" || attempt >= RATE_LIMIT_RETRIES) return answer;
    const asked = Number(answer.headers?.["retry-after"]);
    await delivery.sleep(Math.min(MAX_RETRY_WAIT_MS, asked >= 0 ? asked * 1000 : delivery.retryMs * 2 ** attempt));
  }
}

/** A reading profile for a preview, with what a reader's profile fills in left out: all four content types, and a briefing. */
export type PreviewProfile = { firstName?: string | null; topics: ReaderProfile["topics"]; content?: ReaderProfile["content"]; format?: ReaderProfile["format"]; notes?: string };
export type DeliveryJob = {
  date: string;
  test?: string[];
  /** With `test`: send the preview as the own edition a reader with this profile would get, instead of the shared issue. */
  profile?: PreviewProfile;
};
export type DeliveryResult = { date: string; recipients: number; sent: number; alreadySent: number; skipped: number; failed: number; needsReconciliation: number; personal: number };
export type DeliveryDeps = {
  /** Personal editions. Without it every reader gets the shared issue. */
  personal?: {
    /** What the editions are chosen from, built once for the run. */
    pool: (issue: IssueV2, now: Date) => Promise<PoolItem[]>;
    /** What a reader's note compiles to; the default is the cached model call. */
    brief?: (notes: string) => Promise<Brief>;
    now?: () => Date;
  };
};
type PersonalRun = { pool: PoolItem[]; brief: (notes: string) => Promise<Brief>; now: () => Date };

const recipientSchema = z.object({ contactId: z.string().nullable(), email: z.email(), firstName: z.string().nullable() });
type Recipient = z.infer<typeof recipientSchema>;
const pageSchema = z.object({ recipients: z.array(recipientSchema), next: z.string().nullable() });

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ledgerKey = (date: string, email: string, marker: "attempt" | "sent" | "skipped" | "failed") => `delivery/${date}/recipients/${hash(email.toLowerCase())}/${marker}.json`;
const poolKey = (date: string) => `delivery/${date}/pool.json`;

export function resend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured.");
  return new Resend(key);
}

async function optedIn(client: Resend, email: string): Promise<boolean> {
  const { data, error } = await withRetry(() => client.contacts.topics.list({ email }));
  if (error || !data) throw new Error(`Could not check newsletter preference: ${error?.message ?? "empty response"}`);
  return data.data.some((topic) => topic.id === NEWSLETTER_TOPIC && topic.subscription === "opt_in");
}

async function stagePage(client: Resend, date: string, page: number, after: string | null): Promise<{ count: number; next: string | null }> {
  const key = `delivery/${date}/audience/${String(page).padStart(4, "0")}.json`;
  const saved = await readPrivateJson(key);
  if (saved !== null) { const parsed = pageSchema.parse(saved); return { count: parsed.recipients.length, next: parsed.next }; }
  const segmentId = process.env.RESEND_SEGMENT_ID;
  if (!segmentId) throw new Error("RESEND_SEGMENT_ID is not configured.");
  const { data, error } = await withRetry(() => client.contacts.list({ segmentId, limit: PAGE_SIZE, ...(after ? { after } : {}) }));
  if (error || !data) throw new Error(`Could not list newsletter contacts: ${error?.message ?? "empty response"}`);
  const recipients: Recipient[] = [];
  for (const contact of data.data) {
    if (contact.unsubscribed) continue;
    const email = contact.email.trim().toLowerCase();
    if (!await optedIn(client, email)) continue;
    recipients.push({ contactId: contact.id, email, firstName: contact.first_name ?? null });
  }
  const next = data.has_more ? data.data.at(-1)?.id ?? null : null;
  await createPrivateJson(key, { recipients, next });
  return { count: recipients.length, next };
}

export type Outcome = "sent" | "alreadySent" | "skipped" | "failed" | "needsReconciliation";
export type Edition = "personal" | "shared";
export type Rendered = { subject: string; html: string; text: string };
type Properties = Record<string, { value?: unknown } | undefined> | undefined;
export type Counts = Record<Outcome, number> & { personal: number };
type Composed = { rendered: Rendered; edition: Edition; fallback?: string } | null;

/** What differs between the daily issue, the weekly research and a preview: where it is recorded, what it is called, and what each reader gets. */
export type Channel = {
  kind: "daily" | "weekly" | "weekly-compute" | "test";
  /** The date in the email's idempotency key. */
  date: string;
  /** Where the ledger is kept and the audience staged: the date, or weekly-<date>, so two kinds on one day never share a record. */
  scope: string;
  /** What this reader gets, or null when this channel is not for them (the weekly research is not for a free reader). Nothing is recorded for a reader it is not for. */
  compose: (recipient: Recipient, properties: Properties, unsubscribeUrl: string) => Promise<Composed> | Composed;
};

export async function sendEmail(client: Resend, channel: Channel, recipient: Recipient): Promise<{ outcome: Outcome; edition: Edition }> {
  const { kind, date, scope } = channel;
  const email = recipient.email;
  let properties: Properties;
  if (kind !== "test") {
    if (await readPrivateJson(ledgerKey(scope, email, "sent"))) return { outcome: "alreadySent", edition: "shared" };
    if (await readPrivateJson(ledgerKey(scope, email, "skipped"))) return { outcome: "skipped", edition: "shared" };
    // Consent is rechecked immediately before sending.
    const detail = recipient.contactId ? await withRetry(() => client.contacts.get({ id: recipient.contactId as string })) : null;
    if (detail && (detail.error || !detail.data)) throw new Error(`Could not recheck contact: ${detail.error?.message ?? "empty response"}`);
    if (detail?.data && (detail.data.unsubscribed || detail.data.email.trim().toLowerCase() !== email || !await optedIn(client, email))) {
      await createPrivateJson(ledgerKey(scope, email, "skipped"), { reason: "consent_changed", at: new Date().toISOString() });
      return { outcome: "skipped", edition: "shared" };
    }
    properties = detail?.data?.properties;
  }
  const unsubscribeUrl = `https://theforwardpass.net/unsubscribe?email=${encodeURIComponent(email)}`;
  const composed = await channel.compose(recipient, properties, unsubscribeUrl);
  if (!composed) return { outcome: "skipped", edition: "shared" };
  const { rendered, edition, fallback } = composed;
  if (kind !== "test") {
    const attemptKey = ledgerKey(scope, email, "attempt");
    if (!await createPrivateJson(attemptKey, { at: new Date().toISOString() })) {
      // An earlier attempt has no recorded outcome. Within Resend's idempotency window the same key
      // returns the original email instead of sending a second one, so resending is safe.
      const attempt = z.object({ at: z.iso.datetime() }).parse(await readPrivateJson(attemptKey));
      if (Date.now() - Date.parse(attempt.at) > IDEMPOTENCY_WINDOW_MS) return { outcome: "needsReconciliation", edition: "shared" };
    }
  }
  const from = process.env.NEWSLETTER_FROM;
  if (!from) throw new Error("NEWSLETTER_FROM is not configured.");
  const { data, error } = await withRetry(() => client.emails.send({
    from, to: [email], replyTo: process.env.NEWSLETTER_REPLY_TO || undefined, subject: kind === "test" ? `[Preview] ${rendered.subject}` : rendered.subject, html: rendered.html, text: rendered.text,
    // Machine-readable marking of AI-generated content, EU AI Act Article 50(2).
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-AI-Generated": "true" },
  }, { idempotencyKey: kind === "test" ? `forwardpass/test/${date}/${hash(email + rendered.html)}` : `forwardpass/${kind}/${date}/${hash(email)}` }));
  if (kind === "test") { if (error || !data) throw new Error(`Test send failed: ${error?.message ?? "empty response"}`); return { outcome: "sent", edition }; }
  if (error || !data) {
    await writePrivateJson(ledgerKey(scope, email, "failed"), { at: new Date().toISOString(), error: error?.message ?? "empty response" });
    return { outcome: "failed", edition };
  }
  await createPrivateJson(ledgerKey(scope, email, "sent"), { at: new Date().toISOString(), resendEmailId: data.id, edition, ...(fallback ? { fallback } : {}) });
  return { outcome: "sent", edition };
}

/**
 * The audience of a send, staged page by page and sent page by page. A page is listed once and kept, so a retry sends to the same readers
 * and the ledger decides who already has it. `sender` is made fresh for each page, since a page may be sent by a later attempt.
 */
export async function runAudience(steps: Steps, client: Resend, scope: string, sender: () => Promise<(recipient: Recipient) => Promise<{ outcome: Outcome; edition: Edition }>>): Promise<Counts & { recipients: number }> {
  const totals: Counts & { recipients: number } = { recipients: 0, sent: 0, alreadySent: 0, skipped: 0, failed: 0, needsReconciliation: 0, personal: 0 };
  let after: string | null = null;
  for (let page = 0; ; page++) {
    const staged: { count: number; next: string | null } = await steps.run(`audience-${page}`, IO_STEP, () => stagePage(client, scope, page, after));
    const counts: Counts = await steps.run(`send-${page}`, IO_STEP, async () => {
      const { recipients } = pageSchema.parse(await readPrivateJson(`delivery/${scope}/audience/${String(page).padStart(4, "0")}.json`));
      const result: Counts = { sent: 0, alreadySent: 0, skipped: 0, failed: 0, needsReconciliation: 0, personal: 0 };
      const send = await sender();
      for (const recipient of recipients) {
        const { outcome, edition } = await send(recipient);
        result[outcome]++;
        if (outcome === "sent" && edition === "personal") result.personal++;
        if (outcome === "sent" || outcome === "failed") await delivery.sleep(delivery.pauseMs);
      }
      return result;
    });
    totals.recipients += staged.count;
    for (const [outcome, count] of Object.entries(counts) as [keyof Counts, number][]) totals[outcome] += count;
    if (!staged.next) break;
    after = staged.next;
  }
  return totals;
}

/** The daily issue: a paying reader's own edition when personal editions are on and one can be built, the shared issue otherwise. */
function dailyChannel(issue: IssueV2, personal?: PersonalRun): Channel {
  const { date } = issue;
  return {
    kind: "daily", date, scope: date,
    compose: (recipient, properties, unsubscribeUrl) => composeDaily(issue, recipient, properties, unsubscribeUrl, personal),
  };
}

async function composeDaily(issue: IssueV2, recipient: Recipient, properties: Properties, unsubscribeUrl: string, personal?: PersonalRun): Promise<Composed> {
  const { date } = issue;
  let fallback: string | undefined;
  if (personal) {
    try {
      const reader = readerFromProperties(properties);
      if (reader.tier !== "free" && reader.profile) {
        const now = personal.now();
        const built = selectForReader(personal.pool, reader.profile, await personal.brief(reader.profile.notes), now);
        if (built) return { edition: "personal", rendered: renderPersonalEmail(built, { date, now, firstName: reader.profile.firstName ?? recipient.firstName, unsubscribeUrl, preferencesUrl: preferencesLink(recipient.email) }) };
      }
    } catch (error) {
      // An edition that cannot be built is the shared issue, never a missing email.
      fallback = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      console.warn("forwardpass.personal_edition_failed", JSON.stringify({ date, error: fallback }));
    }
  }
  return { edition: "shared", rendered: renderIssueEmail(issue, { firstName: recipient.firstName, unsubscribeUrl, preferencesUrl: preferencesLink(recipient.email) }), ...(fallback ? { fallback } : {}) };
}

/** A preview: the shared issue, sent to an address that is not in the audience, with no ledger. */
const issuePreview = (issue: IssueV2): Channel => ({
  kind: "test", date: issue.date, scope: issue.date,
  compose: (recipient, _properties, unsubscribeUrl) => ({ edition: "shared", rendered: renderIssueEmail(issue, { firstName: recipient.firstName, unsubscribeUrl, preferencesUrl: null }) }),
});

/** A reader's own edition for a profile that is not a reader's, built as it would be for them and sent to the addresses given. */
async function personalPreview(issue: IssueV2, preview: PreviewProfile, personal: DeliveryDeps["personal"]): Promise<Channel> {
  if (!personal) throw new Error("A personal preview needs the pool an edition is chosen from.");
  const profile: ReaderProfile = { firstName: preview.firstName ?? null, topics: preview.topics, content: preview.content?.length ? preview.content : [...CONTENT_TYPES], format: preview.format ?? "Briefing", notes: preview.notes ?? "" };
  const now = (personal.now ?? (() => new Date()))();
  const built = selectForReader(await personal.pool(issue, now), profile, await (personal.brief ?? ((notes) => compileBrief(notes)))(profile.notes), now);
  if (!built) throw new Error("That profile matches nothing in today's pool.");
  return {
    kind: "test", date: issue.date, scope: issue.date,
    compose: (_recipient, _properties, unsubscribeUrl) => ({ edition: "personal", rendered: renderPersonalEmail(built, { date: issue.date, now, firstName: profile.firstName, unsubscribeUrl, preferencesUrl: null }) }),
  };
}

/** A preview of any kind of send, to addresses that are not in the audience and with no ledger. The channel is built inside the step, from what is saved then. */
export async function sendPreview(steps: Steps, client: Resend, addresses: string[], channel: () => Promise<Channel>): Promise<number> {
  return steps.run(`test-${hash(addresses.join(",")).slice(0, 12)}`, IO_STEP, async () => {
    const built = await channel();
    for (const email of addresses) await sendEmail(client, built, { contactId: null, email, firstName: null });
    return addresses.length;
  });
}

export async function deliverIssue(steps: Steps, job: DeliveryJob, client: Resend = resend(), deps: DeliveryDeps = {}): Promise<DeliveryResult> {
  const { date } = job;
  const issue = await steps.run("issue", IO_STEP, async () => {
    const saved = await loadIssue(date);
    if (!saved || saved.version !== 2) throw new Error(`No v2 issue saved for ${date}.`);
    return { subject: saved.subject, stories: saved.stories.length };
  });
  const totals: DeliveryResult = { date, recipients: 0, sent: 0, alreadySent: 0, skipped: 0, failed: 0, needsReconciliation: 0, personal: 0 };
  const load = async () => { const saved = await loadIssue(date); if (!saved || saved.version !== 2) throw new Error("Issue disappeared"); return saved; };

  if (job.test?.length) {
    await sendPreview(steps, client, job.test, async () => job.profile ? personalPreview(await load(), job.profile, deps.personal) : issuePreview(await load()));
    return { ...totals, recipients: job.test.length, sent: job.test.length };
  }

  // The pool the editions are chosen from is built once and kept with the delivery, so every page reads the same one. Without a pool every
  // reader gets the shared issue, and so does every reader if it cannot be built.
  const pooled = deps.personal ? await steps.run("pool", IO_STEP, async () => {
    try {
      const pool = await deps.personal!.pool(await load(), (deps.personal!.now ?? (() => new Date()))());
      await writePrivateJson(poolKey(date), pool);
      return pool.length;
    } catch (error) {
      console.warn("forwardpass.personal_pool_failed", JSON.stringify({ date, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }));
      return 0;
    }
  }) : 0;

  Object.assign(totals, await runAudience(steps, client, date, async () => {
    const saved = await load();
    const personal: PersonalRun | undefined = pooled > 0 && deps.personal
      ? { pool: z.array(poolItemSchema).parse(await readPrivateJson(poolKey(date))), brief: deps.personal.brief ?? ((notes) => compileBrief(notes)), now: deps.personal.now ?? (() => new Date()) } : undefined;
    const channel = dailyChannel(saved, personal);
    return (recipient) => sendEmail(client, channel, recipient);
  }));
  await steps.run("status", IO_STEP, async () => {
    await writePrivateJson(`delivery/${date}/status.json`, { ...totals, subject: issue.subject, completedAt: new Date().toISOString() });
    console.info("forwardpass.delivery", JSON.stringify(totals));
    return true;
  });
  return totals;
}
