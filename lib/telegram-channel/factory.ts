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

import classifyDmIntentTool from "../../agent/tools/classify_dm_intent.js";
import parseTrackingPageTool from "../../agent/tools/parse_tracking_page.js";
import {
  acceptReceptionRequest,
  createReceptionRequest,
} from "../reception-request.js";
import { registerResident } from "../registration.js";
import {
  getPackage,
  getResident,
  upsertKnownTelegramUser,
} from "../redis.js";
import { runWithTrace, type TraceKind } from "../trace.js";
import {
  buildFileProxyUrl,
  handleFileProxyRequest,
} from "./file-proxy.js";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
} from "./keyboards.js";
import { editGroupCard } from "./notify.js";
import { drainSessionToTelegram } from "./outbound.js";
import {
  processInboundTelegramUpdate,
  type TelegramChannelState,
} from "./process-update.js";
import { sendTelegramMessage } from "./send.js";
import { handleTraceSseRequest } from "./trace-routes.js";
import { setTelegramTriggerAttribute } from "./trigger-attribute.js";

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
    // Framework-canonical channel attribution (#99). Vercel's Agent Runs
    // view and the dashboard's project-overview card both read this;
    // without it every row shows `—` in the Trigger column (`unknown`
    // adapter bucket). The finer-grained per-shape values
    // (`telegram.text-dm`, `telegram.callback-confirm-pickup`, …) are
    // layered on top in process-update.ts via `setTriggerAttribute` so
    // downstream filters can tell text DMs apart from button taps and
    // photo uploads.
    kindHint: "telegram",
    state: undefined as unknown as TelegramChannelState,
    context: (state) => ({ chatId: state.chatId, fromUserId: state.fromUserId }),
    routes: [
      // Live-diagram SSE feed (#99 re-apply; originally #58). Subscribes
      // to the trace bus and forwards every event to the connected
      // browser. The webhook handler downstream emits trace events
      // inside the `runWithTrace` scope set up by the POST route; the
      // booth-demo page (#102) renders each box accordingly.
      GET<TelegramChannelState>("/api/trace", async (req) =>
        handleTraceSseRequest(req),
      ),

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

          // Live-diagram tracer (#99): every inbound webhook gets a fresh
          // trace scope. Peek at the payload via `req.clone()` so we can
          // set the right `kind` (photo → amber; callback → magenta)
          // BEFORE processInboundTelegramUpdate runs. A clone is cheap
          // and it avoids re-entering `runWithTrace` mid-pipeline, which
          // would mean any orchestrator entry-point emit landed with the
          // wrong kind.
          const traceId = crypto.randomUUID().slice(0, 8);
          const kind = await detectTraceKind(req);
          return runWithTrace({ traceId, kind }, () =>
          processInboundTelegramUpdate(req, {
            expectedSecret: webhookSecret,
            sendToAsh: send,
            waitUntil,
            drainSession: (session, chatId) =>
              drainSessionToTelegram(session, chatId, { token }),
            getFileUrl: async (fileId) =>
              buildFileProxyUrl(origin, fileId, webhookSecret),
            parseTrackingPage: async (input) => {
              // No silent catch: errors propagate to process-update.ts's
              // catch which logs with stack + chatId, and the channel
              // sends the deterministic recovery prompt DM (per #100 —
              // no agent involvement on the DM photo path).
              const execute = parseTrackingPageTool.execute as (
                input: unknown,
                options: unknown,
              ) => Promise<{
                carrier:
                  | "DHL"
                  | "Hermes"
                  | "DPD"
                  | "GLS"
                  | "UPS"
                  | "Amazon"
                  | "unknown";
                trackingNumber?: string;
                expectedWindowStartAt?: string;
                expectedWindowEndAt?: string;
                absenceSignal?: boolean;
                confidence: "high" | "medium" | "low";
                reason: string;
              }>;
              return execute(input, {
                toolCallId: `parse_tracking_page:${Date.now()}`,
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
            isRegisteredResident: async (userId) => {
              const resident = await getResident(String(userId));
              return resident !== null;
            },
            classifyDmIntent: async (input) => {
              // No silent catch: errors propagate to process-update.ts's
              // catch which logs with stack + chatId, and falls through
              // to v2 behaviour (raw text to the agent). A silent
              // `return safe-default` here would mask classifier outages.
              const execute = classifyDmIntentTool.execute as (
                input: unknown,
                options: unknown,
              ) => Promise<{
                isFlow2: boolean;
                absenceSignal: boolean;
                carrier?:
                  | "DHL"
                  | "Hermes"
                  | "DPD"
                  | "GLS"
                  | "UPS"
                  | "Amazon"
                  | "unknown";
                expectedDate?: string;
                expectedWindowStartAt?: number;
                expectedWindowEndAt?: number;
                confidence: "high" | "medium" | "low";
                reason: string;
              }>;
              return execute(input, {
                toolCallId: `classify_dm_intent:${Date.now()}`,
                messages: [],
              });
            },
            getRegisteredResident: async (userId) =>
              getResident(String(userId)),
            createReceptionRequest: (caller, input) =>
              createReceptionRequest(caller, input),
            acceptReceptionRequest: (caller, input) =>
              acceptReceptionRequest(caller, input),
            editGroupCard: (chatId, messageId, text) =>
              editGroupCard(token, chatId, messageId, text),
            sendDirectMessage: async (chatId, text, entities) => {
              await sendTelegramMessage(token, chatId, text, undefined, entities);
            },
            registerResident: (input) => registerResident(input),
            setTriggerAttribute: setTelegramTriggerAttribute,
          }),
          );
        },
      ),
    ],
  });
}

/**
 * Best-effort trace-kind detection from a Telegram webhook payload.
 * Drives the booth-diagram colour palette (#99 / #102):
 *
 *   - `callback_query` present     → "callback" (magenta)
 *   - `message.photo[]` non-empty  → "photo"    (amber)
 *   - anything else                → "text"     (default cyan)
 *
 * Reads the body via `req.clone().json()` so the downstream
 * `processInboundTelegramUpdate` call still gets a fresh, unconsumed
 * body to parse. Any error (malformed JSON, missing fields, network
 * read failure on the clone) falls through to "text" — the diagram
 * just renders the trace in the default colour and the orchestrator's
 * own validation handles the bad-input case.
 *
 * Exported only for tests; production callers go through the POST
 * route which uses it internally.
 */
export async function detectTraceKind(req: Request): Promise<TraceKind> {
  try {
    const peek = (await req.clone().json()) as {
      callback_query?: unknown;
      message?: { photo?: ReadonlyArray<unknown> };
    };
    if (peek && peek.callback_query) return "callback";
    if (peek && peek.message?.photo && peek.message.photo.length > 0) {
      return "photo";
    }
    return "text";
  } catch {
    return "text";
  }
}
