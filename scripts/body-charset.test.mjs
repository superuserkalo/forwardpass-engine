import assert from "node:assert/strict";
import test from "node:test";
import { decodeBody } from "../src/lib/body-text.ts";
import { collectSourceStreams } from "../src/lib/source-collector.ts";
import { readCapped } from "../src/lib/source-evidence.ts";

// Much of the Japanese, Korean and Chinese press is still served as Shift_JIS, EUC-KR, Big5 or GBK. Read as UTF-8 its text is garbage, and so is
// every quote taken from it: on 10 October a page of EE Times Japan was "verified" against quotes like "FUJI�́A���Ђ̓d�q". The character set is
// named in the headers, in a meta tag or in the XML declaration, and is read from whichever the page has.
const ascii = (text) => Array.from(new TextEncoder().encode(text));
const bytes = (...parts) => Uint8Array.from(parts.flatMap((part) => typeof part === "string" ? ascii(part) : part));
const SHIFT_JIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];
const EUC_KR_HANGUGEO = [0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee];
const BIG5_TSMC = [0xa5, 0x78, 0xbf, 0x6e, 0xb9, 0x71];
const GBK_TSMC = [0xcc, 0xa8, 0xbb, 0xfd, 0xb5, 0xe7];

test("a body is read in the character set its headers name", () => {
  assert.equal(decodeBody(bytes("<p>", SHIFT_JIS_NIHONGO, "</p>"), "text/html; charset=Shift_JIS"), "<p>日本語</p>");
  assert.equal(decodeBody(bytes(GBK_TSMC), "text/html;charset=gbk"), "台积电");
  assert.equal(decodeBody(bytes(BIG5_TSMC), 'text/html; charset="big5"'), "台積電");
});

test("without a header, the meta tag or the XML declaration names it", () => {
  assert.equal(decodeBody(bytes('<html><head><meta charset="euc-kr"></head><body>', EUC_KR_HANGUGEO, "</body></html>"), "text/html"), '<html><head><meta charset="euc-kr"></head><body>한국어</body></html>');
  assert.match(decodeBody(bytes('<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"></head><body>', SHIFT_JIS_NIHONGO, "</body>"), ""), /日本語/);
  assert.match(decodeBody(bytes('<?xml version="1.0" encoding="Big5"?><rss><title>', BIG5_TSMC, "</title></rss>"), "application/xml"), /台積電/);
});

test("the header wins over the page, and a page that names nothing is UTF-8", () => {
  assert.match(decodeBody(bytes('<meta charset="utf-8">', SHIFT_JIS_NIHONGO), "text/html; charset=shift_jis"), /日本語/);
  assert.equal(decodeBody(new TextEncoder().encode("台積電 TSMC 한국어 日本語"), "text/html"), "台積電 TSMC 한국어 日本語");
  assert.equal(decodeBody(new TextEncoder().encode("plain"), ""), "plain");
  assert.equal(decodeBody(bytes([0xef, 0xbb, 0xbf], "with a byte order mark"), "text/plain; charset=utf-8"), "with a byte order mark");
});

test("a name that is not a character set is ignored, not trusted", () => {
  assert.equal(decodeBody(new TextEncoder().encode("台積電"), "text/html; charset=utf-7"), "台積電");
  assert.equal(decodeBody(new TextEncoder().encode("台積電"), "text/html; charset=../../etc/passwd"), "台積電");
  assert.equal(decodeBody(new TextEncoder().encode("台積電"), "text/html; charset="), "台積電");
});

test("a page captured as evidence is read in its own character set", async () => {
  const response = new Response(bytes("<html><body>", SHIFT_JIS_NIHONGO, "</body></html>"), { headers: { "content-type": "text/html; charset=Shift_JIS" } });
  assert.equal(await readCapped(response, 1_000_000), "<html><body>日本語</body></html>");
});

