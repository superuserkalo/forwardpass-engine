import { oneLine, unlinkable } from "../pipeline/excerpt.js";
import type { PersonalEdition, PersonalItem } from "../pipeline/personal.js";
import { AI_DISCLOSURE, MONO, MUTED, RULE, SANS, SITE, button, card, dateLineOf, emailDocument, escapeHtml, footerRow, greeting, kicker, mastheadRow, paragraph, safeHref, sectionTitle, subjectLine } from "./email.js";

// A reader's own edition as an email. It says it is theirs and what it was built from, shows what was chosen with the reason and the
// way to see how it was checked, and has no place for an advertisement: Personal is ad-free by what this renders, not by a promise.
// Everything it is given is text: headlines come from a model, publishers from feeds and the note from the reader, so none of it is
// printed as markup, and an address that is not a web address is not a link.

export const PERSONAL_LABEL = "Your daily AI-generated issue";
const TYPE_LABEL = { news: "News", papers: "Papers", models: "Models", repos: "Repos" } as const;
const MAX_SUBJECT = 120;

export type PersonalEmailContext = { date: string; now: Date; firstName: string | null; unsubscribeUrl: string; preferencesUrl: string | null };

const signalPage = (id: string) => `${SITE}/signals/${id}`;

function age(iso: string | null, now: Date): string | null {
  const hours = iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : NaN;
  if (!Number.isFinite(hours)) return null;
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.floor(hours)} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const meta = (item: PersonalItem, now: Date): string => [item.why, age(item.publishedAt, now), item.traction].filter(Boolean).join(" · ");
const factsLabel = (item: PersonalItem) => item.facts > 0 ? `${item.facts} verified ${item.facts === 1 ? "fact" : "facts"}` : "how it was checked";
const checkedLink = (item: PersonalItem): string => item.signalId
  ? `<a href="${safeHref(signalPage(item.signalId))}" style="font-family:${MONO};font-size:12px;color:${MUTED};text-decoration:underline;">&#10003; ${escapeHtml(factsLabel(item))}, see the evidence</a>` : "";
/** The source's own words for an item, on one line, or nothing: stored text is not trusted to hold no line break or hidden character. */
const quotation = (item: PersonalItem): string => unlinkable(oneLine(item.excerpt ?? ""));
const link = (item: PersonalItem, size: number, weight: number): string =>
  `<a href="${safeHref(item.url)}" style="font-family:${SANS};font-size:${size}px;line-height:1.4;font-weight:${weight};color:#0a0a0a;text-decoration:none;">${escapeHtml(item.headline)}</a>`;

function leadCard(item: PersonalItem, now: Date): string {
  const line = meta(item, now);
  return card(`${kicker(`${TYPE_LABEL[item.type]} · ${item.publisher}`)}<h1 style="margin:0 0 8px;font-family:${SANS};font-size:22px;line-height:1.3;font-weight:700;">${link(item, 22, 700)}</h1>`
    + (line ? `<p style="margin:0 0 14px;font-family:${MONO};font-size:12px;color:${MUTED};">${escapeHtml(line)}</p>` : "")
    + (item.summary ? paragraph(escapeHtml(item.summary))
      // The source's own words, which we did not check: shown as a quotation from it.
      : quotation(item) ? `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:1.55;font-style:italic;color:${MUTED};">&ldquo;${escapeHtml(quotation(item))}&rdquo; &mdash; ${escapeHtml(oneLine(item.publisher))}</p>` : "")
    + button(item.url, `Read on ${item.publisher}`)
    + (item.signalId ? `<p style="margin:12px 0 0;">${checkedLink(item)}</p>` : ""));
}

