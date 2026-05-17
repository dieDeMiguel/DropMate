/**
 * Telegram webhook signature verification.
 *
 * Telegram authenticates webhook callers via the
 * `X-Telegram-Bot-Api-Secret-Token` header — the bot registers a secret
 * at `setWebhook` time and Telegram echoes it back on every inbound
 * update. Any request missing the header (or carrying the wrong value)
 * is hostile or misconfigured and must be rejected before the body is
 * parsed.
 *
 * Phase 2 (issue #19) of the Ash channel reuses this helper from both
 * the inbound webhook route and the Chat SDK adapter's `verifyWebhook`
 * hook, so the same constant-time compare guards both entry points.
 *
 * @see https://core.telegram.org/bots/api#setwebhook
 */

/** Successful verification — the request carries the expected secret. */
export interface TelegramVerifyOk {
  readonly ok: true;
}

/** Rejected verification, with the HTTP status the route should return. */
export interface TelegramVerifyFail {
  readonly ok: false;
  readonly status: number;
  readonly reason: string;
}

export type TelegramVerifyResult = TelegramVerifyOk | TelegramVerifyFail;

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Verifies the Telegram secret-token header against the value the bot
 * registered with `setWebhook`. `expectedSecret` is typically read from
 * `process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN`.
 *
 * Returns a structured result rather than throwing so the caller can
 * translate it into a `Response` without try/catch noise.
 */
export function verifyTelegramSecretHeader(
  request: Request,
  expectedSecret: string | undefined | null,
): TelegramVerifyResult {
  if (!expectedSecret) {
    return {
      ok: false,
      status: 500,
      reason: "server misconfigured: TELEGRAM_WEBHOOK_SECRET_TOKEN unset",
    };
  }
  const headerSecret = request.headers.get(SECRET_HEADER);
  if (headerSecret === null || !constantTimeEquals(headerSecret, expectedSecret)) {
    return {
      ok: false,
      status: 401,
      reason: "missing or wrong secret header",
    };
  }
  return { ok: true };
}

/**
 * Constant-time string compare. Returns false immediately on length
 * mismatch (the length itself is not a secret), but otherwise compares
 * every byte before returning so a timing attacker cannot learn which
 * prefix is correct.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
