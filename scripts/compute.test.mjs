import assert from "node:assert/strict";
import test from "node:test";
import { computeMarks, isComputeCandidate, LANE_PUBLICATIONS, OFFICIAL_SOURCES, provenance, provenanceTag } from "../src/pipeline/compute.ts";

// The Compute lane: which candidates are about chips, memory, data centers and the supply chain, and where a claim comes from. The
// titles are real ones from the collected pool of 30 September to 9 October, including the ones a keyword filter gets wrong.
const item = (title, url, summary = "") => ({ title, url, summary });

test("news about chips, memory, foundries, data centers, power and export controls is in the lane, from any publisher", () => {
  for (const [title, url] of [
    ["Micron's Numbers Show Why HBM4 Memory Is Worth 15X Its Weight In Gold", "https://www.nextplatform.com/2026/10/08/micron-hbm4/"],
    ["RAM supply set to worsen, says Micron, as CEO celebrates 'much higher' prices", "https://www.theregister.com/2026/10/01/micron_ram/"],
    ["Nvidia's $20bn licensing deal with Groq faces lawsuit from jilted engineers", "https://www.ft.com/content/abc"],
    ["Etched fields funding offers at $40B+ valuation, sources say", "https://techcrunch.com/2026/10/05/etched/"],
    ["AMD vows to massively increase chip supply in 2027 as AI demand keeps growing", "https://www.techspot.com/news/amd-supply.html"],
    ["Power approval set to delay Oracle's Wisconsin AI datacenter", "https://www.theregister.com/2026/10/02/oracle_wisconsin/"],
    ["Samsung profit surges ninefold to $80bn on AI chip demand", "https://www.ft.com/content/def"],
    ["GlobalFoundries to produce silicon interposers for TSMC's CoWoS in the US", "https://www.tomshardware.com/pc-components/gf-cowos"],
    ["China races to build AI data centres across energy-rich hinterland", "https://www.ft.com/content/ghi"],
    ["Department of War dishes out $1.5 billion loan commitment to boost semiconductor supply chain", "https://www.tomshardware.com/tech-industry/loan"],
    ["HBM4 Demand Holds Firm As Rubin Keeps 12 Layers", "https://www.businesskorea.co.kr/news/articleView.html?idxno=1"],
    ["Optical illusion: Is co-packaged optics the savior the data center industry has been waiting for?", "https://www.datacenterdynamics.com/en/analysis/cpo/"],
    ["US tightens export controls on advanced AI chips to Gulf buyers", "https://www.federalregister.gov/documents/2026/09/30/x"],
    ["Bitdeer AI signs 67MW AI cloud agreement in Malaysia", "https://www.datacenterdynamics.com/en/news/bitdeer/"],
  ]) assert.equal(isComputeCandidate(item(title, url)), true, title);
});

test("capital spending on AI infrastructure is in the lane, and capex that is not about it is not", () => {
  for (const [title, url] of [
    ["Alphabet lifts 2026 capex guidance to $93bn as AI demand outruns capacity", "https://www.reuters.com/technology/alphabet-capex/"],
    ["Meta raises capex forecast again to build AI data centers", "https://www.theregister.com/2026/10/29/meta_capex/"],
    ["Microsoft cloud capex hits a record as Azure AI demand climbs", "https://www.cnbc.com/2026/10/29/microsoft-capex.html"],
    ["Amazon plans capital spending on AI chips and data centers of $150bn", "https://www.ft.com/content/amzn"],
  ]) assert.equal(isComputeCandidate(item(title, url)), true, title);
  for (const [title, url] of [
    ["Retailer cuts capex on new stores as foot traffic falls", "https://www.reuters.com/business/retail-capex/"],
    ["Airline trims capex plans after fuel costs jump", "https://www.reuters.com/business/airline-capex/"],
  ]) assert.equal(isComputeCandidate(item(title, url)), false, title);
});

test("a dedicated chip or data center publication is in the lane whatever the headline says", () => {
  assert.equal(isComputeCandidate(item("Interview: how a small team ships a fab tool", "https://www.semiconductor-digest.com/2026/interview/")), true);
  assert.equal(isComputeCandidate(item("DCD Studio: Workforce Development", "https://www.datacenterdynamics.com/en/podcasts/x/")), true);
  assert.equal(isComputeCandidate(item("Samsung signs new supply agreement", "https://www.digitimes.com/news/a1.html")), true);
});

