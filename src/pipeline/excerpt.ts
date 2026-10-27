import { SOURCE_STREAMS } from "../lib/source-streams.js";
import { terms } from "./freshness.js";
import { languageOf } from "./language.js";
import { splitSentences } from "./sentences.js";
import { looksLikeInstruction } from "./signal-writing.js";
import { FIRST_PARTY_CATEGORIES } from "./tier1.js";

// A signal is a headline and a link. A reader's own edition can lead with an item only when it has a summary, so a signal is given one: an
// excerpt of the source's own description, one or two whole sentences. It is never written by a model, so it says nothing the source did not,
// and it is shown only in a reader's own edition, beside the link to the source.
const MAX_CHARS = 240;
const MIN_CHARS = 40;
const MAX_SENTENCES = 2;
/** An excerpt is not shown when this much of what it says is already in the headline. */
const REPEATS_HEADLINE = 0.5;

/** The share of the excerpt's words that the headline already has. */
const sharedWithHeadline = (excerpt: string, headline: string): number => {
  const own = terms(excerpt);
  const known = terms(headline);
  return [...own].filter((word) => known.has(word)).length / Math.max(1, own.size);
};

// What a feed appends to a description: the CMS's own "appeared first on", a read-more link, an ellipsis.
const BOILERPLATE = [
  /\s*The post\b[^]*?\bappeared first on\b[^.]*\.?/gi,
  /\s*\[(?:…|\.\.\.)\]/g,
  /\s*(?:Read more|Continue reading|Learn more|Click here|Keep reading)\b[^]*$/i,
];

const hostOf = (value: string): string | null => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const within = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Sites where anyone can publish under the site's own name, so a description there is its author's and not the site's. */
const OPEN_PLATFORMS = [
  "arxiv.org", "openreview.net", "huggingface.co", "github.com", "githubusercontent.com", "gitlab.com", "reddit.com", "x.com", "twitter.com", "medium.com", "substack.com",
  "wordpress.com", "blogspot.com", "dev.to", "hashnode.dev", "lesswrong.com", "alignmentforum.org", "youtube.com", "linkedin.com", "stackoverflow.com", "news.ycombinator.com",
  "bsky.app", "notion.site", "github.io", "vercel.app", "netlify.app", "pages.dev", "web.app", "readthedocs.io",
];

// The first-party routes of each publisher, by the name the collector gives their items and the kind of route: the sites they are on.
const OWN_ROUTES = new Map<string, string[]>();
for (const stream of SOURCE_STREAMS) {
  if (!FIRST_PARTY_CATEGORIES.has(stream.category)) continue;
  const host = hostOf(stream.host ? `https://${stream.host}/` : stream.url);
  if (!host || OPEN_PLATFORMS.some((platform) => within(host, platform))) continue;
  const key = `${stream.publisher}\n${stream.category}`;
  OWN_ROUTES.set(key, [...(OWN_ROUTES.get(key) ?? []), host]);
}

/**
 * Whether a description may be shown as an excerpt: the item came through a first-party route of a publisher the catalog lists, and the page
 * is on that publisher's own site. The text is the source's and not ours, so it is not taken from a post to Hacker News, a trending list,
 * another publisher's feed that links to the page (its blurb would be signed with the page's name), or a site where anyone can publish.
 */
export function mayExcerpt(lead: { url: string; source: string; category: string }): boolean {
  const host = hostOf(lead.url);
  if (!host || lead.source === "Hacker News") return false;
  return (OWN_ROUTES.get(`${lead.source}\n${lead.category}`) ?? []).some((own) => within(host, own));
}

