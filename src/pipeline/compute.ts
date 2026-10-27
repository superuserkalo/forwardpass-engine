import type { Candidate } from "../lib/schemas.js";
import type { StoryRecord } from "../lib/issue.js";
import { languageOfCandidate, type Language } from "./language.js";
import { publisherDomain } from "./publisher-domain.js";
import { FIRST_PARTY_CATEGORIES } from "./tier1.js";

// The Compute lane: news about the physical layer of AI (chips, memory, foundries, packaging, networks, data centers, power) and the
// supply chain and geopolitics that move it, which the attention-ranked shortlist never reaches because chip news has no Hacker News
// points or GitHub stars. Whether a candidate belongs to the lane, and where its claim comes from, are decided here in code.

export type Provenance = "Official" | "Reported" | "Unconfirmed";
type Subject = Pick<Candidate, "title" | "url" | "summary">;

const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
/** A host matches itself and any subdomain of a listed domain. */
const inSet = (host: string, domains: ReadonlySet<string>): boolean => {
  for (let at = host; at.includes("."); at = at.slice(at.indexOf(".") + 1)) if (domains.has(at)) return true;
  return false;
};

/**
 * Trade and news publications about chips, memory, data centers or the Asia supply chain. Any story in one is in the lane. None of them is an
 * official source, and the two lists below share nothing: a publication does not become official by being dedicated to the subject.
 */
export const LANE_PUBLICATIONS: ReadonlySet<string> = new Set([
  "nextplatform.com", "semiconductor-digest.com", "semiwiki.com", "datacenterdynamics.com", "blocksandfiles.com", "digitimes.com", "thelec.net", "chipsandcheese.com", "semianalysis.com",
]);

/**
 * Companies and regulators that make chips, memory, systems and compute capacity, or make the rules for them. When one of them is the source,
 * it is speaking for itself, and the reader is told so. An explicit list: the publishers the pipeline tracks include independent evaluators
 * and research institutes, which are not the company.
 */
export const OFFICIAL_SOURCES: ReadonlySet<string> = new Set([
  // chips, memory, equipment
  "nvidia.com", "amd.com", "intel.com", "qualcomm.com", "apple.com", "arm.com", "broadcom.com", "marvell.com", "tsmc.com", "asml.com", "skhynix.com", "micron.com",
  "samsungsemiconductor.com", "semiconductor.samsung.com", "lamresearch.com", "appliedmaterials.com", "kla.com", "globalfoundries.com",
  // accelerator makers
  "cerebras.ai", "groq.com", "sambanova.ai", "etched.com", "tenstorrent.com",
  // clouds and GPU clouds
  "aws.amazon.com", "cloud.google.com", "blog.google", "azure.microsoft.com", "oracle.com", "coreweave.com", "crusoe.ai", "lambda.ai", "nebius.com",
  "together.ai", "fireworks.ai", "baseten.co", "modal.com", "runpod.io", "vast.ai", "hyperbolic.ai", "nscale.com",
  // labs announcing their own compute
  "openai.com", "anthropic.com", "ai.meta.com", "about.fb.com", "x.ai", "mistral.ai",
  // regulators and filings
  "federalregister.gov", "bis.gov", "commerce.gov", "sec.gov", "ustr.gov", "whitehouse.gov", "mofcom.gov.cn", "meti.go.jp", "europa.eu",
]);

/** Hosts whose every story is about compute: the publications above and the pure-play chip makers and the export-control register. */
const ALWAYS_COMPUTE: ReadonlySet<string> = new Set([
  ...LANE_PUBLICATIONS, "tsmc.com", "asml.com", "skhynix.com", "micron.com", "samsungsemiconductor.com", "semiconductor.samsung.com", "federalregister.gov",
]);