// The collection reads Chinese, Korean and Japanese publications in their own language, which is where much supply-chain news appears first.
test("compute news in Chinese, Korean or Japanese is in the lane from a mixed outlet, and what is not about compute is not", () => {
  for (const [title, url] of [
    ["AI掀缺貨潮史上首見 記憶體廠砸6,744億元台灣擴產", "https://www.ctee.com.tw/news/20261009700123-430502"],
    ["台積電2奈米報價再漲 CoWoS先進封裝產能滿載", "https://technews.tw/2026/10/09/tsmc-2nm/"],
    ["輝達Rubin需求強勁 AI伺服器供應鏈出貨看旺", "https://www.cna.com.tw/news/afe/202610090123.aspx"],
    ["엔비디아 HBM4 공급 확대…SK하이닉스 증설 속도", "https://www.etnews.com/20261009000123"],
    ["삼성전자 파운드리 2나노 수율 개선 속도", "https://www.hankyung.com/article/2026100912345"],
    ["TSMCが熊本第2工場の建設を開始 先端半導体の増産へ", "https://eetimes.itmedia.co.jp/ee/articles/2610/09/news012.html"],
    ["データセンターの電力需要が急増 AIサーバー向け液冷が普及", "https://xtech.nikkei.com/atcl/nxt/news/18/00123/"],
  ]) assert.equal(isComputeCandidate(item(title, url)), true, title);
  for (const [title, url] of [
    ["滑手機停不下來不是沒定力，科學證實科技正悄悄改寫你的大腦化學", "https://technews.tw/2026/10/09/phone/"],
    ["iPhone 18 Pro Max 開箱評測 相機升級有感嗎", "https://technews.tw/2026/10/09/iphone-review/"],
    ["台積電漲停收盤 目標價上調 法人看好", "https://www.ctee.com.tw/news/stock-close"],
    ["오픈AI서 해고된 연구원 \"AI 추론 과정 감시해야\"", "https://www.hankyung.com/article/2026100900001"],
    ["코스피 마감 외국인 순매도 반도체 약세", "https://www.hankyung.com/article/market-close"],
    ["国内で大規模な情報漏洩相次ぐ AI使うサイバー攻撃", "https://xtech.nikkei.com/atcl/nxt/news/18/00124/"],
    ["日経平均が反落 半導体株に売り", "https://xtech.nikkei.com/atcl/market-close"],
  ]) assert.equal(isComputeCandidate(item(title, url)), false, title);
});

// The Chinese and Korean trade outlets are mixed too: DigiTimes Taiwan's tech channel runs car makers and the Fed beside supply-chain news, and The
// Elec's Korean feed runs office software, batteries and event marketing. They are read by what each story is about, not taken whole. These are
// their headlines of 10 October.
test("DigiTimes Taiwan and The Elec Korean are in the lane for their chip and data center stories and not for the rest", () => {
  const digitimes = (title) => item(title, "https://www.digitimes.com.tw/tech/dt/n/shwnws.asp?id=1");
  const elec = (title) => item(title, "https://www.thelec.kr/news/articleView.html?idxno=1");
  for (const title of ["一手買NVIDIA、一手建Terafab SpaceX打造AI算力雙軌策略", "DIGITIMES Today：三星HBM4帶旺4奈米產線 | 台廠無人機拚系統整合組隊作戰 | 華為已基本擺脫美技術依賴"]) assert.equal(isComputeCandidate(digitimes(title)), true, title);
  for (const title of [
    "本田北美新世代油電車量產延後 CR-V改2027年4月後上線",
    "Fed年底前可能再升息1碼 次級市場流動性待觀察",
    "經濟部明令禁止進口中國製玻纖矽質套管 產發署說明原因",
    "Meta攜Walmart、Stripe推AI代理標準 盼解決網站封鎖問題",
    "供應鏈月報",
  ]) assert.equal(isComputeCandidate(digitimes(title)), false, title);
  for (const title of [
    "버티브 2.3MW CDU, '엔비디아 DSX 레디' 요건 충족",
    "kt클라우드, 50MW급 청라 AI 데이터센터 구축 참여…2030년 1분기 준공",
    "ASML, 유지보수용 노광장비 부품값 10% 일괄 인상",
    "반도체 세정장비에 AI 심는다…미스릴, S사와 제품화 계약",
  ]) assert.equal(isComputeCandidate(elec(title)), true, title);
  for (const title of [
    "앤트로픽, 오피스 툴 정식 출시…자연어 기반 데이터 시각화 추가",
    "세일즈포스-인스파이어, MICE 산업 AX 전략적 협력",
    "무라타, 베트남 호치민에 인덕터 코일 공장 증설 완료",
    "서울 본사 이전 소식",
  ]) assert.equal(isComputeCandidate(elec(title)), false, title);
});

