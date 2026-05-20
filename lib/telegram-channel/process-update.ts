/**
 * Phase 2 channel — inbound update orchestrator.
 *
 * Owns the full inbound pipeline for a single Telegram webhook
 * delivery: verify → parse → narrow → resolve session id → drive
 * `send(...)` → persist session id → background the outbound drain.
 *
 * Lives here so:
 *
 *   1. The spike webhook (`agent/channels/telegram.ts`) collapses to
 *      a thin route shell that wires deps and returns the response
 *      this function builds.
 *   2. The eventual Phase 2 `telegramChannel({ token, webhookSecret })`
 *      factory plugs in the same orchestrator with its captured
 *      `token`/`secret` instead of reading them from `process.env`,
 *      so the factory's POST route is a one-liner.
 *   3. The full pipeline is unit-testable without spinning up Ash's
 *      runtime or hitting the Telegram Bot API.
 *
 * Everything that's environment-specific (secret, token, session-id
 * map, drain, send) arrives via `deps` so neither the spike's
 * env-var fallback nor the factory's closure-captured config leak
 * into this module.
 *
 * Callback queries (#24): button taps go through the same `sendToAsh`
 * + drain pipeline as a regular message — the orchestrator
 * synthesizes a short text describing the tap ("[button-tap] confirm
 * pickup of package pkg_42") and routes it as the user message. The
 * model then runs the matching tool (`confirm_pickup`,
 * `accept_reception_request`, …) the same way it would for a typed
 * reply. Three callback-only side effects happen before the agent
 * sees anything: ack the callback (clear the tap spinner), strip the
 * originating message's keyboard (no double-taps), and — for group
 * confirm_pickup taps — gate on the tapper actually being the
 * package's recipient.
 *
 * Photo path (#79): when an inbound update contains a photo, the
 * orchestrator resolves the file URL and hands the agent a synthetic
 * text message naming the URL + caption. The conversational agent then
 * calls `parse_label({ imageUrl, caption })` itself as a tool inside
 * the turn — vision attribution lands on the `ash.turn` span instead
 * of a sidecar pre-call.
 *
 * Earlier iterations of this orchestrator (#43 item 1, commit f1f81ee)
 * called `parseLabel` directly here BEFORE the agent ran, then folded
 * the parsed fields into a synthetic `[label parsed] …` message. That
 * worked but hid the vision call from Vercel Agent Runs (the parse
 * cost + tokens never showed up on the turn row). Promoting the call
 * to an agent-invoked tool keeps the conversational model (Gemini
 * Flash) off the FilePart — the agent sees only the structured text
 * shim plus the `parse_label` tool's schema — while attributing the
 * vision cost where it actually lives.
 *
 * Low-confidence parses still trigger a confirmation step: the agent
 * inspects the tool's `confidence` field and asks the holder to confirm
 * before calling `register_package`. That responsibility is documented
 * in `agent/instructions.md` Flow 1 (photo path).
 *
 * @see lib/telegram-channel/verify.ts   — header check (same primitive)
 * @see lib/telegram-channel/inbound.ts  — payload → canonical message
 * @see lib/telegram-channel/outbound.ts — `drainSessionToTelegram`
 * @see lib/telegram-channel/keyboards.ts — answer + edit Bot API helpers
 * @see agent/tools/parse_label.ts        — vision tool the photo path drives
 */

import type { Session } from "experimental-ash/channels";

import { emitTrace } from "../trace.js";
import {
  extractInboundCallback,
  extractInboundMessage,
  type TelegramInboundCallback,
  type TelegramInboundMessage,
  type TelegramUpdatePayload,
} from "./inbound.js";
import { verifyTelegramSecretHeader } from "./verify.js";

/**
 * Subset of an Ash `SessionAuthContext` we hand `send(...)`. Kept
 * loose (Record-typed) so this module doesn't pull in Ash's full
 * `SessionAuthContext` type — the spike's `defineChannel` call site
 * already enforces the contract at the route boundary.
 */
export interface TelegramSessionAuth {
  readonly principalId: string;
  readonly principalType: "user";
  readonly authenticator: "telegram";
  readonly attributes: Record<string, string>;
}

/**
 * State passed through `send(...)` and surfaced to tools via the
 * channel's `context(state)` projection. Mirrors the spike's
 * existing shape so the factory can drop in without changing tool
 * expectations.
 */
export interface TelegramChannelState {
  readonly chatId: number;
  readonly isGroup: boolean;
  readonly fromUserId: number | null;
  readonly fromLanguageCode: string | null;
}

