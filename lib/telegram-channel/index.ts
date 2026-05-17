/**
 * Phase 2 Telegram channel — incremental scaffold.
 *
 * Issue #19 promotes the spike webhook (`agent/channels/telegram.ts`)
 * to a first-class Ash channel built on Chat SDK + `@chat-adapter/telegram`.
 * This barrel exports the pieces that don't need a live bot to validate:
 *
 *   - `verify.ts`     — webhook signature check (shared with the spike)
 *   - `inbound.ts`    — raw-update → canonical message narrowing
 *   - `outbound.ts`   — Ash session event stream → Telegram replies
 *
 * The remaining Phase 2 modules (`chat-instance.ts` and the
 * `telegramChannel({ ... })` factory that returns an Ash
 * `ChannelAdapter<TelegramState>`) land in subsequent iterations on
 * top of these primitives.
 */

export {
  verifyTelegramSecretHeader,
  type TelegramVerifyResult,
  type TelegramVerifyOk,
  type TelegramVerifyFail,
} from "./verify.js";

export {
  extractInboundMessage,
  type TelegramInboundMessage,
  type TelegramUpdatePayload,
} from "./inbound.js";

export {
  drainSessionToTelegram,
  TELEGRAM_SESSION_FAILED_REPLY,
  type DrainSessionDeps,
} from "./outbound.js";
