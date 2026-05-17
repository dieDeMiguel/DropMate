/**
 * Outbound Telegram side of the Phase 2 Ash channel.
 *
 * Consumes an Ash session's event stream and posts assistant replies
 * back to Telegram. Today this is the same pipeline the Phase 1 spike
 * (`agent/channels/telegram.ts`) used inline; lifting it here so:
 *
 *   1. The drain logic is testable in isolation (no `defineChannel`
 *      runtime, no real Telegram Bot API).
 *   2. The spike's webhook collapses to a `drainSessionToTelegram(...)`
 *      call so the route stays focused on inbound parsing + session
 *      bookkeeping.
 *   3. The eventual Chat SDK-backed outbound (issue #19's
 *      `actions.requested` / button cards) has a single home and a
 *      tested baseline of which session events become Telegram
 *      messages.
 *
 * The function returns once the stream closes (or errors). Callers
 * are responsible for backgrounding it via `waitUntil(...)` if they
 * need to return the HTTP response before the assistant finishes.
 *
 * Callers must supply the Telegram bot token explicitly — either via
 * `deps.token` (preferred for tests and for the Phase 2 channel
 * factory, which captures the token in closure) or via the
 * `TELEGRAM_BOT_TOKEN` env var (the spike default). This mirrors the
 * `sendMessage`/`logError` injection pattern: production behaviour is
 * unchanged, but we no longer reach into `process.env` from inside
 * `lib/telegram-channel/send.ts`.
 *
 * @see lib/telegram-channel/send.ts — `sendTelegramMessage(token, …)`
 * @see node_modules/experimental-ash/dist/src/protocol/message.d.ts —
 *      `HandleMessageStreamEvent` union (the events we narrow on)
 */

import type { Session } from "experimental-ash/channels";

import { sendTelegramMessage } from "./send.js";

/**
 * Generic error-reply text used when the session itself fails. Lives
 * as a module constant so tests can assert on it without duplicating
 * the string and so a future i18n pass has a single hook point.
 */
export const TELEGRAM_SESSION_FAILED_REPLY =
  "Sorry, I hit an error processing that message.";

/**
 * Hooks injected by the test suite and by the Phase 2 channel factory.
 * Production callers in the spike webhook supply `token` from the
 * `TELEGRAM_BOT_TOKEN` env var; the factory will pass its captured
 * token through this same field. Tests pass a `sendMessage` spy so
 * the real Bot API is never hit.
 */
export interface DrainSessionDeps {
  /**
   * Telegram bot token used by the default `sendMessage`. Ignored
   * when `sendMessage` is overridden — the spy is responsible for
   * whatever auth it wants.
   */
  readonly token?: string;
  /** Posts a plain-text reply to the given Telegram `chatId`. */
  readonly sendMessage?: (chatId: number, text: string) => Promise<void>;
  /** Logger override (defaults to `console.error`). */
  readonly logError?: (message: string, error: unknown) => void;
}

/**
 * Drains `session.getEventStream()` until it closes, translating each
 * relevant event into a Telegram message:
 *
 *   - `message.completed` with non-empty text → `sendMessage(chatId, text)`
 *   - `session.failed`                         → `sendMessage(chatId, TELEGRAM_SESSION_FAILED_REPLY)`
 *
 * All other event types (turn lifecycle, reasoning, action requests,
 * subagent traces, …) are intentionally ignored — they're observability
 * signals for the channel, not user-facing chat.
 *
 * Errors from the stream itself or from `sendMessage` are swallowed
 * after logging: this function is called from `waitUntil(...)` in the
 * webhook, where throwing would crash the background drain without any
 * recovery path. Per-message send failures shouldn't take down the
 * whole turn.
 */
export async function drainSessionToTelegram(
  session: Session,
  chatId: number,
  deps: DrainSessionDeps = {},
): Promise<void> {
  const sendMessage =
    deps.sendMessage ?? buildDefaultSendMessage(deps.token);
  const logError = deps.logError ?? defaultLogError;
  try {
    const stream = await session.getEventStream();
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.type === "message.completed") {
          const text = value.data.message;
          if (typeof text === "string" && text.length > 0) {
            await sendMessage(chatId, text);
          }
          continue;
        }
        if (value.type === "session.failed") {
          await sendMessage(chatId, TELEGRAM_SESSION_FAILED_REPLY);
          continue;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    logError("telegram outbound drain failed", err);
  }
}

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error);
}

/**
 * Returns a `sendMessage` closure that injects the token at call
 * time. The lookup is deferred (rather than captured at module load)
 * so the spike webhook keeps its current "read env on demand"
 * behaviour without explicitly threading the token through every
 * call site. The Phase 2 channel factory will pass an explicit
 * `token` argument and bypass the env-var fallback entirely.
 */
function buildDefaultSendMessage(
  token: string | undefined,
): (chatId: number, text: string) => Promise<void> {
  return async (chatId, text) => {
    const resolved = token ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!resolved) {
      throw new Error(
        "Telegram bot token is missing: pass `deps.token` to drainSessionToTelegram " +
          "or set TELEGRAM_BOT_TOKEN.",
      );
    }
    await sendTelegramMessage(resolved, chatId, text);
  };
}
