/**
 * Phase 2 channel factory.
 *
 * `telegramChannel({ token, webhookSecret })` returns the same shape
 * the spike webhook (`agent/channels/telegram.ts`) currently exports
 * inline, but with the Bot API token and webhook secret captured in
 * closure rather than read from `process.env` at request time.
 *
 * The factory is the seam that lets `agent/channels/telegram.ts`
 * collapse to a one-line `export default telegramChannel({ ... })`.
 * Everything the route handler used to do — verify, parse, narrow,
 * resolve session, send, persist, drain — already lives in
 * `lib/telegram-channel/process-update.ts`; this file just wires
 * the captured config + the Redis helpers into that orchestrator.
 *
 * Why a closure instead of arguments to `processInboundTelegramUpdate`:
 *
 *   - The `defineChannel({ routes: [...] })` signature doesn't let
 *     us thread config into the handler from above — handlers receive
 *     `(req, RouteHandlerArgs)` and nothing else. Closure-capture is
 *     the standard way to thread per-channel config through.
 *   - Capturing once (at factory call time) means the spike's
 *     "read env on every request" behaviour goes away. Misconfiguration
 *     surfaces at boot rather than on the first inbound message.
 *
 * Multi-bot deployment becomes trivial: a single Ash app can mount
 * `telegramChannel({ token: BOT_A, webhookSecret: SECRET_A })` and
 * `telegramChannel({ token: BOT_B, webhookSecret: SECRET_B })` at
 * different routes by parameterising the factory's POST path —
 * something the env-coupled spike couldn't do.
 *
 * @see lib/telegram-channel/process-update.ts — the orchestrator
 * @see agent/channels/telegram.ts — the one-line caller (slice 3)
 */

import { defineChannel, GET, POST } from "experimental-ash/channels";

import parseLabelTool from "../../agent/tools/parse_label.js";
import {
  getPackage,
  getSessionIdForChat,
  setSessionIdForChat,
  upsertKnownTelegramUser,
} from "../redis.js";
import {
  buildFileProxyUrl,
  handleFileProxyRequest,
} from "./file-proxy.js";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
} from "./keyboards.js";
import { drainSessionToTelegram } from "./outbound.js";
import {
  processInboundTelegramUpdate,
  type TelegramChannelState,
} from "./process-update.js";

/**
 * Factory inputs. Both fields are required strings — the spike's
 * "env may be undefined" tolerance moves into the factory's caller
 * (which can do `process.env.X!` or throw early if missing).
 */
export interface TelegramChannelConfig {
  /**
   * Telegram Bot API token used for outbound `sendMessage` calls.
   * The factory threads this through `drainSessionToTelegram` via
   * its `deps.token` injection point.
   */
  readonly token: string;

  /**
   * Expected value of the `X-Telegram-Bot-Api-Secret-Token` header.
   * Set when configuring the webhook via Telegram's `setWebhook`
   * endpoint; required for `verifyTelegramSecretHeader` to admit a
   * request.
   */
  readonly webhookSecret: string;
}

/**
 * Build a `defineChannel`-shaped Phase 2 Telegram channel pre-wired
 * with the supplied Bot API token + webhook secret.
 *
 * Returns whatever `defineChannel` returns — the same value the
 * spike webhook currently `export default`s. The Ash runtime
 * discovers channels via the default export of files under
 * `agent/channels/`, so the one-line caller in slice 3 is literally
 * `export default telegramChannel({ ... })`.
 */
export function telegramChannel(config: TelegramChannelConfig) {
  const { token, webhookSecret } = config;

  return defineChannel<
    TelegramChannelState,
    { chatId: number; fromUserId: number | null }
  >({
    state: undefined as unknown as TelegramChannelState,
    context: (state) => ({ chatId: state.chatId, fromUserId: state.fromUserId }),
    routes: [
      // GET proxy for shipping-label photos. The Gateway server fetches
      // this URL (instead of Telegram's CDN directly) so we can override
      // the content-type that the CDN sometimes mis-reports as
      // `application/octet-stream` — vision providers reject anything
      // that isn't `image/*`. See `file-proxy.ts` for the full rationale.
      GET<TelegramChannelState>(
        "/api/telegram-file/:id",
        async (req, { params }) => {
          return handleFileProxyRequest(req, params.id, {
            token,
            secret: webhookSecret,
          });
        },
      ),
      POST<TelegramChannelState>(
        "/api/telegram",
        async (req, { send, waitUntil }) => {
          // The proxy URL must be absolute (the AI Gateway fetches it
          // server-side, not from the user's browser). Capture the
          // origin from the inbound webhook so the URL works on both
          // production (`drop-mate-delta.vercel.app`) and preview
          // deploys without an explicit env var.
          const origin = new URL(req.url).origin;
          return processInboundTelegramUpdate(req, {
            expectedSecret: webhookSecret,
            sendToAsh: send,
            waitUntil,
            getSessionIdForChat,
            setSessionIdForChat,
            drainSession: (session, chatId) =>
              drainSessionToTelegram(session, chatId, { token }),
            getFileUrl: async (fileId) =>
              buildFileProxyUrl(origin, fileId, webhookSecret),
            parseLabel: async (input) => {
              // No silent catch: errors propagate to process-update.ts's
              // catch which logs with stack + chatId. A silent `return
              // null` here hid an entire failure chain in production
              // (mediaType=application/octet-stream → provider reject →
              // primary throw → fallback throw → primary rethrow →
              // silenced by this catch → null → "couldn't read" reply).
              const execute = parseLabelTool.execute as (
                input: unknown,
                options: unknown,
              ) => Promise<{
                carrier: string;
                trackingNumber?: string;
                recipientName?: string;
                recipientHouseNumber?: string;
                confidence: "high" | "medium" | "low";
                reason: string;
              }>;
              return execute(input, {
                toolCallId: `parse_label:${Date.now()}`,
                messages: [],
              });
            },
            answerCallback: (callbackId, text) =>
              answerCallbackQuery(token, callbackId, text),
            stripKeyboard: (chatId, messageId) =>
              editMessageReplyMarkup(token, chatId, messageId),
            getPackageRecipientId: async (packageId) => {
              const pkg = await getPackage(packageId);
              return pkg?.recipientResidentId ?? null;
            },
            recordTelegramObservation: async (input) => {
              await upsertKnownTelegramUser(input);
            },
          });
        },
      ),
    ],
  });
}
