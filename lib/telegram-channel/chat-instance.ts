/**
 * Chat SDK singleton + Redis-backed StateAdapter for the Phase 2
 * Telegram channel.
 *
 * The Chat SDK persists three kinds of state we can't keep in-process
 * on Vercel's stateless runtime: thread subscriptions, dispatch
 * locks, and queued / debounced messages waiting for an in-flight
 * handler. The `MemoryStateAdapter` shipped with the SDK is explicitly
 * marked unfit for serverless ("not recommended for production"), so
 * we hand it an Upstash-backed adapter that satisfies the same
 * 18-method interface.
 *
 * Two responsibilities live in this file because they're co-owned by
 * the same lifecycle:
 *
 *   1. {@link createTelegramStateAdapter} — pure factory that turns a
 *      Redis-shaped client into a Chat SDK `StateAdapter`. Production
 *      passes `getRedis()`; tests pass a Map-based fake.
 *
 *   2. {@link getTelegramChatInstance} — process-scoped `Chat` singleton
 *      wired up with the Telegram adapter + the Redis StateAdapter.
 *      Constructed lazily on first call so route imports stay cheap on
 *      cold start and so unit tests can build a per-test adapter
 *      without paying for `new Chat(...)`.
 *
 * Why per-process singleton (and not per-request)? `Chat` keeps
 * in-process maps for handler routing and dedupe — recreating it per
 * request would lose dedupe state across the few-hundred-ms window
 * Telegram retries within.
 *
 * @see node_modules/chat/dist/index.d.ts — `StateAdapter` (interface)
 * @see node_modules/experimental-ash/dist/src/compiled/@chat-adapter/state-memory/index.js
 *      — the reference in-memory implementation we mirror semantically
 */

import { Chat, type Lock, type QueueEntry, type StateAdapter } from "chat";
import { TelegramAdapter } from "@chat-adapter/telegram";

import { getRedis } from "../redis.js";

/**
 * Minimal Redis surface this adapter depends on. Defined as an
 * interface rather than imported as `Redis` from `@upstash/redis` so
 * tests can supply a Map-based fake without dragging in the real
 * client's typing surface — and so a future swap to another
 * Redis-compatible backend doesn't have to touch the call sites.
 *
 * The shape here was chosen to match `@upstash/redis`'s call
 * conventions exactly (variadic `del`, `rpush`, options bag on
 * `set`, etc.) so the production wiring is a one-liner.
 */
export interface RedisLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(
    key: string,
    value: T,
    options?: { px?: number; nx?: boolean },
  ): Promise<"OK" | null>;
  del(...keys: string[]): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<0 | 1>;
  eval<TArgs extends unknown[], TData = unknown>(
    script: string,
    keys: string[],
    args: TArgs,
  ): Promise<TData>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<"OK">;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  sismember(key: string, member: string): Promise<0 | 1>;
}

/**
 * Key namespace. All chat-SDK state is prefixed so it doesn't collide
 * with the resident / package / session-id keys that already live in
 * the same Redis instance (see `lib/redis.ts`).
 */
const KEY_PREFIX = "chat:tg:";
const LOCK_PREFIX = `${KEY_PREFIX}lock:`;
const QUEUE_PREFIX = `${KEY_PREFIX}queue:`;
const KV_PREFIX = `${KEY_PREFIX}kv:`;
const LIST_PREFIX = `${KEY_PREFIX}list:`;
const SUBSCRIPTIONS_KEY = `${KEY_PREFIX}subs`;

/**
 * Compare-and-delete: drop the lock only if the caller still owns the
 * token. Marker comment `--cmp-del` is how the test fake recognises
 * the script — production Upstash runs it as real Lua. Returning
 * `0` for a stale token matches the reference adapter's behaviour
 * (silent no-op).
 */
