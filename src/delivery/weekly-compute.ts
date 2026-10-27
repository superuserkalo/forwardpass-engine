import type { Resend } from "resend";
import { preferencesLink } from "../lib/preference-link.js";
import { writePrivateJson } from "../lib/private-store.js";
import { readerFromProperties } from "../lib/reader-profile.js";
import { IO_STEP, type Steps } from "../pipeline/steps.js";
import { loadWeeklyCompute, type ComputeWeek } from "../pipeline/weekly-compute.js";
import { resend, runAudience, sendEmail, sendPreview, type Channel, type DeliveryResult } from "./deliver.js";
import { renderComputeWeeklyEmail } from "./weekly-compute-email.js";

// Delivery of the weekly Compute report: to Professional readers who follow Chips or Data centers, and to no one else. It travels the daily issue's
// road (the audience staged page by page, consent rechecked at send time, a create-only attempt claim, a ledger marker, a Resend idempotency key) with a
// ledger and a key of its own, so it and the weekly research on the one Sunday never see each other's records. A reader it is not for is skipped with
// nothing recorded, so a reader who upgrades or follows Chips before the next Sunday simply starts receiving it.

export type WeeklyComputeDeliveryJob = { date: string; /** Send a preview to these addresses instead of the audience, with no ledger. */ test?: string[] };

const scopeOf = (date: string) => `weekly-compute-${date}`;
const FOLLOWED = new Set(["Chips", "Data centers"]);

function computeChannel(edition: ComputeWeek): Channel {
  return {
    kind: "weekly-compute", date: edition.date, scope: scopeOf(edition.date),
    compose: (recipient, properties, unsubscribeUrl) => {
      const { tier, profile } = readerFromProperties(properties);
      if (tier !== "professional" || !profile?.topics.some((topic) => FOLLOWED.has(topic))) return null;
      return { edition: "personal", rendered: renderComputeWeeklyEmail(edition, { firstName: profile.firstName ?? recipient.firstName, unsubscribeUrl, preferencesUrl: preferencesLink(recipient.email) }) };
    },
  };
}

const computePreview = (edition: ComputeWeek): Channel => ({
  kind: "test", date: edition.date, scope: scopeOf(edition.date),
  compose: (recipient, _properties, unsubscribeUrl) => ({ edition: "shared", rendered: renderComputeWeeklyEmail(edition, { firstName: recipient.firstName, unsubscribeUrl, preferencesUrl: null }) }),
});

export async function deliverWeeklyCompute(steps: Steps, job: WeeklyComputeDeliveryJob, client: Resend = resend()): Promise<DeliveryResult> {
  const { date } = job;
  const summary = await steps.run("edition", IO_STEP, async () => {
    const saved = await loadWeeklyCompute(date);
    if (!saved) throw new Error(`No weekly Compute report saved for ${date}.`);
    return { stories: saved.totals.stories, areas: saved.areas.length };
  });
  const load = async () => {
    const saved = await loadWeeklyCompute(date);
    if (!saved) throw new Error("Weekly Compute report disappeared");
    return saved;
  };
  const totals: DeliveryResult = { date, recipients: 0, sent: 0, alreadySent: 0, skipped: 0, failed: 0, needsReconciliation: 0, personal: 0 };

  if (job.test?.length) {
    await sendPreview(steps, client, job.test, async () => computePreview(await load()));
    return { ...totals, recipients: job.test.length, sent: job.test.length };
  }

  Object.assign(totals, await runAudience(steps, client, scopeOf(date), async () => {
    const channel = computeChannel(await load());
    return (recipient) => sendEmail(client, channel, recipient);
  }));
  await steps.run("status", IO_STEP, async () => {
    await writePrivateJson(`delivery/${scopeOf(date)}/status.json`, { ...totals, ...summary, completedAt: new Date().toISOString() });
    console.info("forwardpass.weekly_compute_delivery", JSON.stringify(totals));
    return true;
  });
  return totals;
}