/** Research, code and forum pages are not news about the industry, however often they say GPU or accelerator. */
const NOT_NEWS = new Set(["arxiv.org", "openreview.net", "github.com", "huggingface.co", "pypi.org", "npmjs.com", "reddit.com", "x.com", "twitter.com", "news.ycombinator.com", "stackoverflow.com"]);
const COMMUNITY = new Set(["community", "forum", "forums", "discuss", "discourse", "support", "help", "answers"]);
/** Retail trading and crypto sites: stock and price chatter that mentions the industry. Not news about compute, whatever the headline says. */
const MARKET_CHATTER = new Set(["cryptobriefing.com", "tradingview.com", "coindesk.com", "cointelegraph.com", "benzinga.com", "seekingalpha.com", "fool.com", "investing.com", "stocktwits.com", "zerohedge.com", "finance.yahoo.com", "marketwatch.com"]);

// What the story is about. Company names alone are not here: most of what Nvidia or Google publishes is a model or a tool.
const INDUSTRY = new RegExp(`\\b(?:${[
  String.raw`TSMC`, String.raw`Taiwan Semiconductor`, String.raw`foundr(?:y|ies)`, String.raw`wafers?`, String.raw`(?:chip|semiconductor|wafer|memory|new|AI) fabs?`,
  String.raw`fabs? (?:in|plans?|expansion|construction|capacity)`, String.raw`lithograph\w*`, String.raw`EUV`, String.raw`ASML`, String.raw`GlobalFoundries`, String.raw`SMIC`,
  String.raw`Rapidus`, String.raw`semiconductors?`, String.raw`chip ?makers?`, String.raw`(?:AI|GPU|custom|memory|advanced|leading-edge|Chinese) chips?`,
  String.raw`chips? (?:design|making|supply|shortage|exports?|bans?|controls?|factory|plant|production|demand)`, String.raw`HBM\d?E?`, String.raw`DRAM`, String.raw`NAND`,
  String.raw`SK ?hynix`, String.raw`Micron`, String.raw`(?:RAM|memory) (?:prices?|shortage|supply|makers?|chips?)`, String.raw`CoWoS`, String.raw`advanced packaging`,
  String.raw`chiplets?`, String.raw`co-packaged optics`, String.raw`silicon photonics`, String.raw`NVLink`, String.raw`InfiniBand`, String.raw`Spectrum-X`, String.raw`TPUs?`,
  String.raw`Trainium\d*`, String.raw`Inferentia`, String.raw`MTIA`, String.raw`MI[0-9]{3}[A-Z]?`, String.raw`GB[0-9]{3}`, String.raw`Cerebras`, String.raw`Groq`, String.raw`SambaNova`,
  String.raw`Tenstorrent`, String.raw`d-Matrix`, String.raw`data ?cent(?:er|re)s?`, String.raw`gigawatts?`, String.raw`megawatts?`, String.raw`\d+(?:\.\d+)? ?(?:GW|MW)`,
  String.raw`liquid cooling`, String.raw`hyperscalers?`, String.raw`neoclouds?`, String.raw`compute (?:capacity|deal|cluster|supply|shortage)`,
  String.raw`power (?:grid|supply|demand|constraints?|approval)`, String.raw`export controls?`, String.raw`entity list`, String.raw`chips act`,
  // Capital spending on AI infrastructure, which is how the hyperscalers' results reach compute. Capex that is not about it is not here.
  String.raw`(?:AI|data ?cent(?:er|re)|cloud|hyperscaler)s? capex`, String.raw`(?:Alphabet|Google|Microsoft|Meta|Amazon|AWS|Oracle|Nvidia|OpenAI|xAI|CoreWeave|TSMC|Samsung|Micron|Intel)[^.]{0,40}\bcapex\b`, String.raw`\bcapex\b[^.]{0,40}(?:Alphabet|Google|Microsoft|Meta|Amazon|AWS|Oracle|Nvidia|OpenAI|xAI|CoreWeave|TSMC|Samsung|Micron|Intel)`, String.raw`capital (?:spending|expenditures?) (?:on|for|in) (?:AI|data ?cent\w+|chips?|semiconductors?)`,
].join("|")})\\b`, "i");
// Names that are also words or surnames, so they count only with a hardware word beside them, and in the case the company writes them.
const INDUSTRY_NAMES = new RegExp([
  String.raw`\bGaudi ?[23]\b`, String.raw`\bIntel Gaudi\b`, String.raw`\bMaia ?\d{2,3}\b`, String.raw`\bMicrosoft Maia\b`, String.raw`\bAscend ?\d{3}[A-Z]?\b`, String.raw`\bHuawei Ascend\b`,
  String.raw`\bInstinct (?:MI\d+|GPUs?|accelerators?)`, String.raw`\bEtched (?:AI|raises|funding|valuation|Sohu|chips?|fields|offers|rounds?)`,
  String.raw`\bRubin (?:GPUs?|CPX|Ultra|NVL\d+|platform|chips?|accelerators?|systems?|racks?)\b`, String.raw`\bVera Rubin\b(?! (?:C\. )?(?:Observatory|telescope))`,
  String.raw`\bBlackwell(?: Ultra| GPUs?| B\d+| GB\d+| platform| chips?| accelerators?| systems?| racks?)\b`,
].join("|"));

