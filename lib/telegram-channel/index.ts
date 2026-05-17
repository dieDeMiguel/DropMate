/**
 * Phase 2 Telegram channel — full surface.
 *
 * Issue #19 promotes the spike webhook (`agent/channels/telegram.ts`)
 * to a first-class Ash channel. This barrel exposes every primitive
 * the channel needs:
 *
 *   - `verify.ts`         — webhook signature check (shared with the spike)
 *   - `inbound.ts`        — raw-update → canonical message + callback narrowing
 *   - `outbound.ts`       — Ash session event stream → Telegram replies
 *   - `send.ts`           — `sendMessage` Bot API primitive (token explicit)
 *   - `keyboards.ts`      — inline-keyboard primitives (#24): answerCallbackQuery,
 *                           editMessageReplyMarkup
 *   - `process-update.ts` — full inbound pipeline orchestrator
 *   - `factory.ts`        — `telegramChannel({ token, webhookSecret })`
 *   - `chat-instance.ts`  — Chat SDK singleton + Redis StateAdapter
 *                           (infrastructure for the Chat-SDK-integrated
 *                           variant; the current factory wraps Ash's
 *                           `defineChannel` directly and does not yet
 *                           consume `getTelegramChatInstance`).
 *
 * Spike webhook callers should import `telegramChannel` and collapse
 * to a one-line `export default telegramChannel({ ... })`.
 */

export {
  verifyTelegramSecretHeader,
  type TelegramVerifyResult,
  type TelegramVerifyOk,
  type TelegramVerifyFail,
} from "./verify.js";

export {
  extractInboundCallback,
  extractInboundMessage,
  type TelegramInboundCallback,
  type TelegramInboundMessage,
  type TelegramUpdatePayload,
} from "./inbound.js";

export {
  drainSessionToTelegram,
  TELEGRAM_SESSION_FAILED_REPLY,
  type DrainSessionDeps,
} from "./outbound.js";

export {
  sendTelegramMessage,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
} from "./send.js";

export {
  answerCallbackQuery,
  editMessageReplyMarkup,
} from "./keyboards.js";

export { getTelegramFileUrl } from "./file.js";

export { dmResident, postToGroup } from "./notify.js";

export {
  processInboundTelegramUpdate,
  type ProcessUpdateDeps,
  type TelegramChannelState,
  type TelegramSessionAuth,
} from "./process-update.js";

export { telegramChannel, type TelegramChannelConfig } from "./factory.js";

export {
  createTelegramStateAdapter,
  getTelegramChatInstance,
  type RedisLike,
} from "./chat-instance.js";
