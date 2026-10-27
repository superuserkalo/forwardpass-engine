import type { Topic } from "../lib/reader-profile.js";
import { mostFrom, rangeLabel, trendText, type WeeklyEdition, type WeeklyItem, type WeeklyTopic } from "../pipeline/weekly.js";
import { AI_DISCLOSURE, MONO, MUTED, RULE, SANS, SITE, card, dateLineOf, emailDocument, escapeHtml, footerRow, greeting, kicker, mastheadRow, paragraph, safeHref, sectionTitle, subjectLine } from "./email.js";

// The weekly research as an email: the week's top, then the reader's own topics in their order with the overview where the judge
// supported one, each item with its best verified fact and a link to how it was checked, and one plain line about the topics they do
// not follow. Everything it is given is text: nothing is printed as markup, and an address that is not a web address is not a link.

export const WEEKLY_LABEL = "Your weekly AI-generated research";
const MAX_SUBJECT = 120;
const BUSIEST = 3;

export type WeeklyEmailContext = { firstName: string | null; topics: Topic[]; unsubscribeUrl: string; preferencesUrl: string | null };

const signalPage = (id: string) => `${SITE}/signals/${id}`;
const link = (item: WeeklyItem, size: number): string =>
  `<a href="${safeHref(item.url)}" style="font-family:${SANS};font-size:${size}px;line-height:1.4;font-weight:700;color:#0a0a0a;text-decoration:none;">${escapeHtml(item.headline)}</a>`;
const checkedLink = (item: WeeklyItem): string =>
  `<a href="${safeHref(signalPage(item.id))}" style="font-family:${MONO};font-size:12px;color:${MUTED};text-decoration:underline;">&#10003; checked, see the evidence</a>`;

function itemRow(item: WeeklyItem, index: number | null): string {
  const fact = item.facts[0]?.fact;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:${index ? `1px solid ${RULE}` : "0"};"><tr>`
    + (index === null ? "" : `<td valign="top" width="40" style="padding:14px 0;font-family:${MONO};font-size:15px;font-weight:700;">${String(index).padStart(2, "0")}</td>`)
    + `<td valign="top" style="padding:14px 0;">${link(item, 16)}<p style="margin:6px 0 0;font-family:${MONO};font-size:12px;color:${MUTED};">${escapeHtml(item.publisher)}</p>`
    + (fact ? `<p style="margin:6px 0 0;font-family:${SANS};font-size:14px;line-height:1.5;color:#0a0a0a;">${escapeHtml(fact)}</p>` : "")
    + `<p style="margin:8px 0 0;">${checkedLink(item)}</p></td></tr></table>`;
}

const SHOWN_ABOVE = "Its top items are shown above.";
/** How the week compared, and who it came from when one publisher gave more than one. */
const closing = (topic: WeeklyTopic): string => { const most = mostFrom(topic.publishers); return `${trendText(topic.count, topic.previousCount)}.${most ? ` ${most}` : ""}`; };

/** A section: the overview, the items it has not shown before, and how the week compared. */
function topicCard(section: Section): string {
  const { topic, items } = section;
  return card(`${kicker(topic.topic)}`
    + (topic.overview ? paragraph(escapeHtml(topic.overview)) : "")
    + items.map((item, i) => itemRow(item, i + 1)).join("")
    + (section.shownAbove ? `<p style="margin:14px 0 0;font-family:${SANS};font-size:14px;line-height:1.5;color:${MUTED};">${SHOWN_ABOVE}</p>` : "")
    + `<p style="margin:14px 0 0;font-family:${MONO};font-size:12px;color:${MUTED};">${escapeHtml(closing(topic))}</p>`);
}

type Section = { topic: WeeklyTopic; items: WeeklyItem[]; shownAbove: boolean };

/** The topics the email has a section for: the reader's own that the week had, in their order, or else the busiest. */
function chosenTopics(edition: WeeklyEdition, wanted: Topic[]): WeeklyTopic[] {
  const own = wanted.flatMap((name) => edition.topics.filter(({ topic }) => topic === name));
  return own.length ? own : edition.topics.slice(0, BUSIEST);
}