/**
 * Caller-supplied dependencies. The spike webhook wires these to its
 * route args + the `lib/redis.ts` helpers; the factory next iteration
 * will pass its captured token + a closure over the same helpers.
 */
export interface ProcessUpdateDeps {
  /** Expected `X-Telegram-Bot-Api-Secret-Token` value. */
  readonly expectedSecret: string | undefined;
  /**
   * Ash `send(...)`. Typed loosely so tests can substitute a spy
   * without importing the runtime — the spike's `RouteHandlerArgs`
   * passes the real function through verbatim.
   *
   * Always a plain `string`: photo updates produce a synthetic message
   * naming the resolved file URL + caption. The conversational agent
   * reads the URL and calls `parse_label` as a tool inside its turn
   * (#79) — the vision call no longer happens in the orchestrator.
   */
  readonly sendToAsh: (
    message: string,
    options: {
      readonly auth: TelegramSessionAuth | null;
      readonly continuationToken: string;
      readonly state: TelegramChannelState;
    },
  ) => Promise<Session>;
  /** Vercel/Ash `waitUntil` for backgrounding the outbound drain. */
  readonly waitUntil: (task: Promise<unknown>) => void;
  /** Returns the previously-stored Ash session id for this chat, if any. */
  readonly getSessionIdForChat: (chatId: number) => Promise<string | null>;
  /** Persists the Ash session id for this chat (idempotent). */
  readonly setSessionIdForChat: (
    chatId: number,
    sessionId: string,
  ) => Promise<void>;
  /** Starts the outbound drain for the resolved session + chat. */
  readonly drainSession: (session: Session, chatId: number) => Promise<void>;
  /**
   * Resolves a Telegram `file_id` (from `photo[]`) into a publicly-
   * fetchable HTTPS URL the conversational agent can hand to the
   * `parse_label` tool. Wired by the factory to `buildFileProxyUrl(...)`;
   * tests pass a spy.
   *
   * The production wiring routes through the channel's own
   * `/api/telegram-file/:id` proxy rather than the raw Telegram CDN —
   * the proxy rewrites `application/octet-stream` to `image/*` so the
   * AI Gateway server's content-type validation accepts the fetched
   * bytes (see `lib/telegram-channel/file-proxy.ts` for the history).
   * The orchestrator only cares that it gets back an HTTPS URL it can
   * fold into the synthetic agent message.
   */
  readonly getFileUrl: (fileId: string) => Promise<string>;
  /**
   * Acks a `callback_query` so the Telegram client clears the tap
   * spinner. Optional `text` shows a brief toast to the tapper —
   * used for scope-rejection ("only the recipient can confirm").
   */
  readonly answerCallback: (
    callbackId: string,
    text?: string,
  ) => Promise<void>;
  /**
   * Removes the inline keyboard on the originating message so the
   * same button can't be tapped twice. Called for every accepted
   * tap before the agent runs.
   */
  readonly stripKeyboard: (chatId: number, messageId: number) => Promise<void>;
  /**
   * Recipient-scope guard for group `confirm_pickup` taps. Returns
   * the package's `recipientResidentId` (the Resident id we expect
   * the tapper to match), or `null` if the package is unknown or
   * unlinked. Implemented in the factory via `getPackage(packageId)`.
   *
   * Only consulted for callbacks with action `confirm_pickup` that
   * arrive in a group chat — DMs are already 1:1 scoped to the
   * tapper, no further check needed.
   */
  readonly getPackageRecipientId: (
    packageId: string,
  ) => Promise<string | null>;
  /**
   * Passive recording of every Telegram identity the bot sees. Fired
   * once per inbound update (message OR callback) before the agent
   * runs so even taps from previously-unseen users are captured.
   * Errors are swallowed at the call site so a failure here doesn't
   * crash the turn — the worst case is the user stays unmentionable
   * until their next message succeeds.
   */
  readonly recordTelegramObservation: (input: {
    readonly userId: number;
    readonly firstName: string;
    readonly lastName?: string;
    readonly username?: string;
    readonly languageCode?: string;
    readonly chatId: number;
  }) => Promise<void>;
  /**
   * Attaches the trigger sub-kind onto the active OpenTelemetry span so
   * the Vercel Observability Agent Runs view can populate the Trigger
   * column with a finer-grained value than the channel's `kindHint`
   * alone provides. The framework-canonical `kindHint: "telegram"` on
   * `defineChannel` covers the coarse case (every row reads `telegram`
   * in the dashboard's agent overview); this attribute lets a downstream
   * filter pick out message vs. callback vs. photo without re-parsing
   * the synthetic agent message.
   *
   * Fires once per inbound delivery, BEFORE `sendToAsh`, with the value
   * matching the inbound shape the orchestrator is about to route:
   *
   *   - `telegram-message`  — plain text DM or group message
   *   - `telegram-callback` — inline-keyboard button tap
   *   - `telegram-photo`    — inbound photo (the synthetic `[label parsed] …`
   *     text that follows the vision pre-call, see #43 item 1)
   *
   * Optional — when omitted, the orchestrator skips attribution silently
   * so tests can opt in by passing a spy and the spike webhook can run
   * without pulling in OpenTelemetry. The factory wires a real impl
   * that uses `trace.getActiveSpan()?.setAttribute("trigger", …)` when
   * `@opentelemetry/api` is loadable; if not, a no-op shim.
   */
  readonly setTriggerAttribute?: (trigger: TelegramTriggerKind) => void;
}

