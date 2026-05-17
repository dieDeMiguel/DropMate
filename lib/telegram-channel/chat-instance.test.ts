/**
 * Redis-backed StateAdapter tests.
 *
 * Drives the adapter against a Map-based fake Redis that implements the
 * subset of Upstash commands we use. The fake is intentionally minimal:
 * it does not simulate TTL expiry over wall-clock time — tests that
 * exercise TTL behaviour call `fake.advanceTime(ms)` to fast-forward the
 * shared clock the adapter and fake both consult.
 *
 * This keeps the test suite hermetic (no real Redis, no `setTimeout`
 * waits) while still covering the lock-token compare semantics and the
 * list/queue trimming logic that the chat SDK relies on.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createTelegramStateAdapter, type RedisLike } from "./chat-instance.js";

/**
 * Map-based fake Redis that implements exactly the commands the
 * StateAdapter calls. Tests construct one per case so state never
 * leaks between specs.
 *
 * Keys hold one of two value shapes — a string-tagged blob (used by
 * `set`/`get` and by the lock + queue entries the adapter serializes
 * via JSON) or an array (used by lists / queues). Expiry is tracked
 * per key against `now`, which tests advance via `advanceTime`.
 */
class FakeRedis implements RedisLike {
  private now = 0;
  private store = new Map<
    string,
    { kind: "blob"; value: string; expiresAt: number | null }
    | { kind: "list"; value: string[]; expiresAt: number | null }
  >();
  private sets = new Map<string, Set<string>>();

  advanceTime(deltaMs: number): void {
    this.now += deltaMs;
  }

  private isExpired(entry: { expiresAt: number | null }): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= this.now;
  }

  private evict(key: string): void {
    const entry = this.store.get(key);
    if (entry && this.isExpired(entry)) {
      this.store.delete(key);
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.evict(key);
    const entry = this.store.get(key);
    if (!entry || entry.kind !== "blob") return null;
    return JSON.parse(entry.value) as T;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    options?: { px?: number; nx?: boolean },
  ): Promise<"OK" | null> {
    this.evict(key);
    if (options?.nx && this.store.has(key)) return null;
    this.store.set(key, {
      kind: "blob",
      value: JSON.stringify(value),
      expiresAt: options?.px ? this.now + options.px : null,
    });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      if (this.sets.delete(key)) count++;
    }
    return count;
  }

  async pexpire(key: string, ttlMs: number): Promise<0 | 1> {
    this.evict(key);
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = this.now + ttlMs;
    return 1;
  }

  async eval<TArgs extends unknown[], TData = unknown>(
    script: string,
    keys: string[],
    args: TArgs,
  ): Promise<TData> {
    // The adapter uses three small Lua scripts; we recognise them by
    // marker comments so the fake doesn't need a full Lua interpreter.
    if (script.includes("--cmp-del")) {
      const key = keys[0]!;
      const token = String(args[0]);
      this.evict(key);
      const entry = this.store.get(key);
      if (!entry || entry.kind !== "blob") return 0 as TData;
      const stored = JSON.parse(entry.value) as string;
      if (stored !== token) return 0 as TData;
      this.store.delete(key);
      return 1 as TData;
    }
    if (script.includes("--cmp-pexpire")) {
      const key = keys[0]!;
      const token = String(args[0]);
      const ttlMs = Number(args[1]);
      this.evict(key);
      const entry = this.store.get(key);
      if (!entry || entry.kind !== "blob") return 0 as TData;
      const stored = JSON.parse(entry.value) as string;
      if (stored !== token) return 0 as TData;
      entry.expiresAt = this.now + ttlMs;
      return 1 as TData;
    }
    throw new Error(`FakeRedis: unknown script ${script.slice(0, 40)}`);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    this.evict(key);
    let entry = this.store.get(key);
    if (!entry || entry.kind !== "list") {
      entry = { kind: "list", value: [], expiresAt: null };
      this.store.set(key, entry);
    }
    entry.value.push(...values);
    return entry.value.length;
  }

  async lpop(key: string): Promise<string | null> {
    this.evict(key);
    const entry = this.store.get(key);
    if (!entry || entry.kind !== "list" || entry.value.length === 0) {
      return null;
    }
    const head = entry.value.shift()!;
    if (entry.value.length === 0) this.store.delete(key);
    return head;
  }

  async llen(key: string): Promise<number> {
    this.evict(key);
    const entry = this.store.get(key);
    if (!entry || entry.kind !== "list") return 0;
    return entry.value.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.evict(key);
    const entry = this.store.get(key);
    if (!entry || entry.kind !== "list") return [];
    const end = stop === -1 ? entry.value.length : stop + 1;
    return entry.value.slice(start, end);
  }

  async ltrim(key: string, start: number, stop: number): Promise<"OK"> {
    this.evict(key);
    const entry = this.store.get(key);
    if (!entry || entry.kind !== "list") return "OK";
    const end = stop === -1 ? entry.value.length : stop + 1;
    entry.value = entry.value.slice(start, end);
    if (entry.value.length === 0) this.store.delete(key);
    return "OK";
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    if (set.size === 0) this.sets.delete(key);
    return removed;
  }

  async sismember(key: string, member: string): Promise<0 | 1> {
    return this.sets.get(key)?.has(member) ? 1 : 0;
  }
}

