import { FEED_TOPICS, storyTypeSchema } from "../lib/issue.js";
import type { SignalService } from "../lib/signal-service.js";
import { isCursor, isSignalId, type ListQuery } from "../lib/signals.js";

// The public face of the signal corpus: free to read, cacheable for a minute, and labelled as AI-generated on every response
// (EU AI Act, Article 50). Every parameter is validated here, so a malformed id or cursor never reaches the service.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CORRECTIONS = 200;
const DAY_MS = 86_400_000;

function reply(status: number, body: unknown, options: { cache?: boolean; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "X-AI-Generated": "true", "Cache-Control": options.cache ? "public, s-maxage=60" : "no-store", ...options.headers },
  });
}
const refuse = (message: string) => reply(400, { error: message });
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** A number from a query parameter: null when it is absent, NaN when it is not one. */
function numberParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  return raw === null || raw.trim() === "" ? null : Number(raw);
}

async function list(url: URL, service: SignalService): Promise<Response> {
  const asked = numberParam(url, "limit");
  const query: ListQuery = { limit: asked === null || !Number.isFinite(asked) ? DEFAULT_LIMIT : clamp(Math.trunc(asked), 1, MAX_LIMIT) };
  const before = url.searchParams.get("before");
  if (before !== null) { if (!isCursor(before)) return refuse("Invalid cursor"); query.before = before; }
  const since = url.searchParams.get("since");
  if (since !== null) { if (Number.isNaN(Date.parse(since))) return refuse("Invalid since: use an ISO time"); query.since = new Date(since).toISOString(); }
  const type = url.searchParams.get("type");
  if (type !== null) { const parsed = storyTypeSchema.safeParse(type); if (!parsed.success) return refuse(`Unknown type: use ${storyTypeSchema.options.join(", ")}`); query.type = parsed.data; }
  const topic = url.searchParams.get("topic");
  if (topic !== null) { if (!(FEED_TOPICS as readonly string[]).includes(topic)) return refuse("Unknown topic"); query.topic = topic; }
  const minimum = numberParam(url, "min_importance");
  if (minimum !== null) { if (!Number.isFinite(minimum) || minimum < 0 || minimum > 10) return refuse("min_importance is a number from 0 to 10"); query.minImportance = minimum; }
  const search = url.searchParams.get("q");
  if (search !== null && search.trim()) query.q = search.trim().slice(0, 100);
  return reply(200, await service.list(query), { cache: true });
}

async function one(id: string, service: SignalService): Promise<Response> {
  const signal = await service.get(id);
  if (!signal) return reply(404, { error: "Signal not found" });
  const corrections = (await service.corrections(MAX_CORRECTIONS)).filter((entry) => entry.signalId === id);
  if (signal.status === "retracted") {
    const retraction = corrections.find((entry) => entry.kind === "retraction");
    return reply(410, { id, status: "retracted", note: retraction?.note ?? "Retracted.", retractedAt: retraction?.at ?? null }, { cache: true });
  }
  return reply(200, { ...signal, corrections: corrections.map(({ at, kind, note, before }) => ({ at, kind, note, before })) }, { cache: true });
}

async function stats(service: SignalService, now: Date): Promise<Response> {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const [week, month] = await Promise.all([service.stats(since(7)), service.stats(since(30))]);
  return reply(200, { last7days: week, last30days: month }, { cache: true });
}

async function log(url: URL, service: SignalService): Promise<Response> {
  const asked = numberParam(url, "limit");
  const limit = asked === null || !Number.isFinite(asked) ? 50 : clamp(Math.trunc(asked), 1, MAX_CORRECTIONS);
  return reply(200, { corrections: await service.corrections(limit) }, { cache: true });
}

/** The signals paths, or null when the path is not one of them. */
export async function handleSignalsRequest(request: Request, path: string, service: SignalService, options: { now?: () => Date } = {}): Promise<Response | null> {
  if (path !== "/signals" && path !== "/corrections" && !path.startsWith("/signals/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return reply(405, { error: "Only reading is allowed" }, { headers: { Allow: "GET, HEAD" } });
  const response = await (async () => {
    try {
      const url = new URL(request.url);
      if (path === "/signals") return await list(url, service);
      if (path === "/signals/stats") return await stats(service, (options.now ?? (() => new Date()))());
      if (path === "/corrections") return await log(url, service);
      const id = /^\/signals\/([^/]+)$/.exec(path)?.[1];
      return id && isSignalId(id) ? await one(id, service) : reply(404, { error: "Not found" });
    } catch (error) {
      console.error("forwardpass.signals_api_error", JSON.stringify({ path, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
      return reply(503, { error: "Signals unavailable" });
    }
  })();
  return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
