/**
 * Phase 2 channel — inbound update orchestrator.
 *
 * Owns the full inbound pipeline for a single Telegram webhook
 * delivery: verify → parse → narrow → drive `send(...)` with the
 * stable `tg:<chatId>` continuation token → background the outbound
 * drain.
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
 * Photo path: when an inbound update contains a photo, the
 * orchestrator runs ONE vision parser BEFORE handing the turn to the
 * conversational agent and folds the result into a synthetic text
 * message the agent reads as if the user typed it. Which parser fires
 * depends on the chat type:
 *
 *   group  → `parseLabel`         (Flow 1, shipping-label scan)
 *   DM     → `parseTrackingPage`  (Flow 2, /receive entry via screenshot)
 *
 * Both parsers are sibling tools in `agent/tools/` routed via Vercel AI
 * Gateway (Gemini 3.1 Flash Lite primary, Claude Sonnet 4.6 fallback).
 * The split matches where each flow actually triggers — labels are
 * announced in the group, reception requests start in DM — and lets
 * each parser keep a tight, single-purpose prompt instead of one
 * over-loaded "what kind of photo is this?" classifier. Low-confidence
 * parses get a "— please confirm before <next-step>" suffix so the
 * agent asks rather than auto-actioning on a guess. The model itself
 * still owns the final disambiguation (per `agent/instructions.md`):
 * a `[tracking page parsed]` message can produce either a /receive
 * card or a clarifying question depending on the surrounding DM
 * context.
 *
 * @see lib/telegram-channel/verify.ts   — header check (same primitive)
 * @see lib/telegram-channel/inbound.ts  — payload → canonical message
 * @see lib/telegram-channel/outbound.ts — `drainSessionToTelegram`
 * @see lib/telegram-channel/keyboards.ts — answer + edit Bot API helpers
 * @see agent/tools/parse_label.ts        — vision tool the photo path drives
 */

import type { Session } from "experimental-ash/channels";

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
   * Vision parser for carrier tracking-page screenshots (Flow 2 entry
   * via `/receive`). Wired by the factory to
   * `agent/tools/parse_tracking_page.ts`'s `execute({ imageUrl, caption })`.
   * The orchestrator calls this exactly once per inbound DM photo
   * update (groups still route to `parseLabel`); the result is folded
   * into a synthetic text message the conversational agent reads as if
   * the requester had typed the carrier/tracking/window themselves.
   *
   * Throws when the underlying model + fallback both fail — the
   * orchestrator's catch logs the error and falls back to a generic
   * "screenshot couldn't be read" prompt so the agent can ask the
   * requester to type the fields manually.
   */
  readonly parseTrackingPage: (input: {
    imageUrl: string;
    caption?: string;
  }) => Promise<{
    carrier: string;
    trackingNumber?: string;
    expectedWindowStartAt?: string;
    expectedWindowEndAt?: string;
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
  /**
   * Pre-handler scope check for `accept_reception_group` taps (#52).
   * Returns `true` when the tapping user has a `Resident` record (i.e.
   * has already `/register`ed); `false` otherwise. Implemented in the
   * factory via `getResident(String(userId))`. Used to short-circuit
   * the tap with a toast + leave the button live, so the user can
   * `/register` and retry without the card going dead.
   */
  readonly isRegisteredResident: (userId: number) => Promise<boolean>;
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
    case "accept_reception_group":
      return parsed.id
        ? `[button-tap] I'm tapping [Ich kann helfen] on the public /receive card for reception request ${parsed.id}. Ask me one short question for my availability window (in my language), then call accept_reception_request with requestId="${parsed.id}". After the tool returns: edit the group card in place to "✅ angenommen von <volunteer.name>" via editGroupCard using the returned groupCardChatId/groupCardMessageId and a text_mention entity on my name; DM me the operational handoff (requester's house/buzzer/floor + carrier + tracking + window, and the screenshotFileId if parseConfidence was "low"); DM the requester a short named confirmation in their language.`
        : "[button-tap] I'm tapping the public /receive card but no request id was attached — ignore.";
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

  // `accept_reception_group` taps (#52): the volunteer must be a
  // registered resident. Telegram bot DMs require the recipient to
  // have started a chat with the bot at least once, and accept tools
  // throw on unregistered callers anyway — short-circuit with a toast
  // so the user can `/register` and retry. Keyboard stays live so the
  // card doesn't go dead on a single wrong tap.
  if (parsed.action === "accept_reception_group" && parsed.id) {
    const isRegistered = await deps
      .isRegisteredResident(cb.fromUserId)
      .catch(() => false);
    if (!isRegistered) {
      await deps
        .answerCallback(
          cb.callbackId,
          "Bitte zuerst /register, um Paketen zu helfen.",
        )
        .catch(() => undefined);
      return new Response(null, { status: 204 });
    }
  }

  // Always ack + strip first. If either fails, we still try to drive
  // the agent: the worst case is a stale keyboard / lingering spinner,
  // not a missed action.
  await deps.answerCallback(cb.callbackId).catch(() => undefined);
  await deps.stripKeyboard(cb.chatId, cb.messageId).catch(() => undefined);

  const syntheticMessage = synthesizeCallbackMessage(parsed);

  // Stable chat-keyed continuation token. The Ash session id returned
  // from a previous turn is a per-run workflow id (e.g. `wrun_…`) that
  // becomes invalid after the run completes; reusing it caused every
  // follow-up turn to fail delivery ("deliver failed, starting new
  // session") and silently restart a context-free session. `tg:<chatId>`
  // is the stable key Ash actually keys session continuity on — see #65.
  const continuationToken = `tg:${cb.chatId}`;

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

  deps.waitUntil(deps.drainSession(session, cb.chatId));

  return new Response(null, { status: 204 });
}