let fake: FakeRedis;
let adapter: ReturnType<typeof createTelegramStateAdapter>;

beforeEach(async () => {
  fake = new FakeRedis();
  adapter = createTelegramStateAdapter(fake);
  await adapter.connect();
});

describe("createTelegramStateAdapter — get/set/delete", () => {
  it("round-trips a JSON-serialisable value", async () => {
    await adapter.set("k", { a: 1, b: "two" });
    expect(await adapter.get("k")).toEqual({ a: 1, b: "two" });
  });

  it("returns null for missing keys", async () => {
    expect(await adapter.get("missing")).toBeNull();
  });

  it("honours TTL on set", async () => {
    await adapter.set("k", "v", 1000);
    expect(await adapter.get("k")).toBe("v");
    fake.advanceTime(1001);
    expect(await adapter.get("k")).toBeNull();
  });

  it("deletes a key", async () => {
    await adapter.set("k", "v");
    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();
  });

  it("setIfNotExists writes when absent and refuses when present", async () => {
    expect(await adapter.setIfNotExists("k", "first")).toBe(true);
    expect(await adapter.setIfNotExists("k", "second")).toBe(false);
    expect(await adapter.get("k")).toBe("first");
  });

  it("setIfNotExists with TTL expires and lets the next write through", async () => {
    expect(await adapter.setIfNotExists("k", "first", 1000)).toBe(true);
    fake.advanceTime(1001);
    expect(await adapter.setIfNotExists("k", "second", 1000)).toBe(true);
    expect(await adapter.get("k")).toBe("second");
  });
});

describe("createTelegramStateAdapter — locks (compare-and-release semantics)", () => {
  it("acquires a lock when no holder exists", async () => {
    const lock = await adapter.acquireLock("thread-1", 1000);
    expect(lock).not.toBeNull();
    expect(lock!.threadId).toBe("thread-1");
    expect(typeof lock!.token).toBe("string");
    expect(lock!.token.length).toBeGreaterThan(0);
  });

  it("refuses a second acquire while the first is live", async () => {
    const a = await adapter.acquireLock("t", 1000);
    expect(a).not.toBeNull();
    const b = await adapter.acquireLock("t", 1000);
    expect(b).toBeNull();
  });

  it("lets a second acquire succeed once the first expires", async () => {
    await adapter.acquireLock("t", 1000);
    fake.advanceTime(1001);
    const b = await adapter.acquireLock("t", 1000);
    expect(b).not.toBeNull();
  });

  it("releaseLock with the right token releases the lock", async () => {
    const lock = await adapter.acquireLock("t", 1000);
    await adapter.releaseLock(lock!);
    const again = await adapter.acquireLock("t", 1000);
    expect(again).not.toBeNull();
  });

  it("releaseLock with a stale token is a no-op (token mismatch)", async () => {
    const first = await adapter.acquireLock("t", 1000);
    fake.advanceTime(1001);
    await adapter.acquireLock("t", 1000); // second holder
    // First holder tries to release after expiry — must not evict the
    // new holder.
    await adapter.releaseLock(first!);
    const third = await adapter.acquireLock("t", 1000);
    expect(third).toBeNull();
  });

  it("forceReleaseLock evicts regardless of token", async () => {
    await adapter.acquireLock("t", 1000);
    await adapter.forceReleaseLock("t");
    const next = await adapter.acquireLock("t", 1000);
    expect(next).not.toBeNull();
  });

  it("extendLock with the right token returns true and prolongs the TTL", async () => {
    const lock = await adapter.acquireLock("t", 1000);
    fake.advanceTime(500);
    expect(await adapter.extendLock(lock!, 1000)).toBe(true);
    fake.advanceTime(800);
    // Original TTL (1000ms) would have expired by 1300ms; extension
    // pushes expiry to 500+1000=1500 so still held.
    expect(await adapter.acquireLock("t", 1000)).toBeNull();
  });

  it("extendLock with a stale token returns false", async () => {
    const lock = await adapter.acquireLock("t", 1000);
    fake.advanceTime(1001);
    await adapter.acquireLock("t", 1000); // someone else takes it
    expect(await adapter.extendLock(lock!, 1000)).toBe(false);
  });
});