test("a feed in Big5 or EUC-KR is read in it, so its titles are the publisher's", async () => {
  const stream = { id: "tw", publisher: "Taiwan Press", publisherId: "tw", section: "news", category: "news", kind: "rss", url: "https://example.test/rss.xml" };
  const item = (title, n) => Array.from(bytes(`<item><guid>${n}</guid><title>`, title, `</title><link>https://example.test/a${n}</link><pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item>`));
  const feed = (encoding, title) => bytes(`<?xml version="1.0" encoding="${encoding}"?><rss><channel>`, item(title, 1), "</channel></rss>");
  const now = new Date("2026-09-24T12:00:00.000Z");
  for (const [encoding, title, expected] of [["Big5", BIG5_TSMC, "台積電"], ["EUC-KR", EUC_KR_HANGUGEO, "한국어"]]) {
    const result = await collectSourceStreams(undefined, { now, streams: [stream], fetcher: async () => new Response(feed(encoding, title), { headers: { "content-type": "application/xml" } }) });
    assert.deepEqual(result.items.map(({ title: read }) => read), [expected], encoding);
  }
});

// What a page says about itself is the page's to say, so it is read the way a browser reads it, and no further: a byte order mark first, then the
// header, then a meta tag in the first 1024 bytes of a page that is HTML, or the declaration at the very start of a feed that is XML. A page cannot
// use the declaration to make us read it as something a reader's browser does not, or to blank it.
test("a byte order mark decides before the header and the page", () => {
  assert.equal(decodeBody(bytes([0xef, 0xbb, 0xbf], Array.from(new TextEncoder().encode("台積電"))), "text/html; charset=shift_jis"), "台積電");
  assert.equal(decodeBody(Uint8Array.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]), "text/html; charset=shift_jis"), "ab");
  assert.equal(decodeBody(Uint8Array.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x62]), "text/html"), "ab");
});

test("a meta tag counts only in the first 1024 bytes, as in a browser", () => {
  const padding = "<!-- ".concat("x".repeat(1100), " -->");
  const late = decodeBody(bytes(padding, '<meta charset="shift_jis">', SHIFT_JIS_NIHONGO), "text/html");
  assert.doesNotMatch(late, /日本語/, "read as UTF-8, as the browser would read it");
  const early = decodeBody(bytes('<meta charset="shift_jis">', "<!-- ", "x".repeat(900), " -->", SHIFT_JIS_NIHONGO), "text/html");
  assert.match(early, /日本語/);
});

test("only a page that is HTML is read for a meta tag, and only a feed that is XML for a declaration", () => {
  const japanese = "リリースノート: 日本語";
  const json = `{"body":"<meta charset=\\"shift_jis\\"> ${japanese}"}`;
  assert.equal(decodeBody(new TextEncoder().encode(json), "application/json"), json);
  assert.equal(decodeBody(new TextEncoder().encode(`<meta charset="shift_jis"> ${japanese}`), "text/plain"), `<meta charset="shift_jis"> ${japanese}`);
  assert.equal(decodeBody(new TextEncoder().encode(`<?xml version="1.0" encoding="big5"?> ${japanese}`), "text/html"), `<?xml version="1.0" encoding="big5"?> ${japanese}`, "a declaration in HTML is text");
  assert.equal(decodeBody(new TextEncoder().encode(`<html><meta charset="big5"> ${japanese}`), "application/xml"), `<html><meta charset="big5"> ${japanese}`, "a meta tag in a feed is text");
  assert.equal(decodeBody(new TextEncoder().encode(`  <?xml version="1.0" encoding="big5"?><rss>${japanese}</rss>`), "application/xml"), `  <?xml version="1.0" encoding="big5"?><rss>${japanese}</rss>`, "the declaration is the first thing in the file");
});

test("a page cannot name UTF-16 or an encoding that reads as nothing", () => {
  const text = "<html><body>台積電 TSMC 日本語</body></html>";
  for (const name of ["utf-16le", "utf-16be", "utf-16", "iso-2022-kr", "hz-gb-2312", "iso-2022-cn"]) {
    assert.equal(decodeBody(new TextEncoder().encode(`<meta charset="${name}">${text}`), "text/html"), `<meta charset="${name}">${text}`, name);
    assert.equal(decodeBody(new TextEncoder().encode(`<?xml version="1.0" encoding="${name}"?>${text}`), "application/xml"), `<?xml version="1.0" encoding="${name}"?>${text}`, name);
  }
  assert.equal(decodeBody(new TextEncoder().encode(text), "text/html; charset=iso-2022-kr"), text, "nor can a header that names one");
});