// EE Times Japan covers power parts, sensors, materials and consumer gear as well as chips for AI, so it is read by what each story is about. These
// are its headlines of 10 October.
test("EE Times Japan is in the lane for its chip and data center stories and not for the rest", () => {
  const at = (title) => item(title, "https://eetimes.itmedia.co.jp/ee/articles/2610/10/news001.html");
  for (const title of [
    "AIがけん引、半導体市場が1兆ドル突破 先端実装／通信にも波",
    "GFがTSMCの「CoWoS」用Siインターポーザー米国生産",
    "歩留まり改善は「LLMだけでは不十分」 米AI新興の挑戦",
    "AIデータセンターの800VDC化へ InfineonとEatonが協業",
    "BroadcomのCPOスイッチ実装に「業界初成功」、FUJI",
    "Intel CEOが来日 次世代「EMIB-T」で日本との協業重視",
    "GPUやCPU、メモリを低遅延で接続　新チップレット",
    "「800V時代」のAIサーバ電源狙うローム　EV減速を補う成長市場に",
    "「推論コストをゼロ近くに」　韓国NPU新興が日本へ",
    "Micronの業績、利益額は4四半期連続、利益率は3四半期連続で過去最高を更新",
  ]) assert.equal(isComputeCandidate(at(title)), true, title);
  for (const title of [
    "ボイスレコーダーが欲しかったので個性派スマホを買った",
    "細田守×核融合炉新興の対談も 「Japan Summit 2026」10/21～22開催",
    "直流抵抗を約5割低減　太陽誘電のパワーインダクター",
    "135GHz帯で最大8GHz幅　6G向けアンテナモジュール",
    "CEATEC 2026大臣賞は三菱電機／TDK／日立 来場11万人超見込む",
    "生体内の微小な圧力を測る蛍光ナノセンサー 東京科学大ら",
    "国内人事",
  ]) assert.equal(isComputeCandidate(at(title)), false, title);
});

test("a report in Chinese, Korean or Japanese that hedges itself is unconfirmed, and one that does not is reported", () => {
  const at = (title, url, text = "") => provenance({ url, title, summary: "", text });
  assert.equal(at("台積電2奈米據傳再漲價 業界傳出客戶已收到通知", "https://www.ctee.com.tw/news/1"), "Unconfirmed");
  assert.equal(at("輝達訂單據悉轉向三星", "https://technews.tw/2026/10/09/a/"), "Unconfirmed");
  assert.equal(at("供應鏈消息人士指出HBM4良率改善", "https://www.digitimes.com.tw/tech/dt/n/shwnws.asp?id=2"), "Unconfirmed");
  assert.equal(at("삼성전자, 엔비디아 HBM4 수주한 것으로 알려졌다", "https://www.thelec.kr/news/articleView.html?idxno=2"), "Unconfirmed");
  assert.equal(at("업계에 따르면 SK하이닉스가 증설을 검토 중이다", "https://www.etnews.com/20261009000124"), "Unconfirmed");
  assert.equal(at("TSMCが増産へ 関係者によると熊本に第3工場", "https://eetimes.itmedia.co.jp/ee/articles/2610/09/news030.html"), "Unconfirmed");
  assert.equal(at("台積電宣布高雄新廠動工", "https://www.ctee.com.tw/news/2"), "Reported");
  assert.equal(at("SK하이닉스, HBM4 양산 개시", "https://www.etnews.com/20261009000125"), "Reported");
  assert.equal(at("台灣傳統產業導入AI", "https://technews.tw/2026/10/09/b/"), "Reported", "傳統 (traditional) is not a hedge");
  assert.equal(at("伺服器傳輸速度提升", "https://technews.tw/2026/10/09/c/"), "Reported", "傳輸 (transmission) is not a hedge");
});

