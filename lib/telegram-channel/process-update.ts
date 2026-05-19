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
 * Photo path (#43 item 1): when an inbound update contains a photo,
 * the orchestrator calls `parseLabel` BEFORE handing the turn to the
 * conversational agent. Vision happens once, in a dedicated tool
 * (`agent/tools/parse_label.ts`) routed through Vercel AI Gateway with
 * Gemma 4 31B as primary and Claude Opus 4.5 as fallback. The result
 * is folded into a synthetic text message ("[label parsed] carrier=DHL
 * recipient=… …") that the conversational model (Gemini Flash) sees
 * as text — eliminating the previous failure mode where Flash received
 * a `FilePart` and hallucinated "I cannot read images." Low-confidence
 * parses get a "— please confirm before registering" suffix so the
 * agent asks rather than auto-registers.
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
   * Always a plain `string`: photo updates are parsed via `parseLabel`
   * before this is called and the result is folded into a synthetic
   * text message (#43 item 1).
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
   * fetchable HTTPS URL on the Telegram file CDN. Wired by the factory
   * to `getTelegramFileUrl(token, id)` with the closure-captured token;
   * tests pass a spy.
   *
   * The URL embeds the bot token — that was the original concern in
   * #41, which we tried to address by switching to inline bytes. But
   * the Vercel AI Gateway client converts inline `Uint8Array` →
   * `data:image/jpeg;base64,...` URI, and the Gateway *server* rejects
   * `data:` URIs with "Unsupported file URI type". The supported
   * shape on the Gateway is an actual HTTP(S) URL it can fetch
   * server-side. We accept the token-in-URL exposure because the URL
   * never reaches end users — it's only handed to the Gateway for a
   * one-shot server-to-server fetch, and Telegram's file URLs expire
   * in ~1h. If defense-in-depth becomes important, swap to a Vercel
   * Blob proxy here (upload bytes once, hand the Blob URL to the
   * Gateway).
   */
  readonly getFileUrl: (fileId: string) => Promise<string>;
  /**
   * Vision parser for shipping-label photos. Wired by the factory to
   * `agent/tools/parse_label.ts`'s `execute({ imageUrl, caption })`.
   * The orchestrator calls this exactly once per inbound photo
   * update; the result is folded into a synthetic text message the
   * conversational agent reads as if the user had typed it.
   *
   * Throws when the underlying model + fallback both fail — the
   * orchestrator's catch logs the error and falls back to a generic
   * "I received a photo but couldn't read it" prompt so the agent
   * can ask the holder to retype the recipient.
   */
  readonly parseLabel: (input: {
    imageUrl: string;
    caption?: string;
  }) => Promise<{
    carrier: string;
    trackingNumber?: string;
    recipientName?: string;
    recipientHouseNumber?: string;
    confidence: "high" | "medium" | "low";
    reason: string;
  } | null>;
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
 * Photo path: resolve the file URL, parse the label via the vision tool,
 * and produce a synthetic text message the conversational agent reads
 * as if the user typed it. Tolerates failure at every step — the
 * agent's final-resort message tells it a photo arrived but couldn't
 * be parsed, so it can ask the holder to retype the recipient.
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

  let parsed: Awaited<ReturnType<ProcessUpdateDeps["parseLabel"]>> = null;
  try {
    const imageUrl = await deps.getFileUrl(fileId);
    // Vision call boundary — the diagram lights up the parse_label box
    // (only on photo trace kinds). #60 enriches with primary→fallback
    // retry visuals; for now this just bookends the call so the V1
    // animation engine has a clean start/end pair to render.
    emitTrace("parse_label", "start");
    parsed = await deps.parseLabel({
      imageUrl,
      caption: captionText,
    });
    emitTrace("parse_label", "end");
    // Log every successful parse so we can tell apart "model never got
    // called" from "model returned confidence=low with no recipientName".
    // URL excluded from the log (contains the bot token); only the
    // structured output and chatId.
    console.info(
      "[parse_label] ok for chatId",
      inbound.chatId,
      "result:",
      parsed,
    );
  } catch (err) {
    // Don't crash the turn — the agent has a "couldn't parse" branch that
    // asks the holder to retype. But DO log: silent failure here is what
    // hid Gateway model/auth errors during #43 item 1 rollout, so every
    // photo turn that ends in "couldn't read the label" now leaves a trail.
    console.error(
      "[parse_label] failed for chatId",
      inbound.chatId,
      "mediaType-via-fetch (sanitised) — error:",
      err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    );
    // Surface the failure on the diagram too. #60 renders this as the
    // red-flash terminal-failure visual; the V1 engine just stops
    // animating the parse_label box and lets the trace move on.
    emitTrace("parse_label", "error");
    parsed = null;
  }

  if (parsed === null) {
    return [
      "[photo received, label could not be parsed]",
      `caption: ${captionForAgent}`,
      "Please ask the holder (in their language) to type the recipient's name and house number so the package can be registered.",
    ].join(" ");
  }

  const parts: string[] = ["[label parsed]"];
  parts.push(`carrier=${parsed.carrier}`);
  if (parsed.recipientName) {
    parts.push(`recipient=${parsed.recipientName}`);
  }
  if (parsed.recipientHouseNumber) {
    parts.push(`house=${parsed.recipientHouseNumber}`);
  }
  if (parsed.trackingNumber) {
    parts.push(`tracking=${parsed.trackingNumber}`);
  }
  parts.push(`confidence=${parsed.confidence}`);
  parts.push(`caption='${captionForAgent}'`);

  let synthetic = parts.join(" ");
  if (parsed.confidence === "low") {
    synthetic +=
      " — please confirm with the holder before registering (the recipient name may be wrong).";
  }
  return synthetic;
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
  } else {
    message = inbound.text;
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
