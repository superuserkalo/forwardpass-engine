import type { IssueV2, StoryRecord } from "../lib/issue.js";
import { readTime } from "../pipeline/assemble.js";

// Renders the saved issue's story records as the email, in AlphaSignal's layout: greeting and
// intro, a summary with read time, featured stories with their label and traction, then signals.

export const SITE = "https://theforwardpass.net";
export const INK = "#0a0a0a";
export const PAPER = "#eeece6";
export const MUTED = "#6b6b6b";
export const RULE = "#d6d4cd";
export const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
export const SERIF = "Newsreader,Georgia,'Times New Roman',serif";
export const MONO = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace";

// EU AI Act Article 50(4) and (5): the issue is AI-generated text published to inform the public,
// so readers are told at first exposure (masthead) and in full in the footer.
export const AI_LABEL = "Daily AI-generated issue";
export const AI_DISCLOSURE = "This issue is researched and written by AI models, and every fact is checked against its cited source. No human edits it before it is sent.";

export type EmailOptions = { firstName: string | null; unsubscribeUrl: string; preferencesUrl: string | null };

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : "#";
}

const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

// Inline Markdown the writer produces: links, **bold** and `code`.
export function inline(text: string): string {
  const tokens: string[] = [];
  const stash = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  const out = escapeHtml(text.replace(MARKDOWN_LINK, (_, label: string, url: string) => stash(`<a href="${safeHref(url)}" style="color:${INK};text-decoration:underline;">${escapeHtml(label)}</a>`)))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, `<code style="font-family:${MONO};font-size:14px;background:#f1f0eb;padding:1px 4px;">$1</code>`);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => tokens[Number(i)]);
}

export const paragraph = (html: string) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:17px;line-height:1.6;color:${INK};">${html}</p>`;

/** Paragraphs, bullet lists and lead-in labels ("One catch:", "Try it:") from a Markdown body. */
function renderBody(markdown: string): string {
  return markdown.split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const bullets = lines.filter((line) => /^[-*•]\s+/.test(line));
    const text = lines.filter((line) => !/^[-*•]\s+/.test(line));
    const intro = text.length ? paragraph(inline(text.join(" ")).replace(/^(One catch:|Try it:|Why care\?)/, "<strong>$1</strong>")) : "";
    const list = bullets.length
      ? `<ul style="margin:0 0 16px;padding:0 0 0 24px;font-family:${SANS};font-size:17px;line-height:1.6;color:${INK};">${bullets.map((line) => `<li style="margin:0 0 8px;">${inline(line.replace(/^[-*•]\s+/, ""))}</li>`).join("")}</ul>`
      : "";
    return intro + list;
  }).join("");
}

export function card(inner: string, padding = "28px 32px"): string {
  return `<tr><td style="padding:0 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${RULE};"><tr><td class="card" style="padding:${padding};">${inner}</td></tr></table></td></tr>`;
}

export const kicker = (text: string) => `<p style="margin:0 0 10px;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};">${escapeHtml(text)}</p>`;
export const sectionTitle = (text: string) => `<h2 style="margin:0 0 16px;padding:0 0 12px;border-bottom:1px solid ${INK};font-family:${SANS};font-size:20px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(text)}</h2>`;
const tractionLine = (story: StoryRecord) => story.traction ? `<p style="margin:0 0 18px;font-family:${MONO};font-size:13px;color:${MUTED};">${escapeHtml(story.traction)}</p>` : "";
export const host = (url: string) => new URL(url).hostname.replace(/^www\./, "");

export function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 4px;"><tr><td style="background:${INK};"><a href="${safeHref(url)}" style="display:inline-block;padding:13px 24px;font-family:${SANS};font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${escapeHtml(label)} &rarr;</a></td></tr></table>`;
}

function featuredCard(story: StoryRecord): string {
  const [primary, ...more] = story.sources;
  const also = more.length ? `<p style="margin:10px 0 0;font-family:${SANS};font-size:14px;color:${MUTED};">Also: ${more.map(({ label, url }) => `<a href="${safeHref(url)}" style="color:${INK};text-decoration:underline;">${escapeHtml(label)}</a>`).join(" · ")}</p>` : "";
  return card(`${kicker(story.label)}<h1 style="margin:0 0 8px;font-family:${SANS};font-size:24px;line-height:1.3;font-weight:700;color:${INK};">${inline(story.headline)}</h1>${tractionLine(story)}${renderBody(story.body ?? "")}${primary ? button(primary.url, `Read on ${primary.label}`) : ""}${also}`);
}

function signalsCard(signals: StoryRecord[]): string {
  return card(`${sectionTitle("Signals")}${signals.map((story, i) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:${i ? `1px solid ${RULE}` : "0"};"><tr>
<td valign="top" width="40" style="padding:16px 0;font-family:${MONO};font-size:17px;font-weight:700;color:${INK};">${String(i + 1).padStart(2, "0")}</td>
<td valign="top" style="padding:16px 0;"><a href="${safeHref(story.url)}" style="font-family:${SANS};font-size:17px;line-height:1.45;font-weight:700;color:${INK};text-decoration:none;">${inline(story.headline)}</a>
<p style="margin:6px 0 0;font-family:${MONO};font-size:12px;color:${MUTED};">${escapeHtml([story.traction, host(story.url)].filter(Boolean).join(" · "))}</p></td></tr></table>`).join("")}`);
}

/** A subject line no longer than `max`: cut at a word and marked, never in the middle of one, unless there is no word to cut at. */
export function subjectLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  // The cut falls between two words, or at the last space when that leaves most of the line; a space near the start leaves next to nothing.
  const kept = text[max - 1] === " " || space < max * 0.6 ? room : room.slice(0, space);
  return `${kept.replace(/[\s,;:–—-]+$/u, "")}…`;
}