// Consumer chips have their own positive test before the broad device filter. Memory specs and local-inference results matter even when a
// headline calls the product a gaming GPU or a laptop. Retail offers, peripheral news, stock chatter and security advisories still do not.
const HARD_EXCLUSION = /\b(?:stock(?:s)? (?:prices?|market|rall\w*|falls?|rises?)|share price|price target|analysts?|KOSPI|Nasdaq|S&P ?500|TAIEX|market cap|closing market|monitors?|keyboards?|mouse|headsets?|PC case|(?:best|top).{0,50}\bdeals?|deals? of the (?:day|week)|Prime Day|Black Friday|bundles?|vulnerabilit\w+|flaws?|CVE-\d+|exploits?|zero-day|ransomware|breach)\b/i;
const CONSUMER_PRODUCT = /\b(?:GeForce|RTX ?(?:\d{4}|\d{2}[- ]series)|Radeon(?: RX)?|Intel (?:Arc|Core)|Ryzen|Snapdragon|Apple (?:M\d\w*|silicon)|desktop CPUs?|consumer (?:chips?|GPUs?|CPUs?|processors?)|NPUs?)\b/i;
const CONSUMER_CHIP = new RegExp(`${CONSUMER_PRODUCT.source}|\\b(?:Neural Engine|AI PCs?|VRAM|GDDR\\d\\w*|DDR[45]|GPU memory|graphics memory|unified memory)\\b`, "i");
const CONSUMER_SPEC = /\b(?:VRAM|GDDR\d\w*|DDR[45]|(?:GPU|graphics|unified|shared|system) memory|memory (?:bandwidth|capacity|prices?|supply)|\d+\s*GB|\d+\s*TOPS|cores?|NPUs?|Neural Engine)\b/i;
const CONSUMER_LAUNCH = /\b(?:launch\w*|ship\w*|unveil\w*|introduc\w*|announc\w*|releas\w*|availability|available|supply|shortage|prices?|costs?)\b/i;
const LOCAL_AI = /\b(?:local (?:AI|LLMs?|models?|inference)|on[- ]device (?:AI|inference)|LLM inference|tokens? per second)\b|ローカル.*(?:LLM|推論)|本地.*(?:AI|推理|模型)|로컬.*(?:AI|추론|모델)/i;
const CONSUMER_SPEC_CJK = /顯存|显存|記憶體|内存|記憶体|メモリ|메모리/;
const ROUTINE_DRIVER = /\b(?:graphics? drivers?|Game Ready|WHQL)\b/i;
const DEVICE_NOISE = /\b(?:gaming|gamers?|DLSS|Steam|FPS|reviews?|laptops?|notebooks?|smartphones?|iPhone|Galaxy S\d+|handhelds?|consoles?)\b|開箱|开箱|評測|评测|遊戲|游戏|電競|电竞|리뷰|게이밍|レビュー|ゲーミング/i;