test("a story read in another language says so beside where it comes from", () => {
  const tag = (title, url) => provenanceTag({ url, title, summary: "" });
  assert.equal(tag("台積電宣布高雄新廠動工", "https://www.ctee.com.tw/news/2"), "Reported · ctee.com.tw · translated from Chinese");
  assert.equal(tag("SK하이닉스, HBM4 양산 개시", "https://www.etnews.com/20261009000125"), "Reported · etnews.com · translated from Korean");
  assert.equal(tag("TSMCが熊本第2工場の建設を開始", "https://eetimes.itmedia.co.jp/ee/articles/2610/09/news012.html"), "Reported · itmedia.co.jp · translated from Japanese");
  assert.equal(tag("TSMC starts building its second Kumamoto fab", "https://www.theregister.com/2026/10/09/tsmc/"), "Reported · theregister.com", "English needs nothing");
  assert.equal(tag("台積電2奈米據傳再漲價", "https://www.digitimes.com.tw/tech/dt/n/shwnws.asp?id=3"), "Unconfirmed · digitimes.com.tw · translated from Chinese");
  // The language follows the headline when there is one, whatever the outlet usually writes.
  assert.equal(tag("TSMC reports third quarter results", "https://www.ctee.com.tw/news/en/1"), "Reported · ctee.com.tw");
});

test("a mixed publication is in the lane only when the story is about compute", () => {
  assert.equal(isComputeCandidate(item("Mistral's new Large 4 trails some Chinese open models in independent tests", "https://www.tomshardware.com/tech-industry/mistral")), false);
  assert.equal(isComputeCandidate(item("Anthropic claims Chinese AI firms secretly use Claude. Is it true?", "https://www.scmp.com/tech/x")), false);
  assert.equal(isComputeCandidate(item("Japan machine tool order backlog hits all-time high on AI demand", "https://asia.nikkei.com/business/a")), false);
  assert.equal(isComputeCandidate(item("Synopsys looks to work with Chinese AI labs to speed up chip design", "https://asia.nikkei.com/business/tech/semiconductors/synopsys")), true, "a chip design story from a mixed publication");
});

test("the words a keyword filter gets wrong do not put a story in the lane", () => {
  for (const [title, url, summary] of [
    ["Midfield options and a fab front four - what we've learned about England", "https://www.bbc.co.uk/sport/football/1", "England fans loved the fab display."],
    ["Instinct's new product recommendations are giving some users the ick", "https://techcrunch.com/2026/09/30/instinct/", "The AI agent Instinct suggests products."],
    ["Image generation loses reference and task state in long multi-image projects", "https://community.openai.com/t/image/1", "Reports of failed generation in chip-like batches."],
    ["Instinct brings its AI agent to group chats, even for friends without an account", "https://techcrunch.com/2026/10/05/instinct-groups/", ""],
    ["Atlassian warns of critical file access flaw in its datacenter products", "https://www.theregister.com/2026/10/06/atlassian/", ""],
    ["Chipotle adds an AI ordering assistant", "https://www.example.test/chipotle", "The chain says orders are faster."],
  ]) assert.equal(isComputeCandidate(item(title, url, summary)), false, title);
});

test("research, code and forum pages are not news about the industry, even when they say GPU or accelerator", () => {
  for (const url of ["https://arxiv.org/abs/2610.00001", "https://github.com/acme/kernels", "https://huggingface.co/acme/model", "https://pypi.org/project/accel/", "https://discuss.huggingface.co/t/h100-hour/1", "https://news.ycombinator.com/item?id=1", "https://www.reddit.com/r/LocalLLaMA/x"]) {
    assert.equal(isComputeCandidate(item("FlashAttention kernel for Blackwell accelerators cuts HBM traffic 40%", url, "A new GPU kernel for TPUs and Trainium.")), false, url);
  }
});

test("stock-market chatter and consumer gear are out of the lane unless it is the company itself", () => {
  for (const [title, url] of [
    ["[Closing Market] KOSPI Retreats to 6,600 Level Despite Samsung's Record Profit", "https://www.businesskorea.co.kr/news/articleView.html?idxno=2"],
    ["Nvidia stock falls as analyst cuts price target on AI chip demand worries", "https://www.tradingview.com/news/x"],
    ["MSI Prestige N16 Flip AI+ Brings NVIDIA RTX Spark To Deliver Up To 1 Petaflop", "https://wccftech.com/msi-prestige-n16/"],
    ["Best gaming GPUs in 2026: RTX 5070 review and benchmarks", "https://www.tomshardware.com/reviews/best-gpus"],
    ["GMKtec EVO-X3 Mini-PC Review", "https://www.servethehome.com/gmktec-evo-x3-review/"],
  ]) assert.equal(isComputeCandidate(item(title, url)), false, title);
});

