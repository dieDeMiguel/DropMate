/**
 * Phase 1 spike: thin Telegram webhook.
 *
 * Mounts a single `POST /api/telegram` route. The full inbound
 * pipeline (verify → parse → narrow → resolve session → send → drain)
 * lives in `lib/telegram-channel/process-update.ts`; this route's
 * job is just to wire the route args + env-derived config + Redis
 * helpers into that orchestrator and return the response it builds.
 *
 * Phase 2 (issue #19) replaces this with a first-class Ash channel
 * built on `@chat-adapter/telegram` (Chat SDK). The factory will
 * reuse `processInboundTelegramUpdate` with its captured `token` /
 * `webhookSecret` instead of the env-var fallbacks the spike uses.
 */

import { defineChannel, POST } from "experimental-ash/channels";

import { getSessionIdForChat, setSessionIdForChat } from "../../lib/redis.js";
import {
  drainSessionToTelegram,
  processInboundTelegramUpdate,
  type TelegramChannelState,
} from "../../lib/telegram-channel/index.js";

export default defineChannel<
  TelegramChannelState,
  { chatId: number; fromUserId: number | null }
>({
  state: undefined as unknown as TelegramChannelState,
  context: (state) => ({ chatId: state.chatId, fromUserId: state.fromUserId }),
  routes: [
    POST<TelegramChannelState>("/api/telegram", async (req, { send, waitUntil }) => {
      return processInboundTelegramUpdate(req, {
        expectedSecret: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        sendToAsh: send,
        waitUntil,
        getSessionIdForChat,
        setSessionIdForChat,
        // Token is left implicit so the drain falls back to
        // `process.env.TELEGRAM_BOT_TOKEN` — same behaviour the
        // spike has always had. When the Phase 2 channel factory
        // replaces this route, it will pass `{ token: capturedToken }`
        // explicitly and the env-var fallback in `outbound.ts`'s
        // `buildDefaultSendMessage` drops out of the codebase.
        drainSession: (session, chatId) =>
          drainSessionToTelegram(session, chatId, {
            token: process.env.TELEGRAM_BOT_TOKEN,
          }),
      });
    }),
  ],
});
