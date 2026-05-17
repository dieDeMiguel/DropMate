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
