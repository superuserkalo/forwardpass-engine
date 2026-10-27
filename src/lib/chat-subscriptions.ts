import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const chatPlatformSchema = z.enum(["slack", "discord", "telegram", "teams"]);
export type ChatPlatform = z.infer<typeof chatPlatformSchema>;
export const chatModeSchema = z.enum(["personal", "shared"]);
export type ChatMode = z.infer<typeof chatModeSchema>;
export const destinationSchema = z.object({
  id: z.string(), owner: z.email(), platform: chatPlatformSchema, mode: chatModeSchema,
  target: z.string(), installation: z.string().nullable(), actor: z.string(), label: z.string().max(160),
  status: z.enum(["pending", "active", "paused", "disconnected"]), createdAt: z.iso.datetime(),
});
export type ChatDestination = z.infer<typeof destinationSchema>;
export type DestinationCandidate = Pick<ChatDestination, "platform" | "mode" | "target" | "installation" | "actor" | "label">;
const ticketSchema = z.object({ owner: z.email(), platform: chatPlatformSchema, mode: chatModeSchema, expires: z.number() });
export type ChatLinkTicket = z.infer<typeof ticketSchema>;
export const CHAT_LINK_TTL_MS = 10 * 60_000;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const destinationId = (candidate: DestinationCandidate) => {
  // Teams service URLs can move; ownership follows the conversation within its tenant.
  const target = candidate.platform === "teams" ? candidate.target.split(":")[1] : candidate.target;
  return digest(`${candidate.platform}:${candidate.installation ?? ""}:${target}`);
};
type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
type Row = { body: string; expires: number | null };

