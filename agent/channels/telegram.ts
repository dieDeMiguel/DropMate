/**
 * Phase 1 spike: thin Telegram webhook.
 *
 * Mounts a single `POST /api/telegram` route. For each inbound update
 * it validates the secret-token header, looks up the Ash session id
 * for that chat in Redis (creating one if absent), drives a turn via
 * `send(...)`, and posts the assistant's reply back through the
 * Telegram Bot API.
 *
 * Phase 2 (issue #19) replaces this with a first-class Ash channel
 * built on `@chat-adapter/telegram` (Chat SDK) — keyboards, photos,
 * group mention routing, etc. For now we cover plain text DMs/groups
 * end-to-end so flows #16/#17/#18 can be developed against a real
 * Telegram bot.
 */

import { defineChannel, POST } from "experimental-ash/channels";

import { getSessionIdForChat, setSessionIdForChat } from "../../lib/redis.js";
import {
  extractInboundMessage,
  verifyTelegramSecretHeader,
  type TelegramUpdatePayload,
} from "../../lib/telegram-channel/index.js";
import { sendTelegramMessage } from "../../lib/telegram-api.js";

interface TelegramChannelState {
  readonly chatId: number;
  readonly isGroup: boolean;
  readonly fromUserId: number | null;
  readonly fromLanguageCode: string | null;
}

export default defineChannel<
  TelegramChannelState,
  { chatId: number; fromUserId: number | null }
>({
  state: undefined as unknown as TelegramChannelState,
  context: (state) => ({ chatId: state.chatId, fromUserId: state.fromUserId }),
  routes: [
    POST<TelegramChannelState>("/api/telegram", async (req, { send, waitUntil }) => {
      const verified = verifyTelegramSecretHeader(
        req,
        process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      );
      if (!verified.ok) {
        return new Response(verified.reason, { status: verified.status });
      }

      let update: TelegramUpdatePayload;
      try {
        update = (await req.json()) as TelegramUpdatePayload;
      } catch {
        return new Response("bad json", { status: 400 });
      }

      const inbound = extractInboundMessage(update);
      if (!inbound) {
        // Updates we don't handle yet (photos, edits, reactions, …)
        // are acked so Telegram doesn't retry.
        return new Response(null, { status: 204 });
      }

      const existingSessionId = await getSessionIdForChat(inbound.chatId);
      const continuationToken = existingSessionId ?? `tg:${inbound.chatId}`;

      const session = await send(inbound.text, {
        auth:
          inbound.fromUserId === null
            ? null
            : {
                principalId: String(inbound.fromUserId),
                principalType: "user",
                authenticator: "telegram",
                attributes: inbound.fromLanguageCode
                  ? { languageCode: inbound.fromLanguageCode }
                  : {},
              },
        continuationToken,
        state: {
          chatId: inbound.chatId,
          isGroup: inbound.isGroup,
          fromUserId: inbound.fromUserId,
          fromLanguageCode: inbound.fromLanguageCode,
        },
      });

      if (!existingSessionId) {
        // Persist immediately so a concurrent retry doesn't open a
        // second session for the same chat.
        await setSessionIdForChat(inbound.chatId, session.id);
      }

      // Drain the event stream in the background so the assistant's
      // reply gets posted back to Telegram after the HTTP response
      // returns. Telegram retries if the webhook hangs.
      waitUntil(
        (async () => {
          try {
            const stream = await session.getEventStream();
            const reader = stream.getReader();
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value.type === "message.completed" && value.data.message) {
                  await sendTelegramMessage(inbound.chatId, value.data.message);
                }
                if (value.type === "session.failed") {
                  await sendTelegramMessage(
                    inbound.chatId,
                    "Sorry, I hit an error processing that message.",
                  );
                }
              }
            } finally {
              reader.releaseLock();
            }
          } catch (err) {
            console.error("telegram webhook drain failed", err);
          }
        })(),
      );

      return new Response(null, { status: 204 });
    }),
  ],
});
