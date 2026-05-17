/**
 * Typed Upstash Redis client.
 *
 * Uses the REST API so the same client works in serverless functions
 * and local dev without a long-lived TCP connection.
 *
 * Env vars (provisioned in Phase 0):
 *   - `KV_REST_API_URL`
 *   - `KV_REST_API_TOKEN`
 */

import { Redis } from "@upstash/redis";

let cached: Redis | null = null;

export function getRedis(): Redis {
  if (cached) return cached;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash Redis env vars missing: set KV_REST_API_URL and KV_REST_API_TOKEN.",
    );
  }
  cached = new Redis({ url, token });
  return cached;
}

/**
 * Maps a Telegram `chatId` to the Ash session id used for that
 * conversation. Required so multi-turn DMs reach the same session
 * across cold starts of the thin Phase 1 webhook.
 */
const SESSION_KEY_PREFIX = "tg:session:";

export async function getSessionIdForChat(chatId: number): Promise<string | null> {
  const redis = getRedis();
  return (await redis.get<string>(`${SESSION_KEY_PREFIX}${chatId}`)) ?? null;
}

export async function setSessionIdForChat(
  chatId: number,
  sessionId: string,
  ttlSeconds = 60 * 60 * 24 * 7,
): Promise<void> {
  const redis = getRedis();
  await redis.set(`${SESSION_KEY_PREFIX}${chatId}`, sessionId, { ex: ttlSeconds });
}

/**
 * Resident directory entry. Mirrors the Resident shape from PRD-ASH §7.
 *
 * `platformId` is the messenger-side user id (Telegram user id today,
 * portable to WhatsApp later) and is the primary key. `confirmed: true`
 * and `source: "explicit"` mark records created via `/register`;
 * passively-learned ones (V2) will land with `confirmed: false`.
 */
export interface Resident {
  readonly id: string;
  readonly name: string;
  readonly street: string;
  readonly houseNumber: string;
  readonly floor?: string;
  readonly buzzerName?: string;
  readonly platformId: string;
  readonly platform: "telegram" | "whatsapp";
  readonly language?: string;
  readonly availabilityPatterns: readonly string[];
  readonly registeredAt: number;
  readonly source: "explicit" | "learned";
  readonly confirmed: boolean;
}

const RESIDENT_KEY_PREFIX = "resident:";

function residentKey(platformId: string): string {
  return `${RESIDENT_KEY_PREFIX}${platformId}`;
}

export async function getResident(platformId: string): Promise<Resident | null> {
  const redis = getRedis();
  return (await redis.get<Resident>(residentKey(platformId))) ?? null;
}

export async function setResident(resident: Resident): Promise<void> {
  const redis = getRedis();
  await redis.set(residentKey(resident.platformId), resident);
}

/**
 * Best-effort lookup: scan all `resident:*` keys and return the first
 * record whose `name` (case-insensitive substring match) and
 * `houseNumber` (exact) match. Used by `register_package` to link a
 * Package to a Resident when the package's recipient is already in the
 * directory.
 *
 * Phase 1 spike scale (≤ a few dozen residents per street) makes a
 * SCAN acceptable. V2 should add a secondary index keyed by
 * `<street>:<houseNumber>:<name>` to avoid the scan.
 */
export async function findResidentByNameAndHouse(
  name: string,
  houseNumber: string,
): Promise<Resident | null> {
  const redis = getRedis();
  const needle = name.trim().toLowerCase();
  if (needle === "") return null;
  let cursor: string = "0";
  do {
    const result: [string, string[]] = await redis.scan(cursor, {
      match: `${RESIDENT_KEY_PREFIX}*`,
      count: 100,
    });
    const nextCursor: string = result[0];
    const keys: string[] = result[1];
    if (keys.length > 0) {
      const residents = await redis.mget<(Resident | null)[]>(...keys);
      for (const r of residents ?? []) {
        if (!r) continue;
        if (r.houseNumber !== houseNumber) continue;
        const hay = r.name.toLowerCase();
        if (hay.includes(needle) || needle.includes(hay)) {
          return r;
        }
      }
    }
    cursor = nextCursor;
  } while (cursor !== "0");
  return null;
}

/**
 * Package record. Mirrors the Package shape from PRD-ASH §7.
 *
 * `recipientResidentId` is `null` when the recipient (the person the
 * package is addressed to) is not yet a registered resident — the
 * directory will catch up via passive learning (V2) or explicit
 * `/register` later.
 *
 * `streetId` is the holder's `street` for the Phase 1 spike (there is
 * no separate `Street` record yet). Once #19 lands a proper Street
 * model, packages will reference `Street.id`.
 */
export type PackageCarrier =
  | "DHL"
  | "Hermes"
  | "DPD"
  | "GLS"
  | "UPS"
  | "Amazon"
  | "unknown";

export type PackageStatus =
  | "held"
  | "pickup_scheduled"
  | "picked_up"
  | "expired";

export interface Package {
  readonly id: string;
  readonly streetId: string;
  readonly recipientResidentId: string | null;
  readonly recipientName: string;
  readonly recipientHouseNumber: string;
  readonly holderResidentId: string;
  readonly carrier: PackageCarrier;
  readonly trackingNumber?: string;
  readonly status: PackageStatus;
  readonly receivedAt: number;
  readonly pickedUpAt: number | null;
  readonly reminded: boolean;
}

const PACKAGE_KEY_PREFIX = "package:";

function packageKey(id: string): string {
  return `${PACKAGE_KEY_PREFIX}${id}`;
}

function streetPackagesKey(streetId: string): string {
  return `street:${streetId}:packages`;
}

export async function getPackage(id: string): Promise<Package | null> {
  const redis = getRedis();
  return (await redis.get<Package>(packageKey(id))) ?? null;
}

/**
 * Writes the Package record and adds its id to the street index in
 * the same logical operation. Indexed as a Redis set so the same
 * package id is never double-counted on retries.
 */
export async function setPackage(pkg: Package): Promise<void> {
  const redis = getRedis();
  await redis.set(packageKey(pkg.id), pkg);
  await redis.sadd(streetPackagesKey(pkg.streetId), pkg.id);
}