const LUA_COMPARE_AND_DELETE = `--cmp-del
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

/** Compare-and-pexpire: extend the lock only when the token matches. */
const LUA_COMPARE_AND_PEXPIRE = `--cmp-pexpire
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end`;

function lockKey(threadId: string): string {
  return `${LOCK_PREFIX}${threadId}`;
}
function queueKey(threadId: string): string {
  return `${QUEUE_PREFIX}${threadId}`;
}
function kvKey(key: string): string {
  return `${KV_PREFIX}${key}`;
}
function listKey(key: string): string {
  return `${LIST_PREFIX}${key}`;
}

function randomToken(): string {
  // Mirrors the reference adapter's `mem_<ts>_<rand>` shape so logs
  // tying a lock token to its issuance time stay readable. The token
  // itself doesn't need to be cryptographically random — it's a
  // collision guard, not a secret.
  return `tg_${Date.now()}_${Math.random().toString(36).slice(2, 15)}`;
}

/**
 * Build a Chat SDK `StateAdapter` backed by the given Redis-like
 * client. Connection lifecycle is internal: `connect()` sets a flag
 * and any later call from production code is a no-op; `disconnect()`
 * flips it back so tests can assert that post-shutdown calls throw.
 *
 * The adapter does no in-process caching — every read is a Redis hop.
 * That's intentional: the Chat SDK uses these methods for cross-
 * invocation coordination (locks held across webhook handlers,
 * subscriptions read on cold start), so caching would defeat the
 * purpose.
 */
export function createTelegramStateAdapter(redis: RedisLike): StateAdapter {
  let connected = false;

  function ensureConnected(): void {
    if (!connected) {
      throw new Error(
        "TelegramStateAdapter is not connected. Call connect() first.",
      );
    }
  }

  return {
    async connect() {
      connected = true;
    },

    async disconnect() {
      connected = false;
    },

    async subscribe(threadId) {
      ensureConnected();
      await redis.sadd(SUBSCRIPTIONS_KEY, threadId);
    },

    async unsubscribe(threadId) {
      ensureConnected();
      await redis.srem(SUBSCRIPTIONS_KEY, threadId);
    },

    async isSubscribed(threadId) {
      ensureConnected();
      return (await redis.sismember(SUBSCRIPTIONS_KEY, threadId)) === 1;
    },

    async acquireLock(threadId, ttlMs) {
      ensureConnected();
      const token = randomToken();
      const result = await redis.set(lockKey(threadId), token, {
        px: ttlMs,
        nx: true,
      });
      if (result !== "OK") return null;
      const lock: Lock = {
        threadId,
        token,
        expiresAt: Date.now() + ttlMs,
      };
      return lock;
    },

    async releaseLock(lock) {
      ensureConnected();
      await redis.eval(LUA_COMPARE_AND_DELETE, [lockKey(lock.threadId)], [
        lock.token,
      ]);
    },

    async extendLock(lock, ttlMs) {
      ensureConnected();
      const result = await redis.eval<[string, number], 0 | 1>(
        LUA_COMPARE_AND_PEXPIRE,
        [lockKey(lock.threadId)],
        [lock.token, ttlMs],
      );
      if (result === 1) {
        lock.expiresAt = Date.now() + ttlMs;
        return true;
      }
      return false;
    },

    async forceReleaseLock(threadId) {
      ensureConnected();
      await redis.del(lockKey(threadId));
    },

    async get(key) {
      ensureConnected();
      return (await redis.get(kvKey(key))) as never;
    },

    async set(key, value, ttlMs) {
      ensureConnected();
      await redis.set(
        kvKey(key),
        value,
        ttlMs ? { px: ttlMs } : undefined,
      );
    },

    async setIfNotExists(key, value, ttlMs) {
      ensureConnected();
      const result = await redis.set(kvKey(key), value, {
        nx: true,
        ...(ttlMs ? { px: ttlMs } : {}),
      });
      return result === "OK";
    },

    async delete(key) {
      ensureConnected();
      await redis.del(kvKey(key));
    },

    async appendToList(key, value, options) {
      ensureConnected();
      const k = listKey(key);
      const serialised = JSON.stringify(value);
      await redis.rpush(k, serialised);
      if (options?.maxLength) {
        // Keep newest `maxLength` — LTRIM with `-maxLength..-1`.
        await redis.ltrim(k, -options.maxLength, -1);
      }
      if (options?.ttlMs) {
        await redis.pexpire(k, options.ttlMs);
      }
    },

    async getList<T = unknown>(key: string) {
      ensureConnected();
      const raw = await redis.lrange(listKey(key), 0, -1);
      return raw.map((s) => JSON.parse(s) as T);
    },

    async enqueue(threadId, entry, maxSize) {
      ensureConnected();
      const k = queueKey(threadId);
      await redis.rpush(k, JSON.stringify(entry));
      const depth = await redis.llen(k);
      if (depth > maxSize) {
        // Drop oldest first (matches `drop-oldest` default in the
        // reference adapter). LTRIM keeps the newest `maxSize`.
        await redis.ltrim(k, -maxSize, -1);
        return maxSize;
      }
      return depth;
    },

    async dequeue(threadId) {
      ensureConnected();
      const raw = await redis.lpop(queueKey(threadId));
      if (raw === null) return null;
      return JSON.parse(raw) as QueueEntry;
    },

    async queueDepth(threadId) {
      ensureConnected();
      return redis.llen(queueKey(threadId));
    },
  };
}

/**
 * Configuration for the lazily-built Chat singleton.
 *
 * Surfaced through {@link configureTelegramChat} so the channel factory
 * can hand off the token + webhook secret it captured in closure
 * without this module reaching into `process.env` directly.
 */
export interface TelegramChatInstanceConfig {
  readonly botToken: string;
  readonly webhookSecret: string;
}

let pendingConfig: TelegramChatInstanceConfig | null = null;
let chatSingleton: Chat | null = null;

/**
 * Records the bot token + webhook secret the next {@link getTelegramChatInstance}
 * call will use. Calling more than once with different values throws
 * — multiple Telegram channels per process would require keying the
 * singleton on the token, which we don't need for the single-bot
 * deployment Phase 2 targets.
 */
export function configureTelegramChat(config: TelegramChatInstanceConfig): void {
  if (pendingConfig && (
    pendingConfig.botToken !== config.botToken ||
    pendingConfig.webhookSecret !== config.webhookSecret
  )) {
    throw new Error(
      "configureTelegramChat called twice with different credentials — " +
        "Phase 2 only supports one Telegram bot per process.",
    );
  }
  pendingConfig = config;
}

/**
 * Returns the process-scoped `Chat` instance, building it on first
 * call. Throws when {@link configureTelegramChat} has not been called
 * yet — this is the signal that the channel factory was bypassed
 * (e.g. a test importing `chat-instance.ts` directly without first
 * supplying credentials).
 */
export function getTelegramChatInstance(): Chat {
  if (chatSingleton) return chatSingleton;
  if (!pendingConfig) {
    throw new Error(
      "getTelegramChatInstance called before configureTelegramChat — " +
        "the telegramChannel({ ... }) factory must be invoked first.",
    );
  }
  const adapter = new TelegramAdapter({
    botToken: pendingConfig.botToken,
    secretToken: pendingConfig.webhookSecret,
  });
  chatSingleton = new Chat({
    adapters: { telegram: adapter },
    state: createTelegramStateAdapter(getRedis() as unknown as RedisLike),
    userName: "dropmate",
  });
  return chatSingleton;
}

/**
 * Test-only reset hook. Production code never imports this — the
 * singleton lives for the lifetime of the process.
 */
export function __resetTelegramChatInstanceForTests(): void {
  chatSingleton = null;
  pendingConfig = null;
}
