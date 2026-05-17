/**
 * Phase 2 Telegram channel — incremental scaffold.
 *
 * Issue #19 promotes the spike webhook (`agent/channels/telegram.ts`)
 * to a first-class Ash channel built on Chat SDK + `@chat-adapter/telegram`.
 * This barrel exports the pieces that don't need a live bot to validate:
 *
 *   - `verify.ts`     — webhook signature check (shared with the spike)
 *   - `inbound.ts`    — raw-update → canonical message narrowing
 *
 * The remaining Phase 2 modules (`chat-instance.ts`, `outbound.ts`,
 * `index.ts` factory) land in the next iteration on top of this
 * foundation so #19's `ChannelAdapter`-shaped factory has stable
 * primitives to compose.
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
