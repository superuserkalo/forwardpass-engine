// The character set of a page or a feed. The Japanese, Korean and Chinese press is still often served as Shift_JIS, EUC-KR, Big5 or GBK, and read as
// UTF-8 its text is garbage, and so is every quote taken from it. A response is read the way a browser reads it, and no further, because what a page
// says about itself is the page's to say: a byte order mark first, then the header, then a meta tag in the first 1024 bytes of a page that is HTML, or
// the declaration at the very start of a feed that is XML. A name the runtime does not know is ignored, and so is one that would read the page as
// UTF-16 or as nothing, so a page cannot use it to be read differently from how a reader's browser reads it, or to blank itself.

const PRESCAN_BYTES = 1024;
const NAME = String.raw`([A-Za-z0-9][A-Za-z0-9_.:-]*)`;
const HEADER = new RegExp(String.raw`charset\s*=\s*["']?\s*${NAME}`, "i");
const XML_DECLARATION = new RegExp(String.raw`^<\?xml[^>]*?\bencoding\s*=\s*["']\s*${NAME}\s*["']`, "i");
const META = new RegExp(String.raw`<meta[^>]+charset\s*=\s*["']?\s*${NAME}`, "i");
const BYTE_ORDER_MARKS: readonly (readonly [readonly number[], string])[] = [[[0xef, 0xbb, 0xbf], "utf-8"], [[0xff, 0xfe], "utf-16le"], [[0xfe, 0xff], "utf-16be"]];

/** The encoding a name stands for, or null when the runtime does not know it or it would read as nothing. */
function known(name: string | undefined): string | null {
  if (!name) return null;
  try {
    const { encoding } = new TextDecoder(name);
    return encoding === "replacement" ? null : encoding;
  } catch { return null; }
}

/** A name found inside the page is not honored when it says UTF-16: the markup that names it is ASCII, so the page cannot be UTF-16. */
const fromPage = (name: string | undefined): string | null => {
  const encoding = known(name);
  return encoding && !encoding.startsWith("utf-16") ? encoding : null;
};

function charsetOf(bytes: Uint8Array, contentType: string): string {
  for (const [mark, encoding] of BYTE_ORDER_MARKS) if (mark.every((byte, i) => bytes[i] === byte)) return encoding;
  const named = known(HEADER.exec(contentType)?.[1]);
  if (named) return named;
  // Whatever the page's character set, the markup that names it is ASCII, so it reads the same here.
  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, PRESCAN_BYTES));
  const xml = !contentType || /xml/i.test(contentType);
  const html = !contentType || /html/i.test(contentType);
  return (xml ? fromPage(XML_DECLARATION.exec(head)?.[1]) : null) ?? (html ? fromPage(META.exec(head)?.[1]) : null) ?? "utf-8";
}

/** The text of a response body in the character set it names: a byte order mark's, else the header's, else the page's own, else UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType = ""): string {
  try { return new TextDecoder(charsetOf(bytes, contentType)).decode(bytes); }
  catch { return new TextDecoder().decode(bytes); }
}
