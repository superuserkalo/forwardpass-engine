import { z } from "zod";
import type { Attention, Candidate } from "./schemas.js";

// Artifacts the trending lists find too late. Trending needs attention, and a new repository has
// none yet; a lab's new model reaches the trending list a day or two after release. These ask the
// source directly: GitHub's search for new AI repositories with early traction, and Hugging Face
// for what each lab organization published in the last week.

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Hugging Face organizations of labs and tools whose own releases always count as news. */
export const HF_ORGS: readonly string[] = [
  "openai", "meta-llama", "facebook", "google", "microsoft", "nvidia", "Qwen", "deepseek-ai", "mistralai", "allenai", "ibm-granite", "HuggingFaceTB", "HuggingFaceM4", "huggingface",
  "zai-org", "THUDM", "MiniMaxAI", "moonshotai", "tencent", "baidu", "ByteDance-Seed", "ByteDance", "stepfun-ai", "black-forest-labs", "stabilityai", "LiquidAI", "apple", "Salesforce",
  "CohereLabs", "NousResearch", "unsloth", "OpenGVLab", "internlm", "XiaomiMiMo", "inclusionAI", "jinaai", "BAAI", "sentence-transformers", "onnx-community", "amd", "Intel", "LGAI-EXAONE",
  "upstage", "sarvamai", "Alibaba-NLP", "nanonets", "ai21labs", "arcee-ai", "kyutai", "hexgrad", "Wan-AI", "Lightricks", "PrimeIntellect", "Xenova", "ResembleAI", "fishaudio",
];

const NEW_MODEL_DAYS = 7;
const hfModel = z.object({ id: z.string(), likes: z.number().default(0), downloads: z.number().default(0), createdAt: z.string().optional(), pipeline_tag: z.string().optional(), tags: z.array(z.string()).default([]) });

function metric(platform: Attention["platform"], id: string, url: string, measuredAt: string, score: number, secondaryCount: number, perDay?: number): Attention {
  return { platform, id, url, measuredAt, score, secondaryCount, previousMeasuredAt: null, elapsedHours: perDay === undefined ? null : 24,
    scoreDelta: perDay ?? null, scorePerHour: perDay === undefined ? null : perDay / 24, secondaryDelta: null };
}