/**
 * The three inbound shapes the channel distinguishes for the Trigger
 * column. Layered on top of the framework-canonical `kindHint: "telegram"`
 * (which produces a single `telegram` value for the dashboard's channel
 * chip) so downstream observability can tell text DMs apart from button
 * taps and photo uploads without inspecting the synthetic agent message.
 */
export type TelegramTriggerKind =
  | "telegram-message"
  | "telegram-callback"
  | "telegram-photo";

/**
 * Parsed `callback_data` shape. The convention is `"<action>:<id>"`;
 * unknown actions are still admitted (the agent will see the raw
 * text and decide whether to do anything).
 */
interface ParsedCallbackData {
  readonly action: string;
  readonly id: string | null;
}

function parseCallbackData(data: string): ParsedCallbackData {
  const idx = data.indexOf(":");
  if (idx < 0) return { action: data, id: null };
  return {
    action: data.slice(0, idx),
    id: data.slice(idx + 1) || null,
  };
}

/**
 * Human-readable synthetic message the orchestrator hands to the
 * agent in place of the user's tap. The agent reads this as the
 * user's "I want to do X" intent and runs the matching tool.
 *
 * Kept in English regardless of the user's language: the agent's
 * system prompt + the user's stored `Resident.language` will drive
 * the *reply* localisation. The synthetic message is internal
 * scaffolding the user never sees.
 */
function synthesizeCallbackMessage(parsed: ParsedCallbackData): string {
  switch (parsed.action) {
    case "confirm_pickup":
      return parsed.id
        ? `[button-tap] I'm confirming pickup of package ${parsed.id}. Please run confirm_pickup with that id and post the usual short group announcement.`
        : "[button-tap] I'm confirming pickup but no package id was attached to the button — ignore.";
    case "accept_reception_request":
      return parsed.id
        ? `[button-tap] I'm accepting the reception request ${parsed.id}. Treat this as 'yes, I can receive'; if I haven't said when, ask for the availability window.`
        : "[button-tap] I'm accepting a reception request but no id was attached — ignore.";
    case "decline_reception_request":
      return parsed.id
        ? `[button-tap] I'm declining the reception request ${parsed.id}. Acknowledge briefly in my language and don't ask follow-up questions.`
        : "[button-tap] I'm declining a reception request but no id was attached — ignore.";
    case "remind_later":
      return parsed.id
        ? `[button-tap] I'd like to be reminded about package ${parsed.id} later. Acknowledge briefly — no state change needed; the scheduled reminder will catch this anyway.`
        : "[button-tap] Remind-later tapped but no package id was attached — ignore.";
    default:
      return parsed.id
        ? `[button-tap] action=${parsed.action} id=${parsed.id}. Use your best judgement.`
        : `[button-tap] action=${parsed.action}. Use your best judgement.`;
  }
}

/**
 * Best-effort passive recording of an inbound Telegram identity.
 * Swallows errors — we never want a Redis hiccup to crash a turn that
 * would otherwise have proceeded — but logs them so silent data loss
 * is visible in the Vercel logs.
 */