// What a mail program or a reader acts on besides a scheme, a tag and a Markdown link: it links a bare domain, an address and a phone number,
// and reads full-width letters and invisible characters as the letters they look like. Text is checked as it is written and as it reads.
const ACTIONABLE = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\b(?:mailto|tel|sms|javascript|data|file|ftp|vbscript|blob):(?=\S)/i,
  /\bwww\./i,
  // Any word, a dot and a word of two letters or more, whatever the ending and however short the word before it ("t.co"): a mail program links it. A code
  // file suffix is not a domain, and the ones that are (.md, .py, .rs) are not on that list. An address of four numbers is linked too.
  /[\p{L}\p{N}-]+\.(?!(?:js|ts|jsx|tsx|mjs|cjs|json|cpp|txt)(?![\p{L}\p{N}]))\p{L}{2,}/iu,
  /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.]*\d)/,
  /@/,
  /(?:\d[\s().-]{0,2}){9,}/,
  /\]\(|<\/?[a-z][^>]*>/i,
];

/** Text on one line, without the characters that hide or reorder what is shown: line breaks, controls, zero-width and direction marks. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();

/** Every character that is, or is drawn as, the full stop between the labels of a domain. */
const DOTS = String.raw`.\u0589\u06D4\u0701\u0702\u1803\u2024\u2E3C\u3002\uA4F8\uA60E\uFE52\uFF0E\uFF61`;

/**
 * Text as it is printed in an email when it came from outside: a zero-width space after every dot (and look-alike) or at-sign that runs into a letter or
 * digit, and in "://", so that no mail program finds an address or a link in it, whatever its ending or script. The words read the same; this is a
 * second layer under plainProse, which refuses what it recognises, and does not depend on recognising it.
 */
export const unlinkable = (text: string): string => text.replace(new RegExp(`([${DOTS}@\\uFF20\\uFE6B])(?=[\\p{L}\\p{N}])`, "gu"), "$1\u200B").replace(/:\/\//g, ":\u200B//").replace(/\b(www)\b(?=[.\u200B]|\s*\.)/gi, "$1\u200B");

/** Prose that is safe to show as a quotation, as it reads, or null when it holds anything to follow or to obey. */
export function plainProse(text: string): string | null {
  const shown = oneLine(text);
  // Read as a mail program reads it: compatibility forms folded, and the ideographic full stop and its look-alikes as the dot they stand for in a domain,
  // which is when Latin letters or digits are on both sides of it. Between sentences of Chinese or Japanese prose it is only a full stop.
  // A label in another script before it ("例え。jp") is a domain when Latin letters follow that could be an ending and then the word stops.
  const read = shown.normalize("NFKC").replace(/(?<=[A-Za-z0-9-])[\u3002\uFF61\u2024\uFE52](?=[A-Za-z0-9-])|(?<=[\p{L}\p{N}])[\u3002\uFF61\u2024\uFE52](?=[A-Za-z]{2,24}(?:[\s/?#:)\]]|$))/gu, ".");
  return ACTIONABLE.some((pattern) => pattern.test(shown) || pattern.test(read)) || looksLikeInstruction(shown) ? null : shown;
}

/** An excerpt of a source's description for a signal, or null when there is nothing worth showing under the headline. */
export function signalExcerpt(description: string, headline: string): string | null {
  let text = oneLine(description);
  for (const pattern of BOILERPLATE) text = text.replace(pattern, "");
  text = text.replace(/[»›>]+\s*$/, "").trim();
  if (text.length < MIN_CHARS) return null;
  const prose = plainProse(text);
  // In another language it would be shown untranslated, in a quotation, to a reader of an English edition.
  if (!prose || languageOf(prose)) return null;
  text = prose;

  const sentences = splitSentences(text);
  let excerpt = "";
  for (const sentence of sentences.slice(0, MAX_SENTENCES)) {
    const next = excerpt ? `${excerpt} ${sentence}` : sentence;
    if (next.length > MAX_CHARS) break;
    excerpt = next;
  }
  if (!excerpt && sentences[0]) {
    // The first sentence alone runs on: cut at a word and say so.
    const room = sentences[0].slice(0, MAX_CHARS - 1);
    excerpt = `${room.slice(0, Math.max(room.lastIndexOf(" "), MIN_CHARS)).replace(/[\s,;:–-]+$/u, "")}…`;
  }
  if (excerpt.length < MIN_CHARS || sharedWithHeadline(excerpt, headline) >= REPEATS_HEADLINE) return null;
  return excerpt;
}
