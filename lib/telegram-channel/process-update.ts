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
 * @see lib/telegram-channel/verify.ts   — header check (same primitive)
 * @see lib/telegram-channel/inbound.ts  — payload → canonical message
 * @see lib/telegram-channel/outbound.ts — `drainSessionToTelegram`
 * @see lib/telegram-channel/keyboards.ts — answer + edit Bot API helpers
 */

import type { UserContent } from "ai";
import type { Session } from "experimental-ash/channels";

import {
  extractInboundCallback,
  extractInboundMessage,
  type TelegramInboundCallback,
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
   */
  readonly sendToAsh: (
    message: string | UserContent,
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
   * Resolves a Telegram `file_id` (from `photo[]`) into a downloadable
   * HTTPS URL. Wired by the factory to `getTelegramFileUrl(token, id)`
   * with the closure-captured token; tests pass a spy.
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
}

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

async function handleCallbackQuery(
  cb: TelegramInboundCallback,
  deps: ProcessUpdateDeps,
): Promise<Response> {
  const parsed = parseCallbackData(cb.data);

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

  if (!existingSessionId) {
    await deps.setSessionIdForChat(cb.chatId, session.id);
  }

  deps.waitUntil(deps.drainSession(session, cb.chatId));

  return new Response(null, { status: 204 });
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

  // Callback queries are handled before regular messages — both branches
  // are exclusive at the Bot API level (a single update is either one or
  // the other, never both).
  const callback = extractInboundCallback(update);
  if (callback) {
    return handleCallbackQuery(callback, deps);
  }

  const inbound = extractInboundMessage(update);
  if (!inbound) {
    // Updates we don't handle yet (photos, edits, reactions, …) are
    // acked so Telegram doesn't retry indefinitely.
    return new Response(null, { status: 204 });
  }

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

  let message: string | UserContent;
  if (inbound.photoFileId !== null) {
    const url = await deps.getFileUrl(inbound.photoFileId);
    const captionText =
      inbound.text.length > 0 ? inbound.text : "(photo, no caption)";
    message = [
      { type: "image", image: new URL(url) },
      { type: "text", text: captionText },
    ];
  } else {
    message = inbound.text;
  }

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

  if (!existingSessionId) {
    // Persist immediately so a concurrent retry doesn't open a
    // second session for the same chat.
    await deps.setSessionIdForChat(inbound.chatId, session.id);
  }

  // Hand off the outbound drain to the caller's `waitUntil` so the
  // webhook response returns before the assistant finishes — Telegram
  // retries if the webhook hangs.
  deps.waitUntil(deps.drainSession(session, inbound.chatId));

  return new Response(null, { status: 204 });
}
