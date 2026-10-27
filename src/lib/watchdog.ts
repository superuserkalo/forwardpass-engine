import { z } from "zod";
import { listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "./private-store.js";

// On 8 and 9 October no issue was written and nobody was told: the owner found out from the missing email. The pipeline leaves a record of
// every step in storage (the collection's snapshots, the stored issue, its published marker, the status of its delivery), so whether it
// ran can be read back from there, without asking the workflows. A problem is emailed once a day.

export type Finding = {
  key: "collection-stalled" | "issue-missing" | "delivery-missing" | "delivery-failed" | "gateway-credits-low";
  /** Short enough for a subject line. */
  title: string;
  /** What is wrong, where to look, and how to run it again. */
  detail: string;
};
/** Sends the message; hands back the id the mail service gave it. */
export type Alert = (subject: string, text: string) => Promise<string | undefined>;
export type WatchdogResult = { date: string; findings: Finding[]; alerted: Finding[]; error?: string };

const HOUR = 3_600_000;
/** The collection runs every two hours: a snapshot more than five hours old means at least two runs failed. */
const STALE_AFTER = 5 * HOUR;
/** The issue workflow starts at 05:30 UTC and takes about ten minutes; delivery starts once it is published. */
const ISSUE_DUE = "06:30:00Z";
const DELIVERY_DUE = "07:30:00Z";
const SNAPSHOT = /^collection\/runs\/(\d{4}-\d{2}-\d{2})\/(\d{2})\.json$/;
/** The AI Gateway is prepaid and refuses every model call at zero. A day's issue costs about thirty cents, so three dollars is about ten days. */
const LOW_CREDITS = 3;
const ISSUE_COST = 0.3;
const USED_UP = 0.5;
const GATEWAY_CREDITS = "https://ai-gateway.vercel.sh/v1/credits";

/** The AI Gateway balance in dollars, or null when it cannot be read: no key, no answer, or an answer that is not a number. */
export async function gatewayBalance(): Promise<number | null> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(GATEWAY_CREDITS, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const value = Number(((await response.json()) as { balance?: unknown }).balance);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}
const statusSchema = z.object({ recipients: z.number(), failed: z.number(), needsReconciliation: z.number() }).passthrough();
const alertedSchema = z.object({ alerted: z.array(z.string()) });

const stamp = (time: number) => new Date(time).toISOString().slice(0, 16).replace("T", " ");

/** What is wrong right now, from what the pipeline left in storage. */
export async function checkHealth({ now, autopublish, credits }: { now: Date; autopublish: boolean; credits?: () => Promise<number | null> }): Promise<Finding[]> {
  const findings: Finding[] = [];
  const date = now.toISOString().slice(0, 10);

  // A balance that cannot be read is not an alarm: only a number below the line is.
  const balance = credits ? await credits().catch(() => null) : null;
  if (balance !== null && balance < LOW_CREDITS) {
    const used = balance <= USED_UP;
    findings.push({
      key: "gateway-credits-low",
      title: used ? "AI Gateway credits are used up" : "AI Gateway credits are low",
      detail: used
        ? `The AI Gateway balance is $${balance.toFixed(2)}: every model call is refused ("A positive credit balance is required"), so no issue can be written until credits are added in the Vercel dashboard (AI Gateway, Credits).`
        : `The AI Gateway balance is $${balance.toFixed(2)}. A daily issue costs about thirty cents, so that is about ${Math.floor(balance / ISSUE_COST)} days. Add credits in the Vercel dashboard (AI Gateway, Credits) before it runs out.`,
    });
  }

  const snapshots = (await listPrivateJsonKeys("collection/runs/")).flatMap((key) => {
    const match = SNAPSHOT.exec(key);
    return match ? [Date.parse(`${match[1]}T${match[2]}:00:00Z`)] : [];
  });
  const newest = snapshots.length ? Math.max(...snapshots) : null;
  if (newest === null || now.getTime() - newest > STALE_AFTER) {
    findings.push({
      key: "collection-stalled",
      title: "The collection has stopped",
      detail: newest === null
        ? "No collection has been saved. Look: npx wrangler workflows instances list forwardpass-collect"
        : `The last collection was saved at ${stamp(newest)} UTC, ${Math.floor((now.getTime() - newest) / HOUR)} hours ago. They run every two hours, so several have failed. Look: npx wrangler workflows instances list forwardpass-collect`,
    });
  }

  const issueDue = now.getTime() >= Date.parse(`${date}T${ISSUE_DUE}`);
  const published = autopublish && (await readPrivateJson(`published/daily/${date}.json`)) !== null;
  const issued = autopublish ? published : (await readPrivateJson(`issues/${date}.json`)) !== null;
  if (issueDue && !issued) {
    findings.push({
      key: "issue-missing",
      title: `No issue for ${date}`,
      detail: `The ${autopublish ? "published issue" : "issue"} for ${date} is not there; its workflow starts at 05:30 UTC. Look: npx wrangler workflows instances describe forwardpass-issue issue-${date}. Run it again (it needs an id, because the failed instance keeps its own): POST /admin/issue {"date":"${date}","publish":${autopublish},"deliver":${autopublish},"id":"retry"}`,
    });
  }

  if (published && now.getTime() >= Date.parse(`${date}T${DELIVERY_DUE}`)) {
    const raw = await readPrivateJson(`delivery/${date}/status.json`);
    const status = statusSchema.safeParse(raw);
    if (!status.success) {
      findings.push({
        key: "delivery-missing",
        title: `${date} was published but not sent`,
        detail: `${raw === null ? "Nothing records" : "The record could not be read to show"} that the ${date} issue was emailed. Look: npx wrangler workflows instances describe forwardpass-deliver deliver-${date}. Send it: POST /admin/deliver {"date":"${date}"}`,
      });
    } else if (status.data.failed > 0 || status.data.needsReconciliation > 0) {
      const parts = [
        status.data.failed > 0 ? `The ${date} issue failed for ${status.data.failed} of ${status.data.recipients} readers.` : "",
        status.data.needsReconciliation > 0 ? `${status.data.needsReconciliation} sends have an unknown outcome and need to be checked.` : "",
      ].filter(Boolean);
      findings.push({ key: "delivery-failed", title: `${date} did not reach every reader`, detail: `${parts.join(" ")} The status is at delivery/${date}/status.json. Send it again: POST /admin/deliver {"date":"${date}"} (readers already sent to are skipped).` });
    }
  }
  return findings;
}

/** Checks, and emails what has not been reported yet today. A send that fails is not recorded, so the next run tries again. */
export async function watch({ now, autopublish, alert, credits }: { now: Date; autopublish: boolean; alert?: Alert; credits?: () => Promise<number | null> }): Promise<WatchdogResult> {
  const date = now.toISOString().slice(0, 10);
  const findings = await checkHealth({ now, autopublish, credits });
  const result: WatchdogResult = { date, findings, alerted: [] };
  if (!findings.length || !alert) return result;

  const record = alertedSchema.safeParse(await readPrivateJson(`watchdog/${date}.json`));
  const told = record.success ? record.data.alerted : [];
  const fresh = findings.filter((finding) => !told.includes(finding.key));
  if (!fresh.length) return result;

  const subject = `Forward Pass: ${fresh[0].title}${fresh.length > 1 ? ` (and ${fresh.length - 1} more)` : ""}`;
  const text = [
    `Forward Pass needs attention. Checked ${stamp(now.getTime())} UTC.`,
    "",
    ...fresh.flatMap((finding) => [`- ${finding.title}`, `  ${finding.detail}`, ""]),
    "This check runs at 08:05 and 19:05 UTC and tells you once a day about each problem.",
  ].join("\n");
  try {
    await alert(subject, text);
    await writePrivateJson(`watchdog/${date}.json`, { alerted: [...told, ...fresh.map((finding) => finding.key)] });
    result.alerted = fresh;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

type Mailer = { emails: { send(message: { from: string; to: string[]; subject: string; text: string }): Promise<{ data?: { id: string } | null; error: { message: string } | null }> } };

/** Sends the alert to ALERT_EMAIL from the newsletter's own sender; there is none until both are set. */
export function ownerAlert(client: Mailer): Alert | undefined {
  const to = process.env.ALERT_EMAIL;
  const from = process.env.NEWSLETTER_FROM;
  if (!to || !from) return undefined;
  return async (subject, text) => {
    const { data, error } = await client.emails.send({ from, to: [to], subject, text });
    if (error) throw new Error(`The alert was not sent: ${error.message}`);
    return data?.id;
  };
}
