import { DurableObject } from "cloudflare:workers";
import type { SignalService } from "./lib/signal-service.js";
import { SignalStore, type CorrectionPatch, type ListQuery, type Outcome, type SignalRecord } from "./lib/signals.js";

/**
 * The one writer of signals. A single instance (getByName("signals-v1")) holds the store, so a fast-lane run and a
 * main-lane run that overlap cannot both claim, triage or publish the same item.
 */
export class SignalsIndex extends DurableObject<unknown> implements SignalService {
  private readonly store: SignalStore;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env); this.store = new SignalStore(ctx.storage);
  }
  async claim(urlKeys: string[], now: string, ttlMs?: number) { return this.store.claim(urlKeys, now, ttlMs); }
  async unavailable(urlKeys: string[], now: string) { return this.store.unavailable(urlKeys, now); }
  async published(urlKeys: string[]) { return this.store.published(urlKeys); }
  async release(urlKey: string, outcome: Outcome, now: string) { this.store.release(urlKey, outcome, now); }
  async publish(record: SignalRecord) { return this.store.publish(record); }
  async get(id: string) { return this.store.get(id); }
  async list(query?: ListQuery) { return this.store.list(query); }
  async recentHeadlines(sinceIso: string) { return this.store.recentHeadlines(sinceIso); }
  async publishedToday(dayUtc: string) { return this.store.publishedToday(dayUtc); }
  async getValue(key: string) { return this.store.getValue(key); }
  async setValue(key: string, value: string) { this.store.setValue(key, value); }
  async correct(id: string, kind: "correction" | "retraction", note: string, now: string, patch?: CorrectionPatch) { return this.store.correct(id, kind, note, now, patch); }
  async corrections(limit?: number) { return this.store.corrections(limit); }
  async stats(sinceIso: string) { return this.store.stats(sinceIso); }
}