export function greeting(firstName: string | null): string {
  const name = firstName?.trim().split(/\s+/)[0];
  return name && /^[\p{L}'’-]{1,40}$/u.test(name) ? `Hey ${name},` : "Hey there,";
}

/** The black header: the name, the date and what kind of issue it is (EU AI Act Article 50: readers are told at first exposure). */
export function mastheadRow(dateLine: string, label: string): string {
  return `<tr><td style="padding:0 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};"><tr><td align="center" style="padding:36px 24px 32px;">
<img src="${SITE}/logo.png" width="56" height="56" alt="" style="display:block;margin:0 auto 14px;border:0;">
<p style="margin:0;font-family:${SERIF};font-size:32px;line-height:1.1;color:${PAPER};">The Forward Pass</p>
<p style="margin:12px 0 0;font-family:${MONO};font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#a3a29c;">${escapeHtml(dateLine)}</p>
<p style="margin:8px 0 0;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a3a29c;">${escapeHtml(label)}</p>
</td></tr></table></td></tr>`;
}

export const dateLineOf = (date: string): string => new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${date}T00:00:00Z`));

/** The disclosure, the links and the site name that close every email. */
export function footerRow(links: Array<{ label: string; url: string }>): string {
  const footerLinks = links.map((link) => `<a href="${safeHref(link.url)}" style="color:${MUTED};text-decoration:underline;">${escapeHtml(link.label)}</a>`).join(" &nbsp;·&nbsp; ");
  return `<tr><td align="center" style="padding:8px 16px 40px;">
<p style="margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTED};">${escapeHtml(AI_DISCLOSURE)} Know someone building AI systems? Forward this to them.</p>
<p style="margin:0 0 16px;font-family:${SANS};font-size:13px;line-height:1.8;">${footerLinks}</p>
<p style="margin:0;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#9a9993;"><a href="${SITE}" style="color:#9a9993;text-decoration:none;">theforwardpass.net</a></p>
</td></tr>`;
}

/** The page every email is: a narrow column of cards on paper, with the preheader hidden at the top. */
export function emailDocument(title: string, preheader: string, rows: string[]): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(title)}</title>
<style>@media (max-width:620px){.card{padding:22px 18px !important}}</style></head>
<body style="margin:0;padding:0;background:#f6f5f1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f1;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
${rows.join("\n")}
</table></td></tr></table></body></html>`;
}

export function renderIssueEmail(issue: IssueV2, options: EmailOptions): { html: string; text: string; subject: string; preheader: string } {
  const featured = issue.stories.filter(({ role }) => role === "featured");
  const signals = issue.stories.filter(({ role }) => role === "signal");
  const dateLine = dateLineOf(issue.date);
  const rows: string[] = [];

  rows.push(mastheadRow(dateLine, AI_LABEL));

  rows.push(card(paragraph(escapeHtml(greeting(options.firstName))) + issue.intro.map((p) => paragraph(inline(p))).join("")));

  const summaryRow = (label: string, text: string) => `<tr><td style="padding:12px 0;border-top:1px solid ${RULE};"><p style="margin:0 0 4px;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</p><p style="margin:0;font-family:${SANS};font-size:16px;line-height:1.45;color:${INK};">&#9656;&nbsp;${inline(text)}</p></td></tr>`;
  const signalList = signals.length ? `<tr><td style="padding:12px 0;border-top:1px solid ${RULE};"><p style="margin:0 0 6px;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};">Signals</p>${signals.map((story, i) => `<p style="margin:0 0 6px;font-family:${SANS};font-size:15px;line-height:1.45;color:${INK};">${i + 1}. ${inline(story.headline)}</p>`).join("")}</td></tr>` : "";
  rows.push(card(`${sectionTitle("Summary")}<p style="margin:0 0 6px;font-family:${MONO};font-size:12px;color:${MUTED};">Read time: ${readTime(issue.markdown)}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${featured.map((story) => summaryRow(story.label, story.headline)).join("")}${signalList}</table>`));

  rows.push(...featured.map(featuredCard));
  if (signals.length) rows.push(signalsCard(signals));

  rows.push(footerRow([
    ...(options.preferencesUrl ? [{ label: "Edit your reading brief", url: options.preferencesUrl }] : []),
    { label: "Read in the archive", url: `${SITE}/archive/daily/${issue.date}` },
    { label: "Unsubscribe", url: options.unsubscribeUrl },
  ]));

  const preheader = issue.preview.slice(0, 180);
  const html = emailDocument(issue.subject, preheader, rows);

  const text = [
    `THE FORWARD PASS · ${dateLine}\n${AI_LABEL}`, greeting(options.firstName), ...issue.intro,
    ...featured.map((story) => [`${story.label.toUpperCase()}${story.traction ? ` · ${story.traction}` : ""}`, story.headline, story.body ?? "", `Source: ${story.sources.map(({ url }) => url).join(" ")}`].join("\n\n")),
    signals.length ? `SIGNALS\n\n${signals.map((story, i) => `${i + 1}. ${story.headline}${story.traction ? ` (${story.traction})` : ""}\n   ${story.url}`).join("\n")}` : "",
    AI_DISCLOSURE,
    [options.preferencesUrl ? `Edit your reading brief: ${options.preferencesUrl}` : "", `Unsubscribe: ${options.unsubscribeUrl}`].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");

  return { html, text, subject: issue.subject, preheader };
}