/**
 * Photo path: resolve the file URL, run the appropriate vision parser,
 * and produce a synthetic text message the conversational agent reads
 * as if the user typed it. Tolerates failure at every step — the
 * agent's final-resort message tells it a photo arrived but couldn't
 * be parsed, so it can ask the user to retype the fields.
 *
 * Routing: group photos run through `parseLabel` (Flow 1 — shipping
 * label scan); DM photos run through `parseTrackingPage` (Flow 2 —
 * /receive entry via tracking-page screenshot). The split matches
 * where each flow actually triggers and keeps each parser's prompt
 * tight.
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

  let imageUrl: string;
  try {
    imageUrl = await deps.getFileUrl(fileId);
  } catch (err) {
    console.error(
      "[photo] file-url resolution failed for chatId",
      inbound.chatId,
      "— error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    return buildPhotoFallbackMessage(inbound.isGroup, captionForAgent);
  }

  if (inbound.isGroup) {
    return buildSyntheticLabelMessage(inbound, deps, imageUrl, captionText, captionForAgent);
  }
  return buildSyntheticTrackingPageMessage(inbound, deps, imageUrl, captionText, captionForAgent);
}

function buildPhotoFallbackMessage(isGroup: boolean, captionForAgent: string): string {
  if (isGroup) {
    return [
      "[photo received, label could not be parsed]",
      `caption: ${captionForAgent}`,
      "Please ask the holder (in their language) to type the recipient's name and house number so the package can be registered.",
    ].join(" ");
  }
  return [
    "[photo received, tracking page could not be parsed]",
    `caption: ${captionForAgent}`,
    "Please ask the requester (in their language) to type the carrier and expected delivery time so the reception request can be posted.",
  ].join(" ");
}

async function buildSyntheticLabelMessage(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
  imageUrl: string,
  captionText: string | undefined,
  captionForAgent: string,
): Promise<string> {
  let parsed: Awaited<ReturnType<ProcessUpdateDeps["parseLabel"]>> = null;
  try {
    parsed = await deps.parseLabel({ imageUrl, caption: captionText });
    console.info(
      "[parse_label] ok for chatId",
      inbound.chatId,
      "result:",
      parsed,
    );
  } catch (err) {
    console.error(
      "[parse_label] failed for chatId",
      inbound.chatId,
      "mediaType-via-fetch (sanitised) — error:",
      err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    );
    parsed = null;
  }

  if (parsed === null) {
    return buildPhotoFallbackMessage(true, captionForAgent);
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

async function buildSyntheticTrackingPageMessage(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
  imageUrl: string,
  captionText: string | undefined,
  captionForAgent: string,
): Promise<string> {
  let parsed: Awaited<ReturnType<ProcessUpdateDeps["parseTrackingPage"]>> = null;
  try {
    parsed = await deps.parseTrackingPage({ imageUrl, caption: captionText });
    console.info(
      "[parse_tracking_page] ok for chatId",
      inbound.chatId,
      "result:",
      parsed,
    );
  } catch (err) {
    console.error(
      "[parse_tracking_page] failed for chatId",
      inbound.chatId,
      "— error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    parsed = null;
  }

  if (parsed === null) {
    return buildPhotoFallbackMessage(false, captionForAgent);
  }

  const parts: string[] = ["[tracking page parsed]"];
  parts.push(`carrier=${parsed.carrier}`);
  if (parsed.trackingNumber) {
    parts.push(`tracking=${parsed.trackingNumber}`);
  }
  if (parsed.expectedWindowStartAt) {
    parts.push(`windowStart=${parsed.expectedWindowStartAt}`);
  }
  if (parsed.expectedWindowEndAt) {
    parts.push(`windowEnd=${parsed.expectedWindowEndAt}`);
  }
  parts.push(`confidence=${parsed.confidence}`);
  // Surface the Telegram file_id so the agent can pass it through to
  // `create_reception_request` as `screenshotFileId`. The volunteer's
  // operational DM at accept time uses this to attach the screenshot
  // on a low-confidence parse — see #52's accept handler.
  if (inbound.photoFileId !== null) {
    parts.push(`screenshotFileId=${inbound.photoFileId}`);
  }
  parts.push(`caption='${captionForAgent}'`);

  let synthetic = parts.join(" ");
  if (parsed.confidence === "low") {
    synthetic +=
      " — please confirm the parsed fields with the requester before posting the group card (the ETA window may be wrong).";
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

  // Stable chat-keyed continuation token. The previous design stored the
  // returned `session.id` (a per-run workflow id like `wrun_…`) and
  // reused it as next turn's continuation — but those ids become invalid
  // after the run completes, so every subsequent webhook saw
  // "deliver failed, starting new session" and silently spawned a fresh
  // session, losing all prior context. `tg:<chatId>` is the stable key
  // Ash actually keys session continuity on. See #65.
  const continuationToken = `tg:${inbound.chatId}`;

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

  // Hand off the outbound drain to the caller's `waitUntil` so the
  // webhook response returns before the assistant finishes — Telegram
  // retries if the webhook hangs.
  deps.waitUntil(deps.drainSession(session, inbound.chatId));

  return new Response(null, { status: 204 });
}