function listCard(title: string, items: PersonalItem[], now: Date): string {
  return card(`${sectionTitle(title)}${items.map((item, i) => {
    const line = [item.publisher, meta(item, now)].filter(Boolean).join(" · ");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:${i ? `1px solid ${RULE}` : "0"};"><tr>
<td valign="top" width="40" style="padding:16px 0;font-family:${MONO};font-size:17px;font-weight:700;">${String(i + 1).padStart(2, "0")}</td>
<td valign="top" style="padding:16px 0;">${link(item, 17, 700)}
<p style="margin:6px 0 0;font-family:${MONO};font-size:12px;color:${MUTED};">${escapeHtml(line)}</p>${item.signalId ? `<p style="margin:6px 0 0;">${checkedLink(item)}</p>` : ""}</td></tr></table>`;
  }).join("")}`);
}

const builtLine = (built: PersonalEdition["built"]): string =>
  `Topics: ${built.topics.join(", ")}. Includes: ${built.content.join(", ")}. Format: ${built.format === "Links only" ? "Links only" : "Briefing"}.`;

export function renderPersonalEmail(edition: PersonalEdition, context: PersonalEmailContext): { html: string; text: string; subject: string; preheader: string } {
  const items = [...edition.lead, ...edition.more];
  // The subject is the best match for the reader, which is in the list rather than the lead when it is only a headline and a link.
  const top = items.reduce((best, item) => item.score > best.score ? item : best);
  const subject = subjectLine(top.headline, MAX_SUBJECT);
  const preheader = `${items.length} for you: ${items.slice(0, 3).map(({ headline }) => headline).join(" · ")}`.slice(0, 180);
  const rows: string[] = [mastheadRow(dateLineOf(context.date), PERSONAL_LABEL)];

  const note = edition.built.notes ? `<p style="margin:0 0 16px;font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTED};">Your note: &ldquo;${escapeHtml(edition.built.notes)}&rdquo;</p>` : "";
  rows.push(card(paragraph(escapeHtml(greeting(context.firstName)))
    + paragraph(`Here is your issue. It is built from your brief, chosen from what was checked against its sources today. No ads.`)
    + `<p style="margin:0 0 16px;font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTED};">Built from your brief. ${escapeHtml(builtLine(edition.built))}${context.preferencesUrl ? ` <a href="${safeHref(context.preferencesUrl)}" style="color:${MUTED};text-decoration:underline;">Edit your reading brief</a>.` : ""}</p>`
    + note));

  rows.push(...edition.lead.map((item) => leadCard(item, context.now)));
  if (edition.more.length) rows.push(listCard(edition.lead.length ? "More for you" : "Your links", edition.more, context.now));
  rows.push(footerRow([
    ...(context.preferencesUrl ? [{ label: "Edit your reading brief", url: context.preferencesUrl }] : []),
    { label: "Read the shared issue", url: `${SITE}/archive/daily/${context.date}` },
    { label: "Unsubscribe", url: context.unsubscribeUrl },
  ]));

  const textItem = (item: PersonalItem, i: number): string => [
    `${i + 1}. ${item.headline}`,
    ...(edition.lead.includes(item) ? item.summary ? [`   ${item.summary}`] : quotation(item) ? [`   \u201c${quotation(item)}\u201d (${oneLine(item.publisher)})`] : [] : []),
    `   ${[item.publisher, meta(item, context.now)].filter(Boolean).join(" · ")}`,
    `   ${item.url}`,
    ...(item.signalId ? [`   Checked: ${signalPage(item.signalId)}`] : []),
  ].join("\n");
  const text = [
    `THE FORWARD PASS · ${dateLineOf(context.date)}\n${PERSONAL_LABEL}`, greeting(context.firstName),
    `Here is your issue. It is built from your brief, chosen from what was checked against its sources today. No ads.\nBuilt from your brief. ${builtLine(edition.built)}${edition.built.notes ? `\nYour note: "${edition.built.notes}"` : ""}`,
    items.map(textItem).join("\n\n"),
    AI_DISCLOSURE,
    [context.preferencesUrl ? `Edit your reading brief: ${context.preferencesUrl}` : "", `Unsubscribe: ${context.unsubscribeUrl}`].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");

  return { html: emailDocument(subject, preheader, rows), text, subject, preheader };
}