describe("createTelegramStateAdapter — queues", () => {
  it("enqueue returns the new depth", async () => {
    const entry = { message: { id: "m1" }, enqueuedAt: 1, expiresAt: 2 };
    const depth = await adapter.enqueue("t", entry as never, 10);
    expect(depth).toBe(1);
  });

  it("dequeue returns the oldest entry FIFO", async () => {
    const a = { message: { id: "a" }, enqueuedAt: 1, expiresAt: 2 };
    const b = { message: { id: "b" }, enqueuedAt: 3, expiresAt: 4 };
    await adapter.enqueue("t", a as never, 10);
    await adapter.enqueue("t", b as never, 10);
    expect(await adapter.dequeue("t")).toEqual(a);
    expect(await adapter.dequeue("t")).toEqual(b);
    expect(await adapter.dequeue("t")).toBeNull();
  });

  it("trims oldest entries when maxSize is exceeded", async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.enqueue(
        "t",
        { message: { id: `m${i}` }, enqueuedAt: i, expiresAt: i + 1 } as never,
        3,
      );
    }
    expect(await adapter.queueDepth("t")).toBe(3);
    const first = await adapter.dequeue("t");
    // After trimming to 3, the surviving head is m2 (m0 + m1 evicted).
    expect((first as { message: { id: string } }).message.id).toBe("m2");
  });

  it("queueDepth on an empty queue is 0", async () => {
    expect(await adapter.queueDepth("never-enqueued")).toBe(0);
  });
});

describe("createTelegramStateAdapter — list ops with TTL", () => {
  it("appendToList stores values in insertion order", async () => {
    await adapter.appendToList("k", "a");
    await adapter.appendToList("k", "b");
    expect(await adapter.getList("k")).toEqual(["a", "b"]);
  });

  it("appendToList trims to maxLength keeping newest", async () => {
    for (const v of ["a", "b", "c", "d", "e"]) {
      await adapter.appendToList("k", v, { maxLength: 3 });
    }
    expect(await adapter.getList("k")).toEqual(["c", "d", "e"]);
  });

  it("appendToList refreshes the TTL each call", async () => {
    await adapter.appendToList("k", "a", { ttlMs: 1000 });
    fake.advanceTime(800);
    await adapter.appendToList("k", "b", { ttlMs: 1000 });
    fake.advanceTime(800);
    // First TTL would have lapsed at 1000ms; second push reset it to
    // 800+1000=1800. We're at 1600ms now → still alive.
    expect(await adapter.getList("k")).toEqual(["a", "b"]);
    fake.advanceTime(300);
    expect(await adapter.getList("k")).toEqual([]);
  });

  it("getList returns [] for missing keys", async () => {
    expect(await adapter.getList("missing")).toEqual([]);
  });
});

describe("createTelegramStateAdapter — subscribe/unsubscribe/isSubscribed", () => {
  it("tracks subscriptions across the global set", async () => {
    expect(await adapter.isSubscribed("t1")).toBe(false);
    await adapter.subscribe("t1");
    expect(await adapter.isSubscribed("t1")).toBe(true);
  });

  it("unsubscribe drops the entry", async () => {
    await adapter.subscribe("t1");
    await adapter.unsubscribe("t1");
    expect(await adapter.isSubscribed("t1")).toBe(false);
  });

  it("subscribe is idempotent", async () => {
    await adapter.subscribe("t1");
    await adapter.subscribe("t1");
    expect(await adapter.isSubscribed("t1")).toBe(true);
  });
});

describe("createTelegramStateAdapter — connect / disconnect", () => {
  it("calling connect a second time is a no-op", async () => {
    await adapter.connect();
    await adapter.connect();
    // No assertion needed — must not throw.
  });

  it("disconnect prevents further operations from running", async () => {
    await adapter.disconnect();
    await expect(adapter.get("k")).rejects.toThrow(/not connected/);
  });
});