async function recordInboundObservation(
  deps: ProcessUpdateDeps,
  observation: {
    userId: number | null;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    languageCode: string | null;
    chatId: number;
  },
): Promise<void> {
  if (observation.userId === null || observation.firstName === null) return;
  try {
    await deps.recordTelegramObservation({
      userId: observation.userId,
      firstName: observation.firstName,
      lastName: observation.lastName ?? undefined,
      username: observation.username ?? undefined,
      languageCode: observation.languageCode ?? undefined,
      chatId: observation.chatId,
    });
  } catch (err) {
    console.warn(
      "[process-update] recordTelegramObservation failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

async function handleCallbackQuery(
  cb: TelegramInboundCallback,
  deps: ProcessUpdateDeps,
): Promise<Response> {
  const parsed = parseCallbackData(cb.data);

  // Passive directory update — fire before any short-circuit so even
  // taps from non-recipients still teach the bot who's in the group.
  await recordInboundObservation(deps, {
    userId: cb.fromUserId,
    firstName: cb.fromFirstName,
    lastName: cb.fromLastName,
    username: cb.fromUsername,
    languageCode: cb.fromLanguageCode,
    chatId: cb.chatId,
  });

  // Group `confirm_pickup` taps: only the recipient may close the
  // package. DMs are inherently 1:1 so no check needed.
  if (cb.isGroup && parsed.action === "confirm_pickup" && parsed.id) {
    const recipientId = await deps.getPackageRecipientId(parsed.id).catch(() => null);
    if (recipientId === null || recipientId !== String(cb.fromUserId)) {
      await deps
        .answerCallback(cb.callbackId, "Only the recipient can confirm pickup.")
        .catch(() => undefined);
      // Leave the keyboard intact — the actual recipient may still tap.
      return new Response(null, { status: 204 });
    }
  }

  // Always ack + strip first. If either fails, we still try to drive
  // the agent: the worst case is a stale keyboard / lingering spinner,
  // not a missed action.
  await deps.answerCallback(cb.callbackId).catch(() => undefined);
  await deps.stripKeyboard(cb.chatId, cb.messageId).catch(() => undefined);

  const syntheticMessage = synthesizeCallbackMessage(parsed);

  const existingSessionId = await deps.getSessionIdForChat(cb.chatId);
  const continuationToken = existingSessionId ?? `tg:${cb.chatId}`;

  const auth: TelegramSessionAuth = {
    principalId: String(cb.fromUserId),
    principalType: "user",
    authenticator: "telegram",
    attributes: cb.fromLanguageCode
      ? { languageCode: cb.fromLanguageCode }
      : {},
  };

  // Attribute the inbound shape onto the active OTel span BEFORE the
  // turn starts. Vercel's Agent Runs view reads this attribute to
  // populate the Trigger column; framework-canonical channels (Slack,
  // Twilio) get this for free via `kindHint`, and the custom Telegram
  // channel layers a finer-grained value on top so message / callback /
  // photo are distinguishable in the dashboard's run filters.
  deps.setTriggerAttribute?.("telegram-callback");

  const session = await deps.sendToAsh(syntheticMessage, {
    auth,
    continuationToken,
    state: {
      chatId: cb.chatId,
      isGroup: cb.isGroup,
      fromUserId: cb.fromUserId,
      fromLanguageCode: cb.fromLanguageCode,
    },
  });

  if (session.id !== existingSessionId) {
    await deps.setSessionIdForChat(cb.chatId, session.id);
  }

  deps.waitUntil(deps.drainSession(session, cb.chatId));

  return new Response(null, { status: 204 });
}

/**
 * Photo path: resolve the file URL and hand the agent a synthetic
 * message naming the URL + caption. The conversational agent reads
 * this as the user's intent and calls `parse_label({ imageUrl, caption })`
 * itself as a tool, keeping the vision cost attributed to the
 * `ash.turn` span (#79).
 *
 * Tolerates a `getFileUrl` failure: if the URL can't be resolved (Bot
 * API 404, network blip), the synthetic message tells the agent the
 * photo arrived but the URL is gone, and the agent asks the holder
 * to type the recipient details. The vision tool itself runs inside
 * the turn — its own try/catch handles primary→fallback retry and
 * surfaces errors via the diagram.
 */
async function buildSyntheticPhotoMessage(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
): Promise<string> {
  const fileId = inbound.photoFileId;
  if (fileId === null) {
    // Defensive — caller already narrowed.
    return inbound.text.length > 0 ? inbound.text : "(photo, no caption)";
  }

  const captionText = inbound.text.length > 0 ? inbound.text : undefined;
  const captionForAgent = captionText ?? "(no caption)";

  let imageUrl: string | null;
  try {
    imageUrl = await deps.getFileUrl(fileId);
  } catch (err) {
    // Don't crash the turn — the agent can still ask the holder to
    // retype the recipient. But DO log: silent failure here would
    // mask Bot API auth issues / quota problems that need ops attention.
    console.error(
      "[process-update] getFileUrl failed for chatId",
      inbound.chatId,
      "fileId",
      fileId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    imageUrl = null;
  }

  if (imageUrl === null) {
    return [
      "[photo received, file url could not be resolved]",
      `caption: ${captionForAgent}`,
      "Please ask the holder (in their language) to type the recipient's name and house number so the package can be registered.",
    ].join(" ");
  }

  // The agent reads this as the user's intent: a photo arrived, here's
  // the URL, here's any caption — call `parse_label` to extract the
  // structured fields before continuing with the rest of Flow 1.
  // Caption is wrapped in single quotes (escaped via doubling) so
  // captions containing spaces still parse cleanly as one field.
  const escapedCaption = captionForAgent.replace(/'/g, "''");
  return `[photo received] file_url=${imageUrl} caption='${escapedCaption}'`;
}

/**
 * Runs one inbound Telegram webhook delivery through the agent.
 *
 * Returns the HTTP `Response` the route should reply with. Telegram
 * retries on non-2xx so error paths use precise status codes: 401 for
 * a bad/missing secret token, 500 for a server-side misconfig, 400
 * for malformed JSON, 204 for everything else (handled or ignored).
 */
export async function processInboundTelegramUpdate(
  req: Request,
  deps: ProcessUpdateDeps,
): Promise<Response> {
  // Per-stage instrumentation for the live diagram (#59). The webhook
  // factory wraps this call in `runWithTrace`, so every emit below
  // inherits the same `traceId` + `kind`. `webhook.start` fires before
  // any short-circuit (bad secret, malformed JSON) so the diagram still
  // ignites for rejected webhooks; `orchestrator.start`/`.end` bookend
  // the work that survives the early-exit branches.
  emitTrace("webhook", "start");

  const verified = verifyTelegramSecretHeader(req, deps.expectedSecret);
  if (!verified.ok) {
    return new Response(verified.reason, { status: verified.status });
  }

  let update: TelegramUpdatePayload;
  try {
    update = (await req.json()) as TelegramUpdatePayload;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  emitTrace("orchestrator", "start");

  // Callback queries are handled before regular messages — both branches
  // are exclusive at the Bot API level (a single update is either one or
  // the other, never both).
  const callback = extractInboundCallback(update);
  if (callback) {
    const res = await handleCallbackQuery(callback, deps);
    emitTrace("orchestrator", "end");
    return res;
  }

  const inbound = extractInboundMessage(update);
  if (!inbound) {
    // Updates we don't handle yet (photos, edits, reactions, …) are
    // acked so Telegram doesn't retry indefinitely.
    emitTrace("orchestrator", "end");
    return new Response(null, { status: 204 });
  }

  // Passive directory update — every actionable inbound message
  // captures the sender so they can later be `text_mention`'d in the
  // group post when a label names them. Best-effort: errors are logged
  // but never crash the turn.
  await recordInboundObservation(deps, {
    userId: inbound.fromUserId,
    firstName: inbound.fromFirstName,
    lastName: inbound.fromLastName,
    username: inbound.fromUsername,
    languageCode: inbound.fromLanguageCode,
    chatId: inbound.chatId,
  });

  const existingSessionId = await deps.getSessionIdForChat(inbound.chatId);
  const continuationToken = existingSessionId ?? `tg:${inbound.chatId}`;

  const auth: TelegramSessionAuth | null =
    inbound.fromUserId === null
      ? null
      : {
          principalId: String(inbound.fromUserId),
          principalType: "user",
          authenticator: "telegram",
          attributes: inbound.fromLanguageCode
            ? { languageCode: inbound.fromLanguageCode }
            : {},
        };

  let message: string;
  if (inbound.photoFileId !== null) {
    message = await buildSyntheticPhotoMessage(inbound, deps);
    deps.setTriggerAttribute?.("telegram-photo");
  } else {
    message = inbound.text;
    deps.setTriggerAttribute?.("telegram-message");
  }

  emitTrace("ash_send", "start");
  const session = await deps.sendToAsh(message, {
    auth,
    continuationToken,
    state: {
      chatId: inbound.chatId,
      isGroup: inbound.isGroup,
      fromUserId: inbound.fromUserId,
      fromLanguageCode: inbound.fromLanguageCode,
    },
  });
  emitTrace("ash_send", "end");

  if (session.id !== existingSessionId) {
    // Persist immediately so a concurrent retry doesn't open a
    // second session for the same chat. We re-pin on *every* id
    // change (not just the no-prior-id case) because the Ash channel
    // silently spawns a fresh session when delivery to the stored
    // continuation fails — without re-pinning, the stale id stays in
    // Redis for the 7d TTL and every subsequent turn restarts a
    // context-free session.
    await deps.setSessionIdForChat(inbound.chatId, session.id);
  }

  // Hand off the outbound drain to the caller's `waitUntil` so the
  // webhook response returns before the assistant finishes — Telegram
  // retries if the webhook hangs.
  deps.waitUntil(deps.drainSession(session, inbound.chatId));

  emitTrace("orchestrator", "end");
  return new Response(null, { status: 204 });
}
