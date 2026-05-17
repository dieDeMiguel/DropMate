/**
 * Phase 2 Telegram channel — mount point.
 *
 * The full implementation lives under `lib/telegram-channel/`:
 *
 *   - `verify.ts`         — webhook signature check
 *   - `inbound.ts`        — raw-update → canonical message narrowing
 *   - `outbound.ts`       — Ash session event stream → Telegram replies
 *   - `send.ts`           — Bot API `sendMessage` primitive
 *   - `process-update.ts` — full inbound pipeline orchestrator
 *   - `factory.ts`        — `telegramChannel({ token, webhookSecret })`
 *
 * Ash discovers channels via the default export of files under
 * `agent/channels/`, so this file's only job is to construct the
 * channel with the deployment's bot token + webhook secret and
 * export it. Multi-bot deployments mount additional `telegramChannel(...)`
 * factories at other paths from sibling files in this directory.
 *
 * Env vars are read at module load time. A missing
 * `TELEGRAM_WEBHOOK_SECRET_TOKEN` surfaces at request time as a 500
 * with a named reason (see `verifyTelegramSecretHeader`); a missing
 * `TELEGRAM_BOT_TOKEN` surfaces inside `buildDefaultSendMessage`'s
 * drain when the first outbound reply fires.
 */

import { telegramChannel } from "../../lib/telegram-channel/index.js";

export default telegramChannel({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
});
