import { DurableObject } from "cloudflare:workers";
import { ChatSubscriptions, type ChatPlatform, type ChatMode, type DestinationCandidate } from "./lib/chat-subscriptions.js";

export class ChatRegistry extends DurableObject<unknown> {
  private readonly subscriptions: ChatSubscriptions;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env); this.subscriptions = new ChatSubscriptions(ctx.storage);
  }
  async createLink(owner: string, platform: ChatPlatform, mode: ChatMode) { return this.subscriptions.createLink(owner, platform, mode); }
  async link(token: string) { return this.subscriptions.link(token); }
  async attach(token: string, candidate: DestinationCandidate) { return this.subscriptions.attach(token, candidate); }
  async list(owner: string) { return this.subscriptions.list(owner); }
  async slackAccount(installation: string, actor: string) { return this.subscriptions.slackAccount(installation, actor); }
  async destination(id: string) { return this.subscriptions.destination(id); }
  async update(owner: string, id: string, status: "active" | "paused" | "disconnected") { return this.subscriptions.update(owner, id, status); }
  async stop(candidate: DestinationCandidate) { return this.subscriptions.stop(candidate); }
  async audience(platform: ChatPlatform, after: string, limit: number) { return this.subscriptions.audience(platform, after, limit); }
  async claim(date: string, id: string) { return this.subscriptions.claim(date, id); }
  async finish(date: string, id: string, status: "sent" | "retryable" | "failed" | "ambiguous", messageId: string | null) { this.subscriptions.finish(date, id, status, messageId); }
  async getValue(key: string) { return this.subscriptions.get(`sdk:${key}`); }
  async setValue(key: string, value: unknown, ttlMs?: number) { this.subscriptions.set(`sdk:${key}`, value, ttlMs); }
  async deleteValue(key: string) { this.subscriptions.delete(`sdk:${key}`); }
  async setIfAbsent(key: string, value: unknown, ttlMs?: number) { return this.subscriptions.setIfAbsent(`sdk:${key}`, value, ttlMs); }
  async mutateList(key: string, value: unknown, maximum: number, ttlMs?: number) { return this.subscriptions.mutateList(`sdk:${key}`, value, maximum, ttlMs); }
  async shift(key: string) { return this.subscriptions.shift(`sdk:${key}`); }
  async extendLock(key: string, token: string, ttlMs: number) { return this.subscriptions.extendLock(`sdk:${key}`, token, ttlMs); }
  async releaseLock(key: string, token: string) { this.subscriptions.releaseLock(`sdk:${key}`, token); }
}