test("where a claim comes from: the company or regulator itself, a named outlet, or an outlet repeating a rumor", () => {
  assert.equal(provenance({ url: "https://pr.tsmc.com/english/news/3200", title: "TSMC reports third quarter results", summary: "" }), "Official");
  assert.equal(provenance({ url: "https://nvidianews.nvidia.com/news/x", title: "NVIDIA announces Rubin availability", summary: "" }), "Official");
  assert.equal(provenance({ url: "https://news.skhynix.com/hbm4/", title: "SK hynix ships HBM4", summary: "" }), "Official");
  assert.equal(provenance({ url: "https://www.federalregister.gov/documents/2026/09/30/x", title: "Export rule", summary: "" }), "Official");
  assert.equal(provenance({ url: "https://www.ft.com/content/abc", title: "Samsung profit surges ninefold to $80bn", summary: "Samsung said preliminary operating profit rose." }), "Reported");
  assert.equal(provenance({ url: "https://www.digitimes.com/news/a2.html", title: "TSMC reportedly raises 2nm prices", summary: "" }), "Unconfirmed");
  assert.equal(provenance({ url: "https://wccftech.com/x/", title: "Rubin Ultra specs leak", summary: "" }), "Unconfirmed");
  assert.equal(provenance({ url: "https://www.thelec.net/news/1", title: "Samsung wins HBM4 order", summary: "", text: "According to industry sources, Samsung has won the order." }), "Unconfirmed", "the page text counts, not only the headline");
  assert.equal(provenance({ url: "https://www.ft.com/content/def", title: "Micron expects shortages to continue", summary: "The company said it expects supply to stay tight." }), "Reported", "'expects' is a forecast, not a rumor");
  // An official source is official even when its words are hedged: it is the company's own statement.
  assert.equal(provenance({ url: "https://news.skhynix.com/x", title: "SK hynix may expand capacity", summary: "" }), "Official");
});

test("a company announcing its own capacity is official, wherever it publishes, but a forum on its domain is not", () => {
  assert.equal(provenance({ url: "https://www.together.ai/blog/b300-on-ibm-cloud", title: "Together AI adds a dedicated NVIDIA B300 inference cluster on IBM Cloud", summary: "" }), "Official");
  assert.equal(provenance({ url: "https://modal.com/blog/h100-capacity", title: "Modal adds H100 capacity", summary: "" }), "Official");
  assert.equal(provenance({ url: "https://rocm.blogs.amd.com/artifacts/mi455x/", title: "AMD compares MI455X and MI355X", summary: "" }), "Official");
  assert.equal(provenance({ url: "https://community.openai.com/t/gpu-capacity/1", title: "GPU capacity", summary: "" }), "Reported", "a community post is not the company's statement");
  assert.equal(provenance({ url: "https://www.digitimes.com/news/a3.html", title: "Together AI adds a dedicated NVIDIA B300 inference cluster", summary: "" }), "Reported", "and an outlet reporting it is still an outlet");
});

test("the tag names the provenance and the outlet, and the outlet is the publisher's domain", () => {
  assert.equal(provenanceTag({ url: "https://pr.tsmc.com/english/news/3200", title: "TSMC reports results", summary: "" }), "Official · tsmc.com");
  assert.equal(provenanceTag({ url: "https://www.digitimes.com/news/a2.html", title: "TSMC reportedly raises 2nm prices", summary: "" }), "Unconfirmed · digitimes.com");
  assert.equal(provenanceTag({ url: "https://www.theregister.com/2026/10/01/micron_ram/", title: "RAM supply set to worsen, says Micron", summary: "" }), "Reported · theregister.com");
});

// "Official" is a label a reader trusts: the company, regulator or filing is the one speaking. It is decided by an explicit list of them, kept apart
// from the trade press, and by how we came to the page.
test("a trade publication is never official, however dedicated it is to the subject, and the two lists share nothing", () => {
  for (const host of LANE_PUBLICATIONS) {
    assert.ok(!OFFICIAL_SOURCES.has(host), `${host} is a publication and is in the official list`);
    assert.notEqual(provenance({ url: `https://${host}/news/a1`, title: "TSMC expands capacity", summary: "" }), "Official", host);
  }
  for (const url of ["https://www.digitimes.com/news/a1.html", "https://newsletter.semianalysis.com/p/x", "https://www.tomshardware.com/x", "https://www.scmp.com/tech/x", "https://asia.nikkei.com/business/x"]) {
    assert.notEqual(provenance({ url, title: "Nvidia expands capacity", summary: "" }), "Official", url);
  }
});