export function renderWeeklyEmail(edition: WeeklyEdition, context: WeeklyEmailContext): { html: string; text: string; subject: string; preheader: string } {
  const range = rangeLabel(edition.weekStart, edition.weekEnd);
  const own = context.topics.flatMap((name) => edition.topics.filter(({ topic }) => topic === name));
  const shown = chosenTopics(edition, context.topics);
  const others = edition.topics.filter((topic) => !shown.includes(topic));
  const quiet = context.topics.filter((name) => !edition.topics.some(({ topic }) => topic === name));
  // The best item in the first of the reader's topics that has one; the week's top item when they follow none or none of theirs had a week.
  const lead = own.flatMap(({ items }) => items)[0]?.headline ?? edition.top[0]?.headline ?? `${edition.totals.signals} verified signals`;
  const names = own.slice(0, 2).map(({ topic }) => topic);
  const subject = subjectLine(`${names.length ? `Your week in ${names.join(" and ")}` : "The week in AI engineering"}: ${lead}`, MAX_SUBJECT);
  // An item is shown once: not again in a section if the top of the week or an earlier section showed it.
  const seen = new Set(edition.top.map(({ id }) => id));
  const sections: Section[] = shown.map((topic) => {
    const items = topic.items.filter(({ id }) => !seen.has(id));
    for (const { id } of items) seen.add(id);
    return { topic, items, shownAbove: topic.items.length > 0 && items.length === 0 };
  });
  const preheader = `${edition.totals.signals} verified signals across ${edition.totals.topics} topics. ${lead}`.slice(0, 180);
  const archive = `${SITE}/archive/weekly/${edition.date}`;
  const summaryLine = `The week in AI engineering, ${range}. ${edition.totals.signals} verified signals across ${edition.totals.topics} topics.`;
  const builtLine = context.topics.length ? `Built around your topics: ${context.topics.join(", ")}.` : "";
  const quietLine = quiet.length ? `Quiet this week: ${quiet.join(", ")}.` : "";
  const alsoLine = others.length ? `Also this week: ${others.map(({ topic, count }) => `${topic} (${count})`).join(", ")}.` : "";

  const rows: string[] = [mastheadRow(dateLineOf(edition.date), WEEKLY_LABEL)];
  rows.push(card(paragraph(escapeHtml(greeting(context.firstName))) + paragraph(escapeHtml(summaryLine))
    + [builtLine, quietLine].filter(Boolean).map((line) => `<p style="margin:0 0 8px;font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTED};">${escapeHtml(line)}</p>`).join("")));
  if (edition.top.length) rows.push(card(`${sectionTitle("Top of the week")}${edition.top.map((item, i) => itemRow(item, i + 1)).join("")}`));
  rows.push(...sections.map(topicCard));
  if (alsoLine) rows.push(card(`<p style="margin:0 0 12px;font-family:${SANS};font-size:15px;line-height:1.6;">${escapeHtml(alsoLine)}</p><p style="margin:0;font-family:${SANS};font-size:14px;"><a href="${safeHref(archive)}" style="color:#0a0a0a;text-decoration:underline;">Read the full edition</a></p>`));
  rows.push(footerRow([
    { label: "Read the full edition", url: archive },
    ...(context.preferencesUrl ? [{ label: "Edit your reading brief", url: context.preferencesUrl }] : []),
    { label: "Unsubscribe", url: context.unsubscribeUrl },
  ]));

  const textItem = (item: WeeklyItem, i: number) => [`${i + 1}. ${item.headline}`, `   ${item.publisher}`, ...(item.facts[0] ? [`   ${item.facts[0].fact}`] : []), `   ${item.url}`, `   Checked: ${signalPage(item.id)}`].join("\n");
  const text = [
    `THE FORWARD PASS · ${dateLineOf(edition.date)}\n${WEEKLY_LABEL}`, greeting(context.firstName), [summaryLine, builtLine, quietLine].filter(Boolean).join("\n"),
    ...(edition.top.length ? [`TOP OF THE WEEK\n\n${edition.top.map(textItem).join("\n\n")}`] : []),
    ...sections.map(({ topic, items, shownAbove }) => [topic.topic.toUpperCase(), ...(topic.overview ? [topic.overview] : []), items.map(textItem).join("\n\n"), ...(shownAbove ? [SHOWN_ABOVE] : []), closing(topic)].join("\n\n")),
    ...(alsoLine ? [`${alsoLine}\nRead the full edition: ${archive}`] : []),
    AI_DISCLOSURE,
    [`Read the full edition: ${archive}`, context.preferencesUrl ? `Edit your reading brief: ${context.preferencesUrl}` : "", `Unsubscribe: ${context.unsubscribeUrl}`].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");

  return { html: emailDocument(subject, preheader, rows), text, subject, preheader };
}