async function getJson(fetcher: Fetcher, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetcher(url, { headers: { "User-Agent": "ForwardPassSourceCollector/1.0", ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  return response.json();
}

/** Models each lab organization created in the last week, with their real creation time. */
export async function huggingFaceOrgModels(fetcher: Fetcher, now: Date): Promise<Candidate[]> {
  const at = now.toISOString();
  const since = now.getTime() - NEW_MODEL_DAYS * 86_400_000;
  const auth: Record<string, string> = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
  const items: Candidate[] = [];
  const errors: unknown[] = [];
  for (let start = 0; start < HF_ORGS.length; start += 8) {
    await Promise.all(HF_ORGS.slice(start, start + 8).map(async (org) => {
      try {
        const url = `https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=createdAt&direction=-1&limit=10&expand[]=likes&expand[]=downloads&expand[]=createdAt&expand[]=pipeline_tag&expand[]=tags`;
        for (const model of z.array(hfModel).parse(await getJson(fetcher, url, auth))) {
          const created = model.createdAt ? Date.parse(model.createdAt) : NaN;
          if (!Number.isFinite(created) || created < since || created > now.getTime() + 3_600_000) continue;
          const license = model.tags.find((tag) => tag.startsWith("license:"))?.slice(8);
          const modelUrl = `https://huggingface.co/${model.id}`;
          items.push({ title: `${model.id}${model.pipeline_tag ? ` (${model.pipeline_tag})` : ""}`,
            summary: `New model from ${org}: ${model.likes.toLocaleString("en-US")} likes, ${model.downloads.toLocaleString("en-US")} downloads${license ? `, license ${license}` : ""}.`,
            url: modelUrl, publishedAt: new Date(created).toISOString(), dateKind: "published", firstSeenAt: at, observedAt: at,
            source: `Hugging Face (${org})`, category: "model release", attention: [metric("huggingface", model.id, modelUrl, at, model.likes, model.downloads)] });
        }
      } catch (error) { errors.push(error); }
    }));
  }
  // A few organizations failing is noise; all of them failing is an outage the health report must show.
  if (!items.length && errors.length === HF_ORGS.length) throw errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
  return items;
}

const GITHUB_GROUPS = [
  'llm OR "large language model" OR "language model" OR gpt OR chatbot',
  'agent OR agents OR agentic OR mcp OR "model context protocol" OR "computer use"',
  'rag OR embedding OR "vector search" OR retrieval OR reranker',
  'diffusion OR "text-to-image" OR "text-to-video" OR tts OR "speech recognition" OR whisper',
  'inference OR quantization OR "fine-tuning" OR lora OR vllm OR gguf OR "kv cache"',
  'robotics OR "world model" OR "vision language" OR multimodal',
];
const NEW_REPO_DAYS = 3;
const MIN_NEW_REPO_STARS = 30;
const ghRepo = z.object({ full_name: z.string(), html_url: z.string(), description: z.string().nullable().default(""), stargazers_count: z.number(), forks_count: z.number().default(0),
  created_at: z.string(), fork: z.boolean().default(false), archived: z.boolean().default(false) });

/** New AI repositories (created in the last days) that already have early traction. Needs a GitHub token. */
export async function githubRisingRepos(fetcher: Fetcher, now: Date, token: string | undefined): Promise<Candidate[]> {
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  const at = now.toISOString();
  const since = new Date(now.getTime() - NEW_REPO_DAYS * 86_400_000).toISOString().slice(0, 10);
  const found = new Map<string, Candidate>();
  let failed = 0;
  for (const group of GITHUB_GROUPS) {
    const q = `(${group}) in:name,description,topics created:>=${since} stars:>=${MIN_NEW_REPO_STARS} fork:false`;
    try {
      const body = await getJson(fetcher, `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`,
        { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });
      for (const repo of z.object({ items: z.array(ghRepo) }).parse(body).items) {
        if (repo.fork || repo.archived || found.has(repo.html_url)) continue;
        const created = Date.parse(repo.created_at);
        const ageDays = Math.max(1, (now.getTime() - created) / 86_400_000);
        const perDay = Math.round(repo.stargazers_count / ageDays);
        found.set(repo.html_url, { title: repo.full_name, summary: `${repo.description?.trim() ? `${repo.description.trim()} ` : ""}(${repo.stargazers_count.toLocaleString("en-US")} stars, created ${Math.round(ageDays)} day${Math.round(ageDays) === 1 ? "" : "s"} ago)`,
          url: repo.html_url, publishedAt: new Date(created).toISOString(), dateKind: "published", firstSeenAt: at, observedAt: at,
          source: "GitHub search", category: "new repository", attention: [metric("github", repo.full_name.toLowerCase(), repo.html_url, at, repo.stargazers_count, repo.forks_count, perDay)] });
      }
    } catch { failed++; }
  }
  if (failed === GITHUB_GROUPS.length) throw new Error("GitHub search failed for every query");
  return [...found.values()];
}

/** GitHub organizations of labs and developer tools whose new public repositories always count as news. */
export const GITHUB_ORGS: readonly string[] = [
  "openai", "anthropics", "google", "google-deepmind", "google-research", "google-gemini", "google-parfait", "meta-llama", "facebookresearch", "facebook", "microsoft", "NVIDIA", "NVlabs", "NVIDIA-NeMo",
  "huggingface", "vllm-project", "sgl-project", "cohere-ai", "mistralai", "deepseek-ai", "QwenLM", "allenai", "langchain-ai", "run-llama", "vercel", "vercel-labs", "cloudflare", "modelcontextprotocol",
  "ollama", "ggml-org", "pytorch", "meta-pytorch", "pytorch-labs", "tensorflow", "apple", "ml-explore", "awslabs", "databricks", "ray-project", "Lightning-AI", "unslothai", "mem0ai", "letta-ai",
  "crewAIInc", "browserbase", "e2b-dev", "firecrawl", "stanfordnlp", "zai-org", "MoonshotAI", "MiniMax-AI", "bytedance", "ByteDance-Seed", "Tencent", "Tencent-Hunyuan", "baidu", "alibaba", "XiaomiMiMo",
  "stepfun-ai", "black-forest-labs", "Stability-AI", "runwayml", "elevenlabs", "RekaAI", "AI21Labs", "liquid4all", "PrimeIntellect-ai", "NousResearch", "arcee-ai", "zed-industries", "sourcegraph", "cline",
  "continuedev", "triton-lang", "mlc-ai", "Dao-AILab", "InternLM", "OpenGVLab", "EleutherAI", "langfuse", "BerriAI", "intel", "amd", "ROCm",
];

const NEW_ORG_REPO_DAYS = 7;
// Websites, docs, dotfiles and mirrors are not releases.
const NOT_A_RELEASE = /^(?:\.github|homebrew-.+|.+\.github\.io|website|docs?|.+-docs?|.+-website|.+-mirror)$/i;
const orgRepo = ghRepo.extend({ private: z.boolean().default(false) });

/** Each lab organization's public repositories created in the last week: a new repo from a lab is news before it has stars. */
export async function githubOrgRepos(fetcher: Fetcher, now: Date, token: string | undefined): Promise<Candidate[]> {
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  const at = now.toISOString();
  const since = now.getTime() - NEW_ORG_REPO_DAYS * 86_400_000;
  const items: Candidate[] = [];
  const errors: unknown[] = [];
  for (let start = 0; start < GITHUB_ORGS.length; start += 8) {
    await Promise.all(GITHUB_ORGS.slice(start, start + 8).map(async (org) => {
      try {
        const body = await getJson(fetcher, `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?type=public&sort=created&direction=desc&per_page=10`,
          { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });
        for (const repo of z.array(orgRepo).parse(body)) {
          const created = Date.parse(repo.created_at);
          const description = repo.description?.trim() ?? "";
          if (!Number.isFinite(created) || created < since || repo.fork || repo.archived || repo.private || !description || NOT_A_RELEASE.test(repo.full_name.split("/")[1] ?? "")) continue;
          items.push({ title: repo.full_name, summary: `${description} (new repository from ${org}, ${repo.stargazers_count.toLocaleString("en-US")} stars)`, url: repo.html_url,
            publishedAt: new Date(created).toISOString(), dateKind: "published", firstSeenAt: at, observedAt: at, source: `GitHub (${org})`, category: "new repository",
            attention: [metric("github", repo.full_name.toLowerCase(), repo.html_url, at, repo.stargazers_count, repo.forks_count)] });
        }
      } catch (error) { errors.push(error); }
    }));
  }
  if (!items.length && errors.length === GITHUB_ORGS.length) throw errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
  return items;
}