function consumerCompute(title: string, text: string): boolean {
  if (!CONSUMER_CHIP.test(text)) return false;
  if (LOCAL_AI.test(text)) return true;
  if (ROUTINE_DRIVER.test(title)) return false;
  // A game benchmark's boilerplate VRAM spec is not a memory story. A launch with hardware specs is.
  if (DEVICE_NOISE.test(title)) return CONSUMER_LAUNCH.test(title) && CONSUMER_SPEC.test(text);
  return CONSUMER_SPEC.test(title) || CONSUMER_SPEC_CJK.test(title) || (CONSUMER_LAUNCH.test(title) && (CONSUMER_PRODUCT.test(title) || CONSUMER_SPEC.test(text)));
}

// Other consumer gear and security advisories are outside the industry lane.
const NOT_THE_LANE = /\b(?:stocks?|share price|price target|analysts?|KOSPI|Nasdaq|S&P ?500|TAIEX|market cap|closing market|gaming|gamers?|RTX ?\d{4}|Radeon RX|GeForce|DLSS|Steam|FPS|monitors?|keyboards?|mouse|headsets?|PC case|best deals?|top deals?|deals? of the (?:day|week)|Prime Day|Black Friday|reviews?|bundles?|laptops?|notebooks?|Switch 2|PS5|Xbox|motherboards?|coolers?|smartphones?|iPhone|Galaxy S\d+|vulnerabilit\w+|flaws?|CVE-\d+|exploits?|zero-day|ransomware|breach)\b/i;

// The same in Chinese, Korean and Japanese, which are written without spaces, so there is no \b. A term here is one that means the industry in the
// language itself; company names alone are left out for the reason they are above. A term that begins or ends in Latin letters is a word and not a
// piece of an English one ("npu" is in "input", "etf" in "Netflix"), so it is not matched when a Latin letter or digit is beside that end.
const LATIN_BEFORE = "(?<![A-Za-z0-9])";
const LATIN_AFTER = "(?![A-Za-z0-9])";
const INDUSTRY_CJK = new RegExp([
  // Chinese, traditional and simplified
  "台積電", "台积电", "晶圓", "晶圆", "半導體", "半导体", "記憶體", "存储器", "存儲器", "高頻寬記憶體", "高带宽内存", "先進封裝", "先进封装", "封測", "封测", "製程", "制程", "奈米", "纳米",
  "算力", "智算中心", "資料中心", "数据中心", `${LATIN_BEFORE}AI ?伺服器`, `${LATIN_BEFORE}AI ?服务器`, `${LATIN_BEFORE}AI ?(?:晶片|芯片)`, "(?:先進|先进|高階|高端|算力|客製|定制|自研) ?(?:晶片|芯片)",
  "美光", "海力士", "艾司摩爾", "阿斯麦",
  "中芯", "昇騰", "昇腾", "出口管制", "實體清單", "实体清单", "矽光子", "硅光子", "共同封裝光學", "共封装光学", "液冷",
  // Korean
  "반도체", "파운드리", "웨이퍼", `${LATIN_BEFORE}D램`, "디램", "낸드", "메모리", "하이닉스", "\\d ?나노", "수율", "첨단 ?패키징", "어드밴스드 ?패키징", "후공정", "데이터 ?센터", `${LATIN_BEFORE}AI ?가속기`,
  "(?:액체|액침) ?냉각", "수출 ?통제", "엔티티 ?리스트", "전력망", "하이퍼스케일러", "네오클라우드",
  // Japanese
  "半導体", "ファウンドリ", "ウエハ", "ウェハ", "歩留まり", "インターポーザー?", "チップレット", "データセンタ", `${LATIN_BEFORE}AIサーバ`, "液冷", "液浸冷却", "先端パッケージ", "先端実装", "後工程",
  "ラピダス", "キオクシア", "輸出規制", "東京エレクトロン", "アドバンテスト", "シリコンフォトニクス", `${LATIN_BEFORE}AI(?:チップ|半導体|アクセラレーター?)`, `${LATIN_BEFORE}CPOスイッチ`,
  `${LATIN_BEFORE}NPU${LATIN_AFTER}`, `${LATIN_BEFORE}EMIB${LATIN_AFTER}`,
  "メモリー?(?:価格|市況|不足|メーカー)",
].join("|"), "i");
// Not the lane, in those languages: stock-market chatter, consumer gear and security advisories. "Agency" (法人) alone is left out: it is also a
// corporation, and an incorporated research institute.
const NOT_THE_LANE_CJK = new RegExp([
  "漲停", "涨停", "跌停", "收盤", "收盘", "目標價", "目标价", "三大法人", "法人(?:看好|買超|賣超|買進|賣出|目標價|評等)", "股價", "股价", "大盤", "大盘", "外資", "外资", "盤後", "盘后", "盤中", "盘中", "股市",
  "台股", "個股", "个股", "殖利率", "概念股", "本益比", "券商", "投顧", "分析師", "分析师", `${LATIN_BEFORE}ETFs?${LATIN_AFTER}`,
  "코스피", "코스닥", "마감", "순매도", "순매수", "증시", "주가", "목표주가", "종가", "장중", "상한가", "하한가", "시가총액", "투자의견", "공매도", "수혜주", "관련주", "대장주", "테마주",
  "日経平均", "株価", "東証", "終値", "市況", "反落", "続落", "続伸", "株安", "株高", "目標株価", "ストップ高", "ストップ安",
  "開箱", "开箱", "評測", "评测", "手機", "手机", "遊戲", "游戏", "顯卡", "显卡", "筆電", "笔记本", "電競", "电竞", "優惠",
  "스마트폰", "갤럭시", "아이폰", "리뷰", "언박싱", "게이밍", "그래픽카드", "노트북", "할인",
  "スマホ", "レビュー", "ゲーミング", "ノートPC", "セール", "キャンペーン",
  "漏洞", "勒索", "駭客", "黑客", "資安", "信息安全", "網路安全", "해킹", "랜섬웨어", "취약점", "개인정보 ?유출", "情報漏洩", "サイバー攻撃", "脆弱性", "ランサムウェア", "不正アクセス",
].join("|"), "i");

