import { randomUUID } from "node:crypto";
import type { StateAdapter, Lock, QueueEntry } from "chat";
import type { ChatSubscriptionService } from "./chat-subscriptions.js";

/** SDK state shares the durable SQLite authority; no ephemeral serverless memory. */
export function chatState(service: ChatSubscriptionService): StateAdapter {
  const get = async <T>(key: string) => await service.getValue(key) as T | null;
  return {
    async connect() {}, async disconnect() {}, get,
    set: (key, value, ttl) => service.setValue(key, value, ttl),
    delete: key => service.deleteValue(key),
    setIfNotExists: (key, value, ttl) => service.setIfAbsent(key, value, ttl),
    subscribe: id => service.setValue(`sub:${id}`, true),
    unsubscribe: id => service.deleteValue(`sub:${id}`),
    isSubscribed: async id => await get<boolean>(`sub:${id}`) === true,
    async acquireLock(threadId, ttlMs) {
      const lock: Lock = { threadId, token: randomUUID(), expiresAt: Date.now() + ttlMs };
      return await service.setIfAbsent(`lock:${threadId}`, { token: lock.token }, ttlMs) ? lock : null;
    },
    releaseLock: lock => service.releaseLock(`lock:${lock.threadId}`, lock.token),
    forceReleaseLock: id => service.deleteValue(`lock:${id}`),
    extendLock: (lock, ttl) => service.extendLock(`lock:${lock.threadId}`, lock.token, ttl),
    async appendToList(key, value, options) { await service.mutateList(key, value, options?.maxLength ?? 1000, options?.ttlMs); },
    getList: async <T>(key: string) => await get<T[]>(key) ?? [],
    async enqueue(id, entry, maximum) { return service.mutateList(`queue:${id}`, entry, maximum, 86_400_000); },
    dequeue: async id => await service.shift(`queue:${id}`) as QueueEntry | null,
    queueDepth: async id => (await get<unknown[]>(`queue:${id}`) ?? []).length,
  };
}
