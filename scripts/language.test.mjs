import assert from "node:assert/strict";
import test from "node:test";
import { languageOf, languageOfCandidate, translatedTraction } from "../src/pipeline/language.ts";

// A story read in Chinese, Korean or Japanese is written up in English, and the reader is told where it came from and that it was translated.
// The language is decided in code from the source's own title, never by a model.
test("the language of a title follows its script, and a title that is mostly English is English", () => {
  assert.equal(languageOf("台積電宣布高雄新廠動工"), "Chinese");
  assert.equal(languageOf("台积电2纳米量产 先进封装产能紧张"), "Chinese");
  assert.equal(languageOf("台積電2奈米報價再漲 CoWoS先進封裝產能滿載"), "Chinese", "a Latin product name in a Chinese title");
  assert.equal(languageOf("SK하이닉스, HBM4 양산 개시"), "Korean");
  assert.equal(languageOf("TSMCが熊本第2工場の建設を開始"), "Japanese");
  assert.equal(languageOf("TSMC starts building its second Kumamoto fab"), null);
  assert.equal(languageOf("Xiaomi (小米) launches its XRING chip with a 3nm design"), null, "one word of another script in an English title");
  assert.equal(languageOf(""), null);
  assert.equal(languageOf("2026年10月"), "Chinese", "numbers and kanji alone have no Latin letters to outweigh them");
});

test("a title in Han characters alone is read by the site it is on", () => {
  assert.equal(languageOf("国内人事", "https://eetimes.itmedia.co.jp/ee/articles/2610/09/news020.html"), "Japanese");
  assert.equal(languageOf("供應鏈月報", "https://www.digitimes.com.tw/tech/dt/n/shwnws.asp?id=1"), "Chinese");
  assert.equal(languageOf("供應鏈月報", "https://example.com/x"), "Chinese", "Chinese when nothing says otherwise");
  assert.equal(languageOf("國內人事", "https://www.thelec.kr/news/1"), "Korean");
  assert.equal(languageOf("国内人事", "not a url"), "Chinese");
});

test("a story from a source in another language says so beside its attention number, or on its own", () => {
  const lead = { title: "台積電宣布高雄新廠動工", url: "https://www.ctee.com.tw/news/2" };
  assert.equal(translatedTraction(lead, null), "translated from Chinese");
  assert.equal(translatedTraction(lead, "312 HN points"), "translated from Chinese · 312 HN points");
  assert.equal(translatedTraction({ title: "TSMC starts building", url: "https://x.test/" }, "312 HN points"), "312 HN points", "English is left as it is");
  assert.equal(translatedTraction({ title: "TSMC starts building", url: "https://x.test/" }, null), null);
});

// The title is what a reader sees first, but a story can have an English title over a page in Chinese, and then it was written up from a
// translation just the same. The language of a candidate is its title's, or else its description's.
test("a candidate is in the language of its title, or else of its description", () => {
  assert.equal(languageOfCandidate({ title: "TSMC Q3", summary: "台積電第三季營收達1.49兆元，創單季新高，AI需求持續升溫，法人預期第四季仍將成長。", url: "https://www.ctee.com.tw/news/3" }), "Chinese");
  assert.equal(languageOfCandidate({ title: "台積電Q3營收創新高", summary: "TSMC said revenue rose.", url: "https://www.ctee.com.tw/news/3" }), "Chinese", "the title decides first");
  assert.equal(languageOfCandidate({ title: "TSMC Q3", summary: "TSMC said third-quarter revenue rose on AI demand (台積電).", url: "https://x.test/" }), null);
  assert.equal(languageOfCandidate({ title: "TSMC Q3", summary: "", url: "https://x.test/" }), null);
  assert.equal(translatedTraction({ title: "TSMC Q3", summary: "台積電第三季營收達1.49兆元，創單季新高，AI需求持續升溫，法人預期第四季仍將成長。", url: "https://www.ctee.com.tw/news/3" }, null), "translated from Chinese");
});