test("an independent evaluator or a publisher we track is not the company speaking about itself", () => {
  for (const url of ["https://epoch.ai/data-insights/hbm-supply", "https://artificialanalysis.ai/hardware", "https://mlcommons.org/2026/10/mlperf-results/", "https://lmarena.ai/blog/x", "https://hai.stanford.edu/ai-index", "https://github.com/some-user/hbm-notes"]) {
    assert.notEqual(provenance({ url, title: "HBM supply estimate", summary: "" }), "Official", url);
  }
});

test("a host that only looks like an official one is not", () => {
  for (const url of ["https://nvidia.com.evil.test/blog/x", "https://evil.test/nvidia.com/blog", "https://nvidia.com@evil.test/blog", "https://notnvidia.com/blog", "https://amd.com.evil.test/x", "https://nvidia-com.example/blog", "https://xn--nvidia-gwb.com/blog"]) {
    assert.equal(provenance({ url, title: "Nvidia announces Rubin", summary: "" }), "Reported", url);
  }
});

test("an official page we found through a submission or a community post is reported, not official", () => {
  const url = "https://news.skhynix.com/hbm4-mass-production/";
  const subject = { url, title: "SK hynix starts HBM4 mass production", summary: "" };
  assert.equal(provenance(subject), "Official", "with nothing known about how it was found, the host decides");
  assert.equal(provenance({ ...subject, via: { source: "SK hynix Newsroom", category: "news" } }), "Official", "collected from the company's own route");
  assert.equal(provenance({ ...subject, via: { source: "Hacker News", category: "community signal" } }), "Reported", "found on Hacker News");
  assert.equal(provenance({ ...subject, via: { source: "Reddit", category: "community" } }), "Reported");
  assert.equal(provenance({ ...subject, via: { source: "Some Aggregator", category: "directory" } }), "Reported");
  assert.equal(provenanceTag({ ...subject, via: { source: "Hacker News", category: "community signal" } }), "Reported · skhynix.com");
});

test("trading and crypto sites are not news about compute, even when the headline is", () => {
  for (const host of ["cryptobriefing.com", "tradingview.com", "coindesk.com", "cointelegraph.com", "benzinga.com", "seekingalpha.com", "fool.com", "investing.com", "stocktwits.com", "zerohedge.com", "finance.yahoo.com", "marketwatch.com"]) {
    assert.equal(isComputeCandidate(item("San Francisco hits pause on new data centers with a 45-day moratorium", `https://www.${host}/news/a1`)), false, host);
    assert.equal(isComputeCandidate(item("Nvidia unveils Rubin AI chip with HBM4 capacity", `https://${host}/x`)), false, host);
  }
  assert.equal(isComputeCandidate(item("San Francisco hits pause on new data centers with a 45-day moratorium", "https://www.sfchronicle.com/tech/a1")), true, "the same news from a newspaper is in");
});

// Compute stories are ordinary stories in the issue: featured or a signal, picked by the same editor. What marks one is where its claim comes
// from, shown where an attention number would be, and a compute topic so a reader who follows Chips or Data centers is shown it.
const lead = (over = {}) => ({ title: "GlobalFoundries signs $2B TSMC deal", url: "https://www.semiconductor-digest.com/gf-tsmc", summary: "GlobalFoundries will make interposers for TSMC's CoWoS in the US.", source: "Semiconductor Digest", category: "news", ...over });

test("a compute story is marked with where its claim comes from, beside any attention number, and a compute topic", () => {
  const plain = computeMarks({ lead: lead(), traction: null, topics: ["Business", "LLMs"] });
  assert.deepEqual(plain, { traction: "Reported · semiconductor-digest.com", topics: ["Chips", "Business", "LLMs"] });
  const withNumber = computeMarks({ lead: lead(), traction: "312 HN points", topics: ["Chips"] });
  assert.deepEqual(withNumber, { traction: "Reported · semiconductor-digest.com · 312 HN points", topics: ["Chips"] }, "the number is kept, the topics already had one");
  const power = computeMarks({ lead: lead({ title: "Oracle's Wisconsin AI datacenter delayed by a power approval", url: "https://www.theregister.com/2026/10/02/oracle/", summary: "A 1.4GW campus." }), traction: null, topics: [] });
  assert.deepEqual(power, { traction: "Reported · theregister.com", topics: ["Data centers"] });
  assert.equal(computeMarks({ lead: lead(), traction: null, topics: ["A", "B", "C"] }).topics.length, 3, "at most three topics");
});