/** Whether a candidate is news about compute: the physical layer of AI and the supply chain behind it. */
export function isComputeCandidate({ title, url, summary }: Subject): boolean {
  const host = hostOf(url);
  if (!host || inSet(host, NOT_NEWS) || inSet(host, MARKET_CHATTER) || host.split(".").some((label) => COMMUNITY.has(label))) return false;
  if (HARD_EXCLUSION.test(title)) return false;
  const text = `${title} ${summary.slice(0, 280)}`;
  if (consumerCompute(title, text)) return true;
  if (NOT_THE_LANE.test(title) || NOT_THE_LANE_CJK.test(title)) return false;
  if (inSet(host, ALWAYS_COMPUTE)) return true;
  return INDUSTRY.test(text) || INDUSTRY_NAMES.test(text) || INDUSTRY_CJK.test(text);
}

// An outlet's own wording that what it says is a rumor, a leak or a single anonymous source.
const RUMOR = /\b(?:rumou?rs?|rumou?red|leak(?:s|ed|er)?|reportedly|sources? (?:say|said|familiar|close)|people (?:familiar|with knowledge)|according to (?:industry |supply[- ]chain |market )?(?:sources|insiders|people)|insiders?|unconfirmed|speculat\w+|allegedly|is said to|are said to)\b/i;

// The same in Chinese, Korean and Japanese: the phrases that mark a report as a rumor or as resting on unnamed sources. A single character such as 傳
// is not here, since it is also in 傳統 (traditional) and 傳輸 (transmission).
const RUMOR_CJK = new RegExp([
  "據傳", "据传", "傳聞", "传闻", "傳言", "传言", "傳出", "传出", "據悉", "据悉", "據報導", "据报道", "消息人士", "知情人士", "爆料", "謠傳", "谣传",
  "알려졌", "전해졌", "전해진다", "전해지고", "업계에 따르면", "업계 관계자", "관계자에 따르면", "소식통", "복수의 관계자",
  "関係者によると", "報道によると", "と報じ", "情報筋", "関係筋", "噂", "うわさ",
].join("|"));

/** How we came to the page: the source and category of the item our collection holds for it, which the page's own words cannot change. */
export type Via = { source: string; category: string };

