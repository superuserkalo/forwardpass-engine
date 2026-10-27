import { oneLine, plainProse, unlinkable } from "../pipeline/excerpt.js";
import { rangeLabel } from "../pipeline/weekly.js";
import { tagOf, type ComputeArea, type ComputeItem, type ComputeNumber, type ComputeWeek, type RadarItem } from "../pipeline/weekly-compute.js";
import { AI_DISCLOSURE, MONO, MUTED, RULE, SANS, SITE, card, dateLineOf, emailDocument, escapeHtml, footerRow, greeting, kicker, mastheadRow, paragraph, safeHref, sectionTitle, subjectLine } from "./email.js";

// The weekly Compute report as an email: the week's top, the figures with the quotes they rest on, each area with its overview where the judge
// supported one, and the radar. Everything it is given is text: nothing is printed as markup, a line is one line however it was stored, and an
// address that is not a web address is not a link.

export const COMPUTE_WEEKLY_LABEL = "Your weekly AI-generated compute report";
const MAX_SUBJECT = 120;

export type ComputeWeeklyEmailContext = { firstName: string | null; unsubscribeUrl: string; preferencesUrl: string | null };

/** A line of outside text as it is printed: on one line, and with nothing a mail program could link. */
const line = (text: string): string => unlinkable(oneLine(text));
/** Stored text is checked again where it is printed: a quote or a source's headline is shown only if it is plain prose. */
const plain = (text: string): boolean => plainProse(text) !== null;
const link = (url: string, text: string, size: number, weight = 700): string =>
  `<a href="${safeHref(url)}" style="font-family:${SANS};font-size:${size}px;line-height:1.4;font-weight:${weight};color:#0a0a0a;text-decoration:none;">${escapeHtml(line(text))}</a>`;