test("a story that is not about compute is not marked, and the tag follows how the page reached us", () => {
  assert.equal(computeMarks({ lead: lead({ title: "Mistral launches Large 4", url: "https://mistral.ai/news/large-4/", summary: "A new frontier model." }), traction: null, topics: ["LLMs"] }), null);
  assert.equal(computeMarks({ lead: lead({ url: "https://news.skhynix.com/hbm4/", title: "SK hynix starts HBM4 mass production", source: "SK hynix Newsroom", category: "news" }), traction: null, topics: [] }).traction, "Official · skhynix.com");
  assert.equal(computeMarks({ lead: lead({ url: "https://news.skhynix.com/hbm4/", title: "SK hynix starts HBM4 mass production", source: "Hacker News", category: "community signal" }), traction: null, topics: [] }).traction, "Reported · skhynix.com");
  assert.equal(computeMarks({ lead: lead({ title: "TSMC reportedly raises 2nm prices" }), text: "", traction: null, topics: [] }).traction, "Unconfirmed · semiconductor-digest.com");
  assert.match(computeMarks({ lead: lead(), text: "According to industry sources, the deal is set.", traction: null, topics: [] }).traction, /^Unconfirmed/, "the page text counts");
});

// The terms in Chinese, Korean and Japanese include a few Latin ones (NPU, EMIB, ETF, AI servers). They match as words and not inside English ones:
// "npu" is in "input" and "unpublished", and "etf" is in "Netflix".
test("the Latin terms in the Chinese, Korean and Japanese lists match as words, not inside English ones", () => {
  for (const title of [
    "Microsoft adds a new input method to Teams for tablets",
    "Unpublished memo shows how the studio planned its next game",
    "Apple sets a keynote for its next Vision headset input device",
    "Pembroke emibrates the old plan",
  ]) assert.equal(isComputeCandidate(item(title, "https://www.example-news.test/a")), false, title);
  assert.equal(isComputeCandidate(item("Netflix to build AI data centers in Ohio, filing shows", "https://www.example-news.test/b")), true, "Netflix is not an ETF");
  assert.equal(isComputeCandidate(item("「推論コストをゼロ近くに」　韓国NPU新興が日本へ", "https://eetimes.itmedia.co.jp/ee/articles/2610/10/news002.html")), true, "NPU between Japanese characters is still a word");
  assert.equal(isComputeCandidate(item("Intel CEOが来日 次世代「EMIB-T」で日本との協業重視", "https://eetimes.itmedia.co.jp/ee/articles/2610/10/news003.html")), true);
  assert.equal(isComputeCandidate(item("台積電漲停 ETF買盤湧入 目標價上調", "https://www.ctee.com.tw/news/etf")), false, "an ETF is still market chatter");
});

// A story about data centers is a Data centers story whatever language it is in; the topic is a default for when triage gave neither.
test("a Chinese, Korean or Japanese story about data centers is marked Data centers, and one about chips is marked Chips", () => {
  const marks = (title, url, summary = "") => computeMarks({ lead: { title, url, summary, source: "Outlet", category: "news" }, text: undefined, traction: null, topics: [] });
  assert.deepEqual(marks("kt클라우드, 50MW급 청라 AI 데이터센터 구축 참여", "https://www.thelec.kr/news/1").topics, ["Data centers"]);
  assert.deepEqual(marks("データセンターの電力需要が急増 AIサーバー向け液冷が普及", "https://eetimes.itmedia.co.jp/ee/articles/1").topics, ["Data centers"]);
  assert.deepEqual(marks("甲骨文擬動用卡車供氣搶救 AI 資料中心進度", "https://technews.tw/2026/10/09/oracle/").topics, ["Data centers"]);
  assert.deepEqual(marks("AI掀缺貨潮史上首見 記憶體廠砸6,744億元台灣擴產", "https://www.ctee.com.tw/news/1").topics, ["Chips"]);
  assert.deepEqual(marks("삼성전자 파운드리 2나노 수율 개선 속도", "https://www.hankyung.com/article/1").topics, ["Chips"]);
});
