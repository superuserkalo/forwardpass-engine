import type { Resend } from "resend";
import { preferencesLink } from "../lib/preference-link.js";
import { writePrivateJson } from "../lib/private-store.js";
import { readerFromProperties, type Topic } from "../lib/reader-profile.js";
import { IO_STEP, type Steps } from "../pipeline/steps.js";
import { loadWeekly, type WeeklyEdition } from "../pipeline/weekly.js";
import { resend, runAudience, sendEmail, sendPreview, type Channel, type DeliveryResult } from "./deliver.js";
import { renderWeeklyEmail } from "./weekly-email.js";

// Delivery of the weekly research, which is what a Professional reader pays for beyond the daily issue. It travels the daily issue's road
// (the audience staged page by page, consent rechecked at send time, a create-only attempt claim, a ledger marker, a Resend idempotency
// key), but keeps a ledger of its own, so the daily issue and the weekly research on the one day never see each other's records. A reader
// it is not for is skipped with nothing recorded, so a reader who upgrades before the next Sunday simply starts receiving it.

export type WeeklyDeliveryJob = {
  date: string;
  /** Send a preview to these addresses instead of the audience, with no ledger. */
  test?: string[];
  /** The topics a preview is cut to, as a Professional reader's reading profile would cut it. */
  topics?: Topic[];
};

const scopeOf = (date: string) => `weekly-${date}`;

/** What a reader gets: for a Professional reader, the week cut to the topics in their reading profile, or the busiest topics when they have none. */
function weeklyChannel(edition: WeeklyEdition): Channel {
  return {
    kind: "weekly", date: edition.date, scope: scopeOf(edition.date),
    compose: (recipient, properties, unsubscribeUrl) => {
      const { tier, profile } = readerFromProperties(properties);
      if (tier !== "professional") return null;
      const topics = profile?.topics ?? [];
      return {
        edition: topics.length ? "personal" : "shared",
        rendered: renderWeeklyEmail(edition, { firstName: profile?.firstName ?? recipient.firstName, topics, unsubscribeUrl, preferencesUrl: preferencesLink(recipient.email) }),
      };
    },
  };
}

const weeklyPreview = (edition: WeeklyEdition, topics: Topic[]): Channel => ({
  kind: "test", date: edition.date, scope: scopeOf(edition.date),
  compose: (recipient, _properties, unsubscribeUrl) => ({
    edition: topics.length ? "personal" : "shared",
    rendered: renderWeeklyEmail(edition, { firstName: recipient.firstName, topics, unsubscribeUrl, preferencesUrl: null }),
  }),
});

export async function deliverWeekly(steps: Steps, job: WeeklyDeliveryJob, client: Resend = resend()): Promise<DeliveryResult> {
  const { date } = job;
  const summary = await steps.run("edition", IO_STEP, async () => {
    const saved = await loadWeekly(date);
    if (!saved) throw new Error(`No weekly edition saved for ${date}.`);
    return { topics: saved.topics.length, signals: saved.totals.signals };
  });
  const load = async () => {
    const saved = await loadWeekly(date);
    if (!saved) throw new Error("Weekly edition disappeared");
    return saved;
  };
  const totals: DeliveryResult = { date, recipients: 0, sent: 0, alreadySent: 0, skipped: 0, failed: 0, needsReconciliation: 0, personal: 0 };

  if (job.test?.length) {
    await sendPreview(steps, client, job.test, async () => weeklyPreview(await load(), job.topics ?? []));
    return { ...totals, recipients: job.test.length, sent: job.test.length };
  }

  Object.assign(totals, await runAudience(steps, client, scopeOf(date), async () => {
    const channel = weeklyChannel(await load());
    return (recipient) => sendEmail(client, channel, recipient);
  }));
  await steps.run("status", IO_STEP, async () => {
    await writePrivateJson(`delivery/${scopeOf(date)}/status.json`, { ...totals, ...summary, completedAt: new Date().toISOString() });
    console.info("forwardpass.weekly_delivery", JSON.stringify(totals));
    return true;
  });
  return totals;
}