/**
 * Where the claim comes from, which is not whether it is true: the source itself, a named outlet, or an outlet repeating a rumor. "Official"
 * needs the host to be a company or regulator on the list and, when we know how the page reached us, that it came through a route of the
 * publisher's own: a page of theirs that someone posted to Hacker News or a forum is a story about them, not their statement.
 */
export function provenance({ url, title, summary, text, via }: Subject & { text?: string; via?: Via }): Provenance {
  const host = hostOf(url);
  // A forum or help page on the company's domain is its users talking, not the company.
  const forum = !host || host.split(".").some((label) => COMMUNITY.has(label));
  const firstParty = via === undefined || (via.source !== "Hacker News" && FIRST_PARTY_CATEGORIES.has(via.category));
  if (host && !forum && firstParty && inSet(host, OFFICIAL_SOURCES)) return "Official";
  const words = `${title} ${summary} ${(text ?? "").slice(0, 2000)}`;
  return RUMOR.test(words) || RUMOR_CJK.test(words) ? "Unconfirmed" : "Reported";
}

/** "Official · tsmc.com": the line a reader sees beside a compute story, with a note when it was read in another language and written up in English. */
export function provenanceTag(subject: Subject & { text?: string; via?: Via }): string {
  const host = hostOf(subject.url);
  const language = languageOfCandidate(subject);
  return `${provenance(subject)} · ${host ? publisherDomain(host) : "unknown"}${language ? ` · translated from ${language}` : ""}`;
}

/** What a tag printed by provenanceTag says, read back: where the claim comes from, the site, and the language it was translated from when it was. */
export type ParsedTag = { provenance: Provenance; site: string; language: Language | null };
const SITE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const LANGUAGES: readonly Language[] = ["Chinese", "Korean", "Japanese"];

/** The inverse of provenanceTag, for what is saved with a story. Null for a story that has no such tag, which is a story that is not compute news. */
export function parseComputeTag(traction: string | null | undefined): ParsedTag | null {
  const [first, site, ...rest] = (traction ?? "").split(" · ");
  if (first !== "Official" && first !== "Reported" && first !== "Unconfirmed") return null;
  if (!site || !SITE.test(site)) return null;
  const note = rest.find((part) => part.startsWith("translated from "));
  return { provenance: first, site, language: LANGUAGES.find((language) => note === `translated from ${language}`) ?? null };
}

type Topic = StoryRecord["topics"][number];
const POWER_STORY = /\b(?:data ?cent(?:er|re)s?|gigawatts?|megawatts?|\d+(?:\.\d+)? ?(?:GW|MW)|power|cooling|grid|hyperscalers?|neoclouds?)\b/i;
const POWER_STORY_CJK = /資料中心|数据中心|數據中心|데이터 ?센터|データセンタ/;

/**
 * What marks a compute story wherever it sits in the issue, featured or a signal: where its claim comes from, shown where an attention number
 * would be (beside it when there is one), and a compute topic put first when triage gave none, so a reader who follows Chips or Data centers
 * is shown it. Null for a story that is not about compute.
 */
export function computeMarks({ lead, text, traction, topics }: { lead: Pick<Candidate, "title" | "url" | "summary" | "source" | "category">; text?: string; traction: string | null; topics: readonly Topic[] }): { traction: string; topics: Topic[] } | null {
  if (!isComputeCandidate(lead)) return null;
  const tag = provenanceTag({ url: lead.url, title: lead.title, summary: lead.summary, text, via: { source: lead.source, category: lead.category } });
  const hasLane = topics.some((topic) => topic === "Chips" || topic === "Data centers");
  const subject = `${lead.title} ${lead.summary.slice(0, 280)}`;
  const lane: Topic = !consumerCompute(lead.title, subject) && (POWER_STORY.test(subject) || POWER_STORY_CJK.test(subject)) ? "Data centers" : "Chips";
  return { traction: traction ? `${tag} · ${traction}` : tag, topics: hasLane ? [...topics] : [lane, ...topics].slice(0, 3) };
}
