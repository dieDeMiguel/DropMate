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
import { z } from "zod";

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
 * Updates the `language` field on an existing Resident without
 * touching any other field. Used by:
 *
 *   - `set_language` (`/language <code>` explicit override) — always
 *     writes.
 *   - the `language_detection` hook (passive backfill from the
 *     Telegram client's `language_code`) — only when the existing
 *     record has no language set yet, controlled via `onlyIfUnset`.
 *
 * Returns the updated Resident, the existing one (when no write was
 * needed), or `null` if no record exists for the given `platformId`.
 */
export async function updateResidentLanguage(
  platformId: string,
  language: string,
  options: { onlyIfUnset?: boolean } = {},
): Promise<Resident | null> {
  const existing = await getResident(platformId);
  if (!existing) return null;
  if (options.onlyIfUnset && existing.language) return existing;
  if (existing.language === language) return existing;
  const updated: Resident = { ...existing, language };
  await setResident(updated);
  return updated;
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
/**
 * Single source of truth for the Package carrier enum. The Zod schema
 * doubles as the runtime validator for tool inputs and as the source
 * for the `PackageCarrier` TS type — so adding a new carrier here
 * updates both.
 */
export const packageCarrierSchema = z.enum([
  "DHL",
  "Hermes",
  "DPD",
  "GLS",
  "UPS",
  "Amazon",
  "unknown",
]);

export type PackageCarrier = z.infer<typeof packageCarrierSchema>;

export type PackageStatus =
  | "expected"
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
  /**
   * `null` while the package is in the `"expected"` stage (the recipient
   * has pre-announced the delivery but no neighbor has received it yet).
   * Populated when status moves to `"held"`.
   */
  readonly holderResidentId: string | null;
  readonly carrier: PackageCarrier;
  readonly trackingNumber?: string;
  readonly status: PackageStatus;
  readonly receivedAt: number;
  readonly pickedUpAt: number | null;
  readonly reminded: boolean;
  /**
   * Unix ms (day-precision is fine — set to start-of-day UTC from a
   * `YYYY-MM-DD` input). `null` when the resident didn't pin a date.
   * Only meaningful while `status === "expected"`; once a Package
   * arrives, the actual `receivedAt` is the authoritative timestamp.
   */
  readonly expectedAt?: number | null;
  /**
   * Free-form note the resident attached at registration time, e.g.
   * "birthday gift from Zalando" or "fragile — Vase". Surfaces in
   * status replies so the resident remembers which expected delivery
   * the bot is talking about.
   */
  readonly notes?: string;
  /**
   * Set by `register_package` when the new Package fulfills a pending
   * `ReceptionRequest` (the recipient pre-announced they wouldn't be
   * home; the bot matched a volunteer; the volunteer is now registering
   * the actually-arrived package). Stays `undefined` for ordinary
   * walk-up registrations — Flow 1 doesn't write it. Wires the Package
   * back to the request so future status queries can answer "did the
   * thing Patricia was waiting for ever arrive?".
   */
  readonly receptionRequestId?: string;
}

/**
 * Random Package id. Not cryptographic; just unique per package. Format
 * `pkg_<timestamp>_<rand>` so logs are scannable. Shared by every tool
 * that creates a Package (`register_package`,
 * `register_expected_delivery`, …) so id formats stay consistent.
 */
export function newPackageId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `pkg_${ts}_${rand}`;
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

/**
 * Loads every Package indexed under the given street. Returns the
 * records in the order Redis hands them back (unsorted). Caller
 * filters by `status` etc. — the street index intentionally holds
 * everything (held + picked_up + expired) so historic queries are
 * still cheap.
 *
 * Phase 1 spike scale (a few dozen packages per street, history
 * accumulating over weeks) makes a full scan + in-memory filter
 * acceptable. Per PRD §13.6, V2 will replace this with a held-only
 * Redis set (`street:<id>:held`) + a sorted-set timeline so common
 * queries don't load the entire history.
 */
export async function listPackagesForStreet(
  streetId: string,
): Promise<readonly Package[]> {
  const redis = getRedis();
  const ids = await redis.smembers(streetPackagesKey(streetId));
  if (ids.length === 0) return [];
  const keys = ids.map(packageKey);
  const rows = await redis.mget<(Package | null)[]>(...keys);
  return (rows ?? []).filter((p): p is Package => p !== null);
}

/**
 * Convenience wrapper around `listPackagesForStreet` that returns only
 * `status: "held"` records. Used by Flow 1 pickup confirmation (count
 * of remaining held packages on the same street) and Flow 3 lookup
 * (search the in-flight set). Same spike-scale tradeoff applies — see
 * `listPackagesForStreet`.
 */
export async function listHeldPackagesForStreet(
  streetId: string,
): Promise<readonly Package[]> {
  const all = await listPackagesForStreet(streetId);
  return all.filter((p) => p.status === "held");
}

/**
 * Scan every resident on the given street. Excludes nothing; callers
 * filter (e.g. `find_available_neighbors` removes the requester
 * themselves). Used only by the reception-request flow today; resident
 * directory lookups elsewhere either go by `platformId` or by
 * `name + houseNumber`.
 *
 * Phase 1 spike scale (≤ a few dozen residents per street) makes a
 * SCAN acceptable. V2 should add a `street:<id>:residents` set keyed
 * the same way the package index is, so the scan disappears.
 */
export async function listResidentsForStreet(
  street: string,
): Promise<readonly Resident[]> {
  const redis = getRedis();
  const out: Resident[] = [];
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
        if (r.street === street) out.push(r);
      }
    }
    cursor = nextCursor;
  } while (cursor !== "0");
  return out;
}