/** One SQLite authority for destination ownership, one-use links and send claims. */
export class ChatSubscriptions {
  constructor(private readonly storage: Storage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS chat_kv (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS chat_destinations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS chat_owner ON chat_destinations(owner)");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS chat_status ON chat_destinations(status, id)");
  }
  get(key: string, now = Date.now()): unknown | null {
    const row = this.storage.sql.exec<Row>("SELECT body, expires FROM chat_kv WHERE key = ?", key).toArray()[0];
    if (!row) return null;
    if (row.expires !== null && row.expires <= now) { this.delete(key); return null; }
    return JSON.parse(row.body);
  }
  set(key: string, value: unknown, ttlMs?: number, now = Date.now()): void {
    this.storage.sql.exec("INSERT OR REPLACE INTO chat_kv(key, body, expires) VALUES (?, ?, ?)", key, JSON.stringify(value), ttlMs === undefined ? null : now + ttlMs);
  }
  delete(key: string): void { this.storage.sql.exec("DELETE FROM chat_kv WHERE key = ?", key); }
  setIfAbsent(key: string, value: unknown, ttlMs?: number, now = Date.now()): boolean {
    return this.storage.transactionSync(() => {
      if (this.get(key, now) !== null) return false;
      this.set(key, value, ttlMs, now); return true;
    });
  }
  mutateList(key: string, value: unknown, maximum: number, ttlMs?: number): number {
    return this.storage.transactionSync(() => {
      const values = z.array(z.unknown()).parse(this.get(key) ?? []);
      values.push(value);
      const next = values.slice(-maximum);
      this.set(key, next, ttlMs); return next.length;
    });
  }
  shift(key: string): unknown | null {
    return this.storage.transactionSync(() => {
      const values = z.array(z.unknown()).parse(this.get(key) ?? []);
      const value = values.shift() ?? null;
      this.set(key, values, 86_400_000); return value;
    });
  }
  extendLock(key: string, token: string, ttlMs: number): boolean {
    return this.storage.transactionSync(() => {
      const held = z.object({ token: z.string() }).safeParse(this.get(key));
      if (!held.success || held.data.token !== token) return false;
      this.set(key, { token }, ttlMs); return true;
    });
  }
  releaseLock(key: string, token: string): void {
    this.storage.transactionSync(() => {
      const held = z.object({ token: z.string() }).safeParse(this.get(key));
      if (held.success && held.data.token === token) this.delete(key);
    });
  }
  createLink(owner: string, platform: ChatPlatform, mode: ChatMode, now = Date.now()): { token: string; expiresAt: string } {
    // Keep one outstanding link per reader/platform/mode and bound expired state.
    this.storage.sql.exec("DELETE FROM chat_kv WHERE expires IS NOT NULL AND expires <= ?", now);
    const token = Buffer.from(randomBytes(24)).toString("base64url");
    const slot = `link-slot:${digest(owner.toLowerCase())}:${platform}:${mode}`;
    const previous = this.get(slot, now);
    if (typeof previous === "string") this.delete(previous);
    const key = `link:${digest(token)}`;
    this.set(key, { owner: owner.toLowerCase(), platform, mode, expires: now + CHAT_LINK_TTL_MS }, CHAT_LINK_TTL_MS, now);
    this.set(slot, key, CHAT_LINK_TTL_MS, now);
    return { token, expiresAt: new Date(now + CHAT_LINK_TTL_MS).toISOString() };
  }
  link(token: string, now = Date.now()): ChatLinkTicket | null {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
    const ticket = ticketSchema.safeParse(this.get(`link:${digest(token)}`, now));
    return ticket.success ? ticket.data : null;
  }
  attach(token: string, candidate: DestinationCandidate, now = Date.now()): boolean {
    return this.storage.transactionSync(() => {
      const ticket = this.link(token, now);
      if (!ticket || ticket.platform !== candidate.platform || ticket.mode !== candidate.mode) return false;
      const id = destinationId(candidate);
      const existing = this.destination(id);
      // A connection code cannot take over another reader's destination.
      if (existing && existing.owner !== ticket.owner && existing.status !== "disconnected") return false;
      if (existing?.status === "active") return false;
      if (this.list(ticket.owner).filter(destination => destination.status !== "disconnected").length >= 20 && !existing) return false;
      this.save(destinationSchema.parse({ ...candidate, id, owner: ticket.owner, status: "pending", createdAt: new Date(now).toISOString() }));
      this.delete(`link:${digest(token)}`);
      return true;
    });
  }
  destination(id: string): ChatDestination | null {
    const row = this.storage.sql.exec<{ body: string }>("SELECT body FROM chat_destinations WHERE id = ?", id).toArray()[0];
    return row ? destinationSchema.parse(JSON.parse(row.body)) : null;
  }
  private save(destination: ChatDestination): void {
    this.storage.sql.exec("INSERT OR REPLACE INTO chat_destinations(id, owner, status, body) VALUES (?, ?, ?, ?)", destination.id, destination.owner, destination.status, JSON.stringify(destination));
  }
  list(owner: string): ChatDestination[] {
    return this.storage.sql.exec<{ body: string }>("SELECT body FROM chat_destinations WHERE owner = ? ORDER BY id", owner.toLowerCase()).toArray().map(row => destinationSchema.parse(JSON.parse(row.body)));
  }
  /** Only a confirmed personal connection can bind a Slack caller to a reader account. */
  slackAccount(installation: string, actor: string): string | null {
    const rows = this.storage.sql.exec<{ owner: string }>(
      "SELECT DISTINCT owner FROM chat_destinations WHERE status IN ('active', 'paused') AND json_extract(body, '$.platform') = 'slack' AND json_extract(body, '$.mode') = 'personal' AND json_extract(body, '$.installation') = ? AND json_extract(body, '$.actor') = ? LIMIT 2",
      installation, actor,
    ).toArray();
    return rows.length === 1 ? rows[0].owner : null;
  }
  update(owner: string, id: string, status: "active" | "paused" | "disconnected", now = Date.now()): boolean {
    const destination = this.destination(id);
    if (!destination || destination.owner !== owner.toLowerCase()) return false;
    if (status === "active" && destination.status === "pending" && Date.parse(destination.createdAt) + CHAT_LINK_TTL_MS <= now) return false;
    if (status === "active" && destination.status === "disconnected") return false;
    if (status === "paused" && !["active", "paused"].includes(destination.status)) return false;
    this.save({ ...destination, status }); return true;
  }
  stop(candidate: DestinationCandidate): boolean {
    const destination = this.destination(destinationId(candidate));
    if (!destination || destination.actor !== candidate.actor || !["active", "paused"].includes(destination.status)) return false;
    this.save({ ...destination, status: "paused" }); return true;
  }
  audience(platform: ChatPlatform, after = "", limit = 100): ChatDestination[] {
    return this.storage.sql.exec<{ body: string }>("SELECT body FROM chat_destinations WHERE status = 'active' AND json_extract(body, '$.platform') = ? AND id > ? ORDER BY id LIMIT ?", platform, after, limit).toArray().map(row => destinationSchema.parse(JSON.parse(row.body)));
  }
  claim(date: string, id: string): "claimed" | "alreadySent" | "skipped" | "failed" | "needsReconciliation" {
    return this.storage.transactionSync(() => {
      if (this.destination(id)?.status !== "active") return "skipped";
      const key = `delivery:${date}:${id}`;
      const previous = z.object({ status: z.string() }).safeParse(this.get(key));
      if (previous.success && previous.data.status === "sent") return "alreadySent";
      if (previous.success && previous.data.status === "failed") return "failed";
      if (previous.success && previous.data.status !== "retryable") return "needsReconciliation";
      this.set(key, { status: "attempt", at: new Date().toISOString() }); return "claimed";
    });
  }
  finish(date: string, id: string, status: "sent" | "retryable" | "failed" | "ambiguous", messageId: string | null): void {
    this.set(`delivery:${date}:${id}`, { status, messageId, at: new Date().toISOString() });
  }
}

export interface ChatSubscriptionService {
  slackAccount(installation: string, actor: string): Promise<string | null>;
  createLink(owner: string, platform: ChatPlatform, mode: ChatMode): Promise<{ token: string; expiresAt: string }>;
  link(token: string): Promise<z.infer<typeof ticketSchema> | null>;
  attach(token: string, candidate: DestinationCandidate): Promise<boolean>;
  list(owner: string): Promise<ChatDestination[]>;
  destination(id: string): Promise<ChatDestination | null>;
  update(owner: string, id: string, status: "active" | "paused" | "disconnected"): Promise<boolean>;
  stop(candidate: DestinationCandidate): Promise<boolean>;
  audience(platform: ChatPlatform, after: string, limit: number): Promise<ChatDestination[]>;
  claim(date: string, id: string): Promise<"claimed" | "alreadySent" | "skipped" | "failed" | "needsReconciliation">;
  finish(date: string, id: string, status: "sent" | "retryable" | "failed" | "ambiguous", messageId: string | null): Promise<void>;
  getValue(key: string): Promise<unknown | null>;
  setValue(key: string, value: unknown, ttlMs?: number): Promise<void>;
  deleteValue(key: string): Promise<void>;
  setIfAbsent(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
  mutateList(key: string, value: unknown, maximum: number, ttlMs?: number): Promise<number>;
  shift(key: string): Promise<unknown | null>;
  extendLock(key: string, token: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<void>;
}