const small = (text: string, margin = "6px 0 0"): string => `<p style="margin:${margin};font-family:${MONO};font-size:12px;color:${MUTED};">${escapeHtml(oneLine(text))}</p>`;
const rows = (cells: string[]): string => cells.map((cell, i) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:${i ? `1px solid ${RULE}` : "0"};"><tr><td valign="top" width="40" style="padding:14px 0;font-family:${MONO};font-size:15px;font-weight:700;">${String(i + 1).padStart(2, "0")}</td><td valign="top" style="padding:14px 0;">${cell}</td></tr></table>`).join("");

/** The story's best fact beneath it, unless the report shows that fact already under the numbers. */
const factOf = (item: ComputeItem, shown: Set<string>): string | null => item.facts.map(({ fact }) => fact).find((fact) => !shown.has(fact) && plain(fact)) ?? null;
const itemCell = (shown: Set<string>) => (item: ComputeItem): string => `${link(item.url, item.headline, 16)}${small(tagOf(item))}`
  + (factOf(item, shown) ? `<p style="margin:6px 0 0;font-family:${SANS};font-size:14px;line-height:1.5;color:#0a0a0a;">${escapeHtml(line(factOf(item, shown) ?? ""))}</p>` : "");
const numberCell = (entry: ComputeNumber): string => `<p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.5;color:#0a0a0a;">${escapeHtml(line(entry.fact))}</p>`
  + `<p style="margin:6px 0 0;font-family:${SANS};font-size:14px;line-height:1.5;font-style:italic;color:${MUTED};">&ldquo;${escapeHtml(line(entry.quote))}&rdquo;</p>`
  + `<p style="margin:6px 0 0;">${link(entry.url, entry.headline, 13, 400)}</p>${small(tagOf(entry), "4px 0 0")}`;
const radarCell = (item: RadarItem): string => `${link(item.url, item.title, 15)}${small(item.site)}`;

const storiesOf = (count: number) => `${count} ${count === 1 ? "story" : "stories"}`;
const closing = (area: ComputeArea): string => `${storiesOf(area.count)} this week, ${area.previousCount === 0 ? "none last week" : area.count === area.previousCount ? "the same as last week" : `${area.count > area.previousCount ? "up" : "down"} from ${area.previousCount} last week`}.`;

export function renderComputeWeeklyEmail(edition: ComputeWeek, context: ComputeWeeklyEmailContext): { html: string; text: string; subject: string; preheader: string } {
  const range = rangeLabel(edition.weekStart, edition.weekEnd);
  const lead = edition.top[0]?.headline ?? `${storiesOf(edition.totals.stories)} on AI compute`;
  const subject = subjectLine(`The week in AI compute: ${oneLine(lead)}`, MAX_SUBJECT);
  const { totals } = edition;
  const summaryLine = `The week in AI compute, ${range}. ${storiesOf(totals.stories)} in ${totals.days} daily ${totals.days === 1 ? "issue" : "issues"}: ${totals.official} official, ${totals.reported} reported, ${totals.unconfirmed} unconfirmed.`;
  const preheader = `${summaryLine} ${oneLine(lead)}`.slice(0, 180);
  const archive = `${SITE}/archive`;
  const numbers = edition.numbers.filter(({ fact, quote }) => plain(fact) && plain(quote));
  const radar = edition.radar.filter(({ title }) => plain(title));
  const figures = new Set(numbers.map(({ fact }) => fact));

  // A story is shown once: not again in an area if the top showed it.
  const seen = new Set(edition.top.map(({ url }) => url));
  const sections = edition.areas.map((area) => {
    const items = area.items.filter(({ url }) => !seen.has(url));
    for (const { url } of items) seen.add(url);
    return { area, items, shownAbove: area.items.length > 0 && items.length === 0 };
  });
  const SHOWN_ABOVE = "Its top stories are shown above.";

  const cards: string[] = [mastheadRow(dateLineOf(edition.date), COMPUTE_WEEKLY_LABEL)];
  cards.push(card(paragraph(escapeHtml(greeting(context.firstName))) + paragraph(escapeHtml(summaryLine))
    + (totals.translated ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTED};">${escapeHtml(`${totals.translated} of them were read in Chinese, Korean or Japanese and written up in English, and say so.`)}</p>` : "")));
  if (edition.top.length) cards.push(card(`${sectionTitle("Top of the week")}${rows(edition.top.map(itemCell(figures)))}`));
  if (numbers.length) cards.push(card(`${sectionTitle("By the numbers")}${rows(numbers.map(numberCell))}`));
  for (const { area, items, shownAbove } of sections) {
    cards.push(card(kicker(area.area) + (area.overview ? paragraph(escapeHtml(area.overview)) : "") + rows(items.map(itemCell(figures)))
      + (shownAbove ? `<p style="margin:14px 0 0;font-family:${SANS};font-size:14px;line-height:1.5;color:${MUTED};">${SHOWN_ABOVE}</p>` : "")
      + small(closing(area), "14px 0 0")));
  }
  if (radar.length) cards.push(card(`${sectionTitle("On the radar")}<p style="margin:0 0 8px;font-family:${SANS};font-size:14px;line-height:1.5;color:${MUTED};">Headlines collected that the daily issues had no place for, as the outlets wrote them.</p>${rows(radar.map(radarCell))}`));
  cards.push(footerRow([
    { label: "Read the daily issues", url: archive },
    ...(context.preferencesUrl ? [{ label: "Edit your reading brief", url: context.preferencesUrl }] : []),
    { label: "Unsubscribe", url: context.unsubscribeUrl },
  ]));

  const itemText = (item: ComputeItem, i: number) => [`${i + 1}. ${line(item.headline)}`, `   ${tagOf(item)}`, ...(factOf(item, figures) ? [`   ${line(factOf(item, figures) ?? "")}`] : []), `   ${item.url}`].join("\n");
  const text = [
    `THE FORWARD PASS · ${dateLineOf(edition.date)}\n${COMPUTE_WEEKLY_LABEL}`, greeting(context.firstName), summaryLine,
    ...(edition.top.length ? [`TOP OF THE WEEK\n\n${edition.top.map(itemText).join("\n\n")}`] : []),
    ...(numbers.length ? [`BY THE NUMBERS\n\n${numbers.map((entry, i) => `${i + 1}. ${line(entry.fact)}\n   “${line(entry.quote)}”\n   ${line(entry.headline)} (${tagOf(entry)})\n   ${entry.url}`).join("\n\n")}`] : []),
    ...sections.map(({ area, items, shownAbove }) => [area.area.toUpperCase(), ...(area.overview ? [line(area.overview)] : []), items.map(itemText).join("\n\n"), ...(shownAbove ? [SHOWN_ABOVE] : []), closing(area)].filter(Boolean).join("\n\n")),
    ...(radar.length ? [`ON THE RADAR\n\n${radar.map((item, i) => `${i + 1}. ${line(item.title)} (${item.site})\n   ${item.url}`).join("\n")}`] : []),
    AI_DISCLOSURE,
    [`Read the daily issues: ${archive}`, context.preferencesUrl ? `Edit your reading brief: ${context.preferencesUrl}` : "", `Unsubscribe: ${context.unsubscribeUrl}`].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");
  return { html: emailDocument(subject, preheader, cards), text, subject, preheader };
}