/**
 * Reception request record. A resident DMs the bot "I'm not home
 * tomorrow, expecting a DHL package" — the bot writes one of these,
 * DMs candidate neighbors, and updates it when a volunteer accepts.
 *
 * Lifecycle: `"open"` (created, candidates DM'd, no volunteer yet) →
 * `"matched"` (a volunteer accepted) → `"fulfilled"` (the matching
 * Package arrived — handled in slice #23, not here) OR `"expired"`
 * (no volunteer accepted within the configured window — handled by
 * a future schedule, not this slice).
 *
 * `volunteerAvailability` is the volunteer's own free-form window
 * (e.g. "bis 15 Uhr", "until 6pm") — kept as a string because the
 * resident's own phrasing is what the requester needs to read.
 *
 * `candidateResidentIds` snapshots who the bot asked, so the slice
 * #25 timeout schedule can DM "no one was available" to the
 * requester without re-running the candidate scan.
 */
export type ReceptionRequestStatus =
  | "open"
  | "matched"
  | "fulfilled"
  | "expired";

export interface ReceptionRequest {
  readonly id: string;
  readonly streetId: string;
  readonly requesterResidentId: string;
  readonly requesterName: string;
  readonly requesterHouseNumber: string;
  readonly carrier: PackageCarrier;
  readonly expectedAt: number | null;
  readonly notes?: string;
  readonly candidateResidentIds: readonly string[];
  readonly volunteerResidentId: string | null;
  readonly volunteerAvailability: string | null;
  readonly status: ReceptionRequestStatus;
  readonly createdAt: number;
  readonly respondedAt: number | null;
}

const RECEPTION_REQUEST_KEY_PREFIX = "reception_request:";

function receptionRequestKey(id: string): string {
  return `${RECEPTION_REQUEST_KEY_PREFIX}${id}`;
}

function streetReceptionRequestsKey(streetId: string): string {
  return `street:${streetId}:reception_requests`;
}

/**
 * Random ReceptionRequest id, same format pattern as `newPackageId` so
 * logs stay scannable across record types.
 */
export function newReceptionRequestId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `req_${ts}_${rand}`;
}

export async function getReceptionRequest(
  id: string,
): Promise<ReceptionRequest | null> {
  const redis = getRedis();
  return (
    (await redis.get<ReceptionRequest>(receptionRequestKey(id))) ?? null
  );
}

/**
 * Writes the ReceptionRequest record and adds its id to the per-street
 * index. Mirrors `setPackage` semantics so callers can iterate every
 * open request on a street without scanning every key in Redis.
 */
export async function setReceptionRequest(
  req: ReceptionRequest,
): Promise<void> {
  const redis = getRedis();
  await redis.set(receptionRequestKey(req.id), req);
  await redis.sadd(streetReceptionRequestsKey(req.streetId), req.id);
}

/**
 * Loads every ReceptionRequest indexed under the given street. Caller
 * filters by `status` (open vs fulfilled). Same spike-scale tradeoff
 * as `listPackagesForStreet`.
 */
export async function listReceptionRequestsForStreet(
  streetId: string,
): Promise<readonly ReceptionRequest[]> {
  const redis = getRedis();
  const ids = await redis.smembers(streetReceptionRequestsKey(streetId));
  if (ids.length === 0) return [];
  const keys = ids.map(receptionRequestKey);
  const rows = await redis.mget<(ReceptionRequest | null)[]>(...keys);
  return (rows ?? []).filter((r): r is ReceptionRequest => r !== null);
}

/**
 * Find a pre-fulfilment ReceptionRequest on the given street whose
 * requester matches the package's recipient. Used by `register_package`
 * to detect when a freshly-registered package closes out a pending
 * "I won't be home" ask (Flow 2b).
 *
 * "Pre-fulfilment" = `status` ∈ {`"open"`, `"matched"`}. `"fulfilled"`
 * is already closed (don't double-link); `"expired"` is a no-show
 * (the requester has already been told no one was available).
 *
 * Match rule mirrors `lookup_package` so a register / lookup pair on
 * the same recipient string agree on what counts as a hit:
 *   - `requesterHouseNumber` must equal `recipientHouseNumber` exactly.
 *   - `requesterName` must overlap `recipientName` case-insensitively
 *     in either direction ("Meyer" matches "Anna-Sophie Meyer" and
 *     vice versa).
 *
 * If multiple eligible requests match (uncommon today — a resident
 * rarely has more than one open ask), pick the most recently created.
 * That maps onto the real-world case: the request the requester has
 * actively in mind is the latest one.
 */
export async function findOpenReceptionRequestForRecipient(
  streetId: string,
  recipientName: string,
  recipientHouseNumber: string,
): Promise<ReceptionRequest | null> {
  const needle = recipientName.trim().toLowerCase();
  if (needle === "") return null;
  const all = await listReceptionRequestsForStreet(streetId);
  const eligible = all
    .filter((r) => r.status === "open" || r.status === "matched")
    .filter((r) => r.requesterHouseNumber === recipientHouseNumber)
    .filter((r) => {
      const hay = r.requesterName.toLowerCase();
      return hay.includes(needle) || needle.includes(hay);
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return eligible[0] ?? null;
}
