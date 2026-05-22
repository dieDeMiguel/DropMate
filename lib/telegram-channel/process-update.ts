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
 * model then runs the matching tool (`confirm_pickup`, …) the same
 * way it would for a typed reply. Three callback-only side effects
 * happen before the agent sees anything: ack the callback (clear the
 * tap spinner), strip the originating message's keyboard (no
 * double-taps), and — for group confirm_pickup taps — gate on the
 * tapper actually being the package's recipient.
 *
 * Photo path: routing is by chat type.
 *
 *   - Group photo → Flow 1 (the holder is showing a shipping label they
 *     received on someone else's package). The channel resolves the
 *     Telegram `file_id` to a signed HTTPS URL via `getFileUrl` and
 *     hands the agent a `[photo received] file_url=… caption='…'`
 *     synthetic. The agent invokes `parse_label({ imageUrl, caption })`
 *     itself as the first tool call of the turn, so the vision call's
 *     input/output token spend lands inside `ash.turn` rather than as
 *     a sidecar. Pre-#79: the orchestrator pre-called `parseLabel` and
 *     folded the result into a `[label parsed] …` synthetic. The
 *     conversational model never sees image bytes either way — it
 *     reads the tool's structured return value.
 *   - DM photo → `parse_tracking_page` + channel-side routing
 *     (Flow 2 v2.1 / #88, fully agent-bypassed per #100). On
 *     `confidence === "high"` AND `absenceSignal` in {`true`,
 *     `undefined`}, the channel writes the `ReceptionRequest` directly
 *     via `createReceptionRequest` and sends the requester ONE
 *     localised ack DM via `sendDirectMessage` (no agent invocation).
 *     On any other outcome (low/medium confidence, explicit
 *     `absenceSignal: false`, parse failure, unregistered caller,
 *     Redis hiccup), the channel sends a localised recovery prompt DM
 *     pointing at `/receive` (Slice 2 / #87) and inline `/register`
 *     for unregistered senders. The agent never runs on the DM photo
 *     path under any condition.
 *
 * Both vision tools route through Vercel AI Gateway with Gemini 3.1
 * Flash Lite as primary and Claude Sonnet 4.6 as fallback. The
 * conversational model (Gemini Flash) reads only structured tool
 * results — eliminating the previous failure mode where Flash received
 * a `FilePart` directly and hallucinated "I cannot read images."
 *
 * @see lib/telegram-channel/verify.ts        — header check (same primitive)
 * @see lib/telegram-channel/inbound.ts       — payload → canonical message
 * @see lib/telegram-channel/outbound.ts      — `drainSessionToTelegram`
 * @see lib/telegram-channel/keyboards.ts     — answer + edit Bot API helpers
 * @see agent/tools/parse_label.ts            — vision tool for the group/label path
 * @see agent/tools/parse_tracking_page.ts    — vision tool for the DM/screenshot path
 */

import type { Session } from "experimental-ash/channels";

import {
  ACCEPT_DIFFERENT_STREET_ERROR_CODE,
  ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE,
  type AcceptReceptionRequestInput,
  type AcceptReceptionRequestResult,
  type CreateReceptionRequestInput,
  type CreateReceptionRequestResult,
} from "../reception-request.js";
import { normaliseLanguageCode } from "../language.js";
import {
  REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE,
  type RegisterPackageInput,
  type RegisterPackageResult,
} from "../package.js";
import type { PackageCarrier, Resident } from "../redis.js";
import { emitTrace } from "../trace.js";
import {
  buildRegistrationConfirmationDm,
  isRegisterCommand,
  parseFreeTextRegistration,
  parseRegisterCommand,
  type ParsedRegistration,
  type RegisterResidentInput,
  type RegisterResidentResult,
} from "../registration.js";
import { isReceiveCommand, parseReceiveCommand } from "../slash-command.js";

import {
  buildFlow2AckDm,
  buildFlow2VisionLowConfidenceDm,
} from "./flow-2-dms.js";
import {
  buildGroupAckText,
  buildHolderNotRegisteredNudge,
  buildPickupKeyboard,
  buildRecipientDmText,
} from "./flow-1-dms.js";
import {
  extractInboundCallback,
  extractInboundMessage,
  type TelegramInboundCallback,
  type TelegramInboundMessage,
  type TelegramUpdatePayload,
} from "./inbound.js";
import type { InlineKeyboardMarkup, TelegramMessageEntity } from "./send.js";
import { verifyTelegramSecretHeader } from "./verify.js";
import {
  buildRequesterAcceptDm,
  buildVolunteerAcceptDmText,
  crossStreetToastForLanguage,
  selfAcceptToastForLanguage,
} from "./volunteer-accept-dms.js";

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
   * Always a plain `string`. For group photos the orchestrator hands
   * the agent a `[photo received] file_url=… caption='…'` synthetic
   * (the agent calls `parse_label` itself, #79); for DM photos the
   * channel handles Flow 2 deterministically (#100) and `sendToAsh`
   * is not invoked at all on the success path.
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
   * Vision parser for carrier tracking-page screenshots (Flow 2 v2 /
   * #69; v2.1 Slice 3 / #88 rewired the consumption; #100 made the
   * downstream DM channel-deterministic). Wired by the factory to
   * `agent/tools/parse_tracking_page.ts`'s `execute({ imageUrl,
   * caption })`. The orchestrator calls this exactly once per inbound
   * DM photo update; the result drives the channel-side routing
   * decision in `routeDmPhoto`:
   *
   *   - `confidence === "high"` AND `absenceSignal` in {`true`,
   *     `undefined`} AND registered caller → channel calls
   *     `createReceptionRequest` directly + sends the deterministic
   *     ack DM via `sendDirectMessage`. No agent invocation.
   *   - anything else → channel sends the deterministic recovery
   *     prompt DM ("retry with /receive, register first if you
   *     haven't"). No agent invocation either way.
   *
   * Throws when the underlying model + fallback both fail — the
   * orchestrator's catch logs the error and sends the recovery prompt
   * DM so the user gets an actionable next step without the agent
   * running.
   *
   * Group photos route through the agent (it calls `parse_label`
   * itself, #79); the orchestrator picks the DM vs group branch off
   * `inbound.isGroup`.
   */
  readonly parseTrackingPage: (input: {
    imageUrl: string;
    caption?: string;
  }) => Promise<{
    carrier: PackageCarrier;
    trackingNumber?: string;
    expectedWindowStartAt?: string;
    expectedWindowEndAt?: string;
    absenceSignal?: boolean;
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
   * Resolves whether a Telegram `user_id` already has a `Resident`
   * record. Consulted exclusively for the Flow 2 v2 group-card tap
   * (`accept_reception_group:<id>`) — unregistered tappers get a
   * toast asking them to `/register` and the button stays live so
   * they can retry after registration. Implemented in the factory
   * via `getResident(String(userId)) !== null`.
   *
   * Throwing is treated by the orchestrator as "unregistered" so a
   * Redis hiccup doesn't accidentally admit a tapper who'd otherwise
   * be rejected.
   */
  readonly isRegisteredResident: (userId: number) => Promise<boolean>;
  /**
   * v2.1 Slice 1 (#86): classifier for free-text DM text inbounds.
   * The channel calls this on every DM text message BEFORE the agent
   * runs so the card-posting decision is deterministic and lives
   * outside the model's reasoning loop (the v2 regression at #85
   * showed the model can't be trusted with this routing).
   *
   * Throws on irrecoverable failure (both primary + fallback errored).
   * The channel's catch logs the error and falls through to handing
   * the raw text to the agent — so a classifier outage degrades to v2
   * behaviour rather than blocking the user entirely.
   */
  readonly classifyDmIntent: (input: {
    text: string;
    languageHint?: string;
  }) => Promise<Flow2ClassificationResult>;
  /**
   * v2.1 #106 Slice 1: classifier for group text inbounds. Mirrors
   * `classifyDmIntent` shape but for the Flow 1 register-package
   * decision — the channel calls this on every group text message
   * BEFORE the agent runs so the registration decision lives outside
   * the model's reasoning loop. The live trace 2026-05-22 showed a
   * single group photo producing 20+ free-form messages on the agent
   * path; this classifier closes the same surface for text.
   *
   * Throws on irrecoverable failure (both primary + fallback errored).
   * The channel's catch logs the error and stays silent in the group
   * — better to miss the routing than to misroute. (Contrast with
   * `classifyDmIntent`'s fall-through-to-agent behaviour: a group
   * text classifier outage going to the agent is exactly what #106
   * exists to prevent.)
   */
  readonly classifyGroupMessage: (input: {
    text: string;
    languageHint?: string;
  }) => Promise<ClassifyGroupMessageResult>;
  /**
   * v2.1 #106 Slice 1: channel-side handle for the lib-level
   * `registerPackage`. The channel calls this directly (no agent
   * invocation) when the group classifier returns a high-confidence
   * package registration verdict. Implemented in the factory as a
   * thin re-export of `lib/package.ts::registerPackage`.
   *
   * Throws `RegisterPackageError` with code
   * `REGISTER_PACKAGE_HOLDER_NOT_REGISTERED` when the holder is not a
   * registered Resident — the channel sends a localised /register
   * nudge in that case. Other Redis hiccups bubble up as plain
   * Errors; the channel logs them and stays silent.
   */
  readonly registerPackage: (
    holder: Resident | null,
    input: RegisterPackageInput,
  ) => Promise<RegisterPackageResult>;
  /**
   * Resolves a Telegram `user_id` to the full `Resident` record (or
   * `null` if unregistered). Consumed by the Flow 2 v2 channel path:
   * when the classifier returns `confidence: "high"`, the channel
   * needs the caller's stored language to pick the right ack-DM
   * template + the caller object to hand to `createReceptionRequest`.
   *
   * Implemented in the factory via `getResident(String(userId))`.
   */
  readonly getRegisteredResident: (userId: number) => Promise<Resident | null>;
  /**
   * v2.1 Slice 1 (#86): channel-side handle for the lib-level
   * `createReceptionRequest`. The channel calls this directly (no
   * agent invocation) when the classifier returns high-confidence
   * Flow 2. Implemented in the factory as a thin re-export of
   * `lib/reception-request.ts::createReceptionRequest`.
   *
   * Throws on Redis/Bot-API failure; the channel's catch logs the
   * error and falls through to handing the raw text to the agent.
   */
  readonly createReceptionRequest: (
    caller: Resident,
    input: CreateReceptionRequestInput,
  ) => Promise<CreateReceptionRequestResult>;
  /**
   * v2.1 Slice 4 (#89): channel-side handle for the lib-level
   * `acceptReceptionRequest`. The channel calls this directly when a
   * registered resident taps `[Ich kann helfen]` on the group card so
   * the status flip + volunteer write land BEFORE the agent runs — no
   * double-accept race even if the agent fails or stalls on the
   * downstream DM acks. Implemented in the factory as a thin re-export
   * of `lib/reception-request.ts::acceptReceptionRequest`.
   *
   * Throws when the request is missing, already matched/expired, on a
   * different street, or any Redis hiccup. The channel's catch falls
   * back to the legacy synthesized prompt so the agent can run the v2
   * 5-step procedure (its existing behaviour).
   */
  readonly acceptReceptionRequest: (
    caller: Resident,
    input: AcceptReceptionRequestInput,
  ) => Promise<AcceptReceptionRequestResult>;
  /**
   * v2.1 Slice 4 (#89): rewrite the neutral group card body to its
   * accepted-state string ("✅ angenommen von <volunteer-name>") and
   * strip the inline keyboard so the `[Ich kann helfen]` button can't
   * be tapped twice. Implemented in the factory via the lib-level
   * `editGroupCard` primitive (which does both Bot API edits in
   * sequence: `editMessageText` → `editMessageReplyMarkup`).
   *
   * Throwing is logged at the call site but does NOT block the agent
   * from running — `acceptReceptionRequest` already flipped the
   * canonical state (status: matched) so a card-edit retry can be a
   * follow-up; the agent's DMs land regardless.
   */
  readonly editGroupCard: (
    chatId: number,
    messageId: number,
    text: string,
  ) => Promise<void>;
  /**
   * v2.1 #96 Part A: send a deterministic Bot-API DM to `chatId` (which
   * for Telegram 1:1 chats equals the recipient's user id). Used by the
   * volunteer-accept path so the two DMs (operational handoff to the
   * volunteer + named confirmation to the requester with a `text_mention`
   * entity over the volunteer's name) never go through the agent.
   *
   * The agent text-leak this replaces is documented in #96: even with
   * Slice 5's (#90) tool surface removed, the model was free-form-emitting
   * card-shaped text to the GROUP under the v2 procedural prompt — a
   * privacy leak in textual form. Channel-side deterministic DMs close
   * the loop structurally: there is no model output to leak now.
   *
   * Throws on Bot-API failure; the call site logs the error but does NOT
   * block the second DM (one landing is more useful than neither). The
   * volunteer's tap already succeeded in `acceptReceptionRequest` — the
   * canonical state is correct regardless of DM delivery.
   */
  readonly sendDirectMessage: (
    chatId: number,
    text: string,
    entities?: ReadonlyArray<TelegramMessageEntity>,
    replyMarkup?: InlineKeyboardMarkup,
  ) => Promise<void>;
  /**
   * v2.1 #97: channel-side handle for the lib-level `registerResident`.
   * Wired by the factory to `lib/registration.ts::registerResident`. The
   * channel calls this directly (no agent invocation) when a DM matches
   * `/register …` or the free-text registration shape — so the agent
   * never sees a registration-shaped turn and cannot fire the welcome
   * wall + Flow 2 misfire observed in the live trace (issue #97 body).
   *
   * Throws on Redis I/O failure; the channel's catch logs the error and
   * falls back to handing the raw text to the agent (the v2 behaviour).
   */
  readonly registerResident: (
    input: RegisterResidentInput,
  ) => Promise<RegisterResidentResult>;
  /**
   * v2.1 #99: attribute the inbound shape onto the active OpenTelemetry
   * span so Vercel's Agent Runs dashboard can populate the Trigger
   * column on every Telegram-driven `ash.turn`. Called BEFORE
   * `sendToAsh` at every call site the channel still hands to the
   * agent (text DMs, group messages, photos, `/receive` fallthrough,
   * `confirm_pickup` callbacks). The volunteer-accept callback path
   * does NOT call `sendToAsh` after #89/#96 — so it does NOT need
   * attribution either.
   *
   * Optional — when omitted, the orchestrator skips attribution silently
   * so tests can opt in by passing a spy and the spike webhook can run
   * without pulling in OpenTelemetry. The factory wires a real impl
   * via `setTelegramTriggerAttribute` from `trigger-attribute.ts`
   * which uses `trace.getActiveSpan()?.setAttribute("trigger", …)` when
   * `@opentelemetry/api` is loadable; if not, a no-op shim.
   *
   * Layered on top of the framework-canonical `kindHint: "telegram"`
   * (set on the channel definition itself) so the dashboard's channel
   * chip reads `telegram` while downstream filters can still tell
   * text DMs apart from button taps and photo uploads.
   */
  readonly setTriggerAttribute?: (trigger: TelegramTriggerKind) => void;
}

/**
 * The post-routing inbound shapes the channel distinguishes for the
 * Trigger column on Vercel's Agent Runs view. Values describe what the
 * channel handed to the agent — not the raw Telegram payload — because
 * v2.1's channel-deterministic routes intercept many inbounds (Flow 2
 * entries, registration, volunteer-accept) before they reach the agent.
 * Only the surfaces that still call `sendToAsh` get attribution.
 *
 *   - `telegram.text-dm`               — free-text DM that fell through
 *                                        the Slice 1 classifier (caller
 *                                        unregistered, classifier outage,
 *                                        or non-Flow-2 verdict).
 *   - `telegram.group`                 — group text (no Flow 2 in groups).
 *   - `telegram.photo`                 — any photo turn that reaches the
 *                                        agent: group photos (Flow 1 /
 *                                        `parse_label`) and DM photo
 *                                        recovery fallthrough.
 *   - `telegram.slash-receive`         — `/receive` slash command that
 *                                        fell through to the agent
 *                                        (typically unregistered caller).
 *   - `telegram.callback-confirm-pickup` — confirm_pickup button tap.
 *   - `telegram.callback`              — other callback actions that
 *                                        still reach the agent (stale
 *                                        `accept_reception_request`,
 *                                        `decline_reception_request`,
 *                                        `remind_later`, unknown).
 */
export type TelegramTriggerKind =
  | "telegram.text-dm"
  | "telegram.group"
  | "telegram.photo"
  | "telegram.slash-receive"
  | "telegram.callback-confirm-pickup"
  | "telegram.callback";

/**
 * v2.1 #100: Flow 2 entry routes return this discriminated union so the
 * orchestrator can decide whether to skip the agent entirely (channel
 * already sent the deterministic DM) or fall through to `sendToAsh`
 * (the route couldn't handle the inbound — e.g. unregistered caller on
 * the classifier/`/receive` paths). Same shape pattern as
 * `handleAcceptReceptionGroup` returning `Response` directly.
 *
 *   - `kind: "handled"` → the route already sent the user-facing DM via
 *     `sendDirectMessage`. The orchestrator returns 204 immediately.
 *     `sendToAsh` is NEVER called on this branch. This closes the
 *     #100-class agent text-leak structurally: the model has no output
 *     channel on a successful Flow 2 entry path, so it cannot fire a
 *     welcome wall, duplicate the registration confirmation, or repeat
 *     the ack.
 *   - `kind: "fallthrough"` → hand `toAgent` to `sendToAsh` as the user
 *     message. Used when the route couldn't make a deterministic
 *     decision (unregistered caller on the classifier path, classifier
 *     low/medium confidence, etc.). The agent's existing instructions
 *     handle these — typically by asking the user to `/register` first.
 */
export type Flow2RouteResult =
  | { readonly kind: "handled" }
  | { readonly kind: "fallthrough"; readonly toAgent: string };

/**
 * Subset of the `classify_dm_intent` tool output the orchestrator
 * consumes. Defined as a structural type so process-update.ts stays
 * decoupled from the tool implementation (factory wires the real
 * tool's `execute` into the dep).
 *
 * @see agent/tools/classify_dm_intent.ts
 */
export interface Flow2ClassificationResult {
  readonly isFlow2: boolean;
  readonly absenceSignal: boolean;
  readonly carrier?: PackageCarrier;
  readonly expectedDate?: string;
  readonly expectedWindowStartAt?: number;
  readonly expectedWindowEndAt?: number;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

/**
 * Subset of the `classify_group_message` tool output the orchestrator
 * consumes. Defined here so process-update.ts stays decoupled from
 * the tool implementation; the factory wires the real tool's
 * `execute` into the dep.
 *
 * @see agent/tools/classify_group_message.ts
 */
export interface ClassifyGroupMessageRecipient {
  readonly name: string;
  readonly houseNumber?: string;
}
export interface ClassifyGroupMessageResult {
  readonly isPackageRegistration: boolean;
  readonly recipients: ReadonlyArray<ClassifyGroupMessageRecipient>;
  readonly carrier?: PackageCarrier;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

/**
 * v2.1 #106 Slice 1: group text routes return this discriminated union
 * so the orchestrator can decide whether to skip the agent entirely
 * (channel already posted the deterministic group ack + DMs) or fall
 * through to `sendToAsh` (the route couldn't disambiguate — typically
 * a low-confidence classifier verdict or an unregistered recipient
 * that Slice 3 / #109 will handle with a clarification synthetic).
 *
 * Same shape as `Flow2RouteResult` for symmetry.
 *
 *   - `kind: "handled"` → channel already posted the group ack + DMs
 *     (or stayed silent on a non-registration verdict / Redis hiccup).
 *     The orchestrator returns 204 immediately. `sendToAsh` is NEVER
 *     called on this branch.
 *   - `kind: "silent"`  → channel intentionally did nothing (classifier
 *     said this isn't a registration, or the registration was
 *     low-confidence and we'd rather miss than misroute). Same 204
 *     outcome as `"handled"` — the discriminator exists so logs can
 *     distinguish "we did the work" from "we deliberately abstained".
 *   - `kind: "fallthrough"` → hand `toAgent` to `sendToAsh` as the
 *     user message. Used when the classifier returned medium/low
 *     confidence on a plausible registration — Slice 3 (#109) will
 *     hand the agent a clarification synthetic here; Slice 1 just
 *     stays silent (no agent involvement) until that lands.
 */
export type Flow1RouteResult =
  | { readonly kind: "handled" }
  | { readonly kind: "silent" }
  | { readonly kind: "fallthrough"; readonly toAgent: string };

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
      // Legacy DM-3 button callback. The agent tool that used to back
      // this branch was hard-deleted by v2.1 Slice 5 (#90); the channel
      // never wires this callback anymore. Apologise briefly in the
      // tapper's language if it ever arrives via a stale message.
      return "[button-tap] An old 'I can help' button was tapped, but the channel-side flow has changed. Apologise briefly in the tapper's language and ask them to wait for the next group card.";
    case "accept_reception_group":
      // Reached only when `handleAcceptReceptionGroup`'s precondition
      // fails (parsed.id missing or cb.fromUserId null). v2.1 Bug 3
      // (#95) removed the in-handler fallback to this synthetic — the
      // deterministic accept path now fails loud via toast + no agent
      // invocation, so this case is the malformed-callback safety net
      // only. The backing tool was hard-deleted by Slice 5 (#90), so
      // the agent cannot recover by re-running the procedure.
      return parsed.id
        ? `[button-tap] A volunteer tap on group-card reception request ${parsed.id} arrived without an identifiable tapper. Apologise briefly in the tapper's language and ask them to try again. Do NOT call any tools.`
        : "[button-tap] I tapped accept-reception-group but no request id was attached — ignore.";
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

  // Flow 2 v2 (#68) group-card accept: only registered residents can
  // claim. Unregistered tappers get a German toast and the button
  // stays live so they can `/register` and retry. Defensively treats a
  // thrown lookup as "unregistered" — a Redis hiccup must not admit a
  // tapper who'd otherwise be rejected.
  //
  // v2.1 Bug 3 (#95): if the gate admits, the entire accept flow runs
  // through `handleAcceptReceptionGroup` which OWNS its own ack +
  // keyboard-strip lifecycle. The handler fails LOUD on any
  // deterministic-path error (toast in volunteer's language, leave
  // keyboard intact for re-tap, do NOT invoke the agent). Falling back
  // to the agent's legacy procedure reproduces the v2 regression at
  // #85 — Slice 5 (#90) hard-deleted the tools, but even an apology
  // synthetic burns an Ash turn we don't need.
  if (
    parsed.action === "accept_reception_group" &&
    parsed.id &&
    cb.fromUserId !== null
  ) {
    const registered = await deps
      .isRegisteredResident(cb.fromUserId)
      .catch(() => false);
    if (!registered) {
      await deps
        .answerCallback(
          cb.callbackId,
          "Bitte zuerst /register, um Paketen zu helfen.",
        )
        .catch(() => undefined);
      // Keyboard intact — the user can re-tap after /register.
      return new Response(null, { status: 204 });
    }
    return handleAcceptReceptionGroup(cb, parsed.id, deps);
  }

  // Default callback path (confirm_pickup, decline_reception_request,
  // remind_later, and any unknown action). Ack + strip the keyboard
  // eagerly so the user sees the action register, then hand the agent
  // a synthetic. If either pre-step fails, we still try to drive the
  // agent — the worst case is a stale keyboard or lingering spinner.
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

  // v2.1 #99: attribute the post-routing inbound shape onto the active
  // OTel span so Agent Runs shows what fired this turn. `confirm_pickup`
  // is the only callback the channel still hands to the agent on the
  // happy path; the rest (legacy `accept_reception_request`,
  // `decline_reception_request`, `remind_later`, unknown actions) get
  // the generic `telegram.callback` bucket so we can still distinguish
  // them from text/photo/slash triggers in dashboard filters.
  const callbackTrigger: TelegramTriggerKind =
    parsed.action === "confirm_pickup"
      ? "telegram.callback-confirm-pickup"
      : "telegram.callback";
  deps.setTriggerAttribute?.(callbackTrigger);

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
 * Group photo path entry point — DM photos route through `routeDmPhoto`
 * (which returns a `Flow2RouteResult`) so the orchestrator can skip the
 * agent when the channel already sent the deterministic DM. This helper
 * is only consulted for group photos (Flow 1).
 */
async function buildSyntheticGroupPhotoMessage(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
): Promise<string> {
  const fileId = inbound.photoFileId;
  if (fileId === null) {
    // Defensive — caller already narrowed.
    return inbound.text.length > 0 ? inbound.text : "(photo, no caption)";
  }
  return buildGroupPhotoSynthetic(inbound, fileId, deps);
}

/**
 * #79: hand the agent a `[photo received] file_url=… caption='…'`
 * synthetic so it can invoke `parse_label({ imageUrl, caption })`
 * itself. The conversational model never sees the photo bytes — only
 * the structured tool return value — but the vision call's token spend
 * now lands inside `ash.turn` instead of as a sidecar in the channel
 * handler.
 *
 * Caption quoting: single-quotes inside the caption are doubled
 * (`'` → `''`) so the wrapping `'…'` parses as one field. The agent's
 * Flow 1 photo stanza tells it to read `file_url=…` and pass that URL
 * straight into `parse_label`.
 *
 * On `getFileUrl` failure the channel falls back to a `[photo
 * received, file url could not be resolved] caption: …` shim — there's
 * no URL to hand the vision tool, so the agent's job is to ask the
 * holder (in their language) to type the recipient.
 */
async function buildGroupPhotoSynthetic(
  inbound: TelegramInboundMessage,
  fileId: string,
  deps: ProcessUpdateDeps,
): Promise<string> {
  const captionText = inbound.text.length > 0 ? inbound.text : undefined;
  const captionForAgent = captionText ?? "(no caption)";

  let imageUrl: string;
  try {
    imageUrl = await deps.getFileUrl(fileId);
  } catch (err) {
    console.error(
      "[parse_photo] getFileUrl failed (group) for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    return buildPhotoUrlFailureMessage(captionForAgent);
  }

  const quotedCaption = captionForAgent.replace(/'/g, "''");
  return `[photo received] file_url=${imageUrl} caption='${quotedCaption}'`;
}

/**
 * v2.1 Slice 3 (#88) + #100: DM photo route into Flow 2 v2.
 *
 * Same shape as `routeDmTextThroughClassifier` and `routeReceiveCommand`,
 * but with `parse_tracking_page`'s vision output standing in for the
 * classifier's text verdict. The channel-side decision rule:
 *
 *   - `confidence === "high"` AND `absenceSignal` in {`true`, `undefined`}
 *     (the latter = implicit absence — uploading a tracking page in DM
 *     IS itself a Flow 2 trigger per v2 design) AND a registered caller
 *     AND `createReceptionRequest` succeeds → send a deterministic
 *     localised ack DM via `sendDirectMessage` and return
 *     `{ kind: "handled" }` so the orchestrator skips `sendToAsh`.
 *   - Any other outcome (low/medium confidence, explicit
 *     `absenceSignal: false`, vision tool null/throw, getFileUrl throw,
 *     unregistered caller, Redis hiccup on `createReceptionRequest`) →
 *     send a deterministic localised recovery prompt DM directing the
 *     user at `/receive` (Slice 2 / #87) and `/register` if they're
 *     unregistered, and return `{ kind: "handled" }`. The agent never
 *     runs on the DM photo path — closing #100's text-leak surface
 *     structurally.
 *
 * Privacy invariant: the card-posting decision lives entirely in this
 * function. Even if the agent's reasoning is wrong, no group card lands
 * unless this function deterministically chose to route to Flow 2.
 *
 * Window endpoints from the vision tool are ISO 8601 strings; we convert
 * to Unix ms here before handing to `createReceptionRequest` (whose
 * input takes ms, matching the Slice 1 classifier path).
 */
async function routeDmPhoto(
  inbound: TelegramInboundMessage,
  fileId: string,
  deps: ProcessUpdateDeps,
): Promise<Flow2RouteResult> {
  const captionText = inbound.text.length > 0 ? inbound.text : undefined;
  const languageHint = inbound.fromLanguageCode ?? "de";

  let imageUrl: string;
  try {
    imageUrl = await deps.getFileUrl(fileId);
  } catch (err) {
    console.error(
      "[parse_photo] getFileUrl failed (DM) for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    return sendFlow2VlcDm(inbound, languageHint, deps);
  }

  let parsed: Awaited<ReturnType<ProcessUpdateDeps["parseTrackingPage"]>> = null;
  emitTrace("vision", "start", { tool: "parse_tracking_page" });
  try {
    parsed = await deps.parseTrackingPage({ imageUrl, caption: captionText });
    console.info(
      "[parse_tracking_page] ok for chatId",
      inbound.chatId,
      "result:",
      parsed,
    );
    emitTrace("vision", "end", {
      tool: "parse_tracking_page",
      confidence: parsed?.confidence ?? "null",
    });
  } catch (err) {
    console.error(
      "[parse_tracking_page] failed for chatId",
      inbound.chatId,
      "mediaType-via-fetch (sanitised) — error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("vision", "error", { tool: "parse_tracking_page" });
    parsed = null;
  }

  if (parsed === null) {
    emitTrace("flow2", "vlc", { reason: "vision-null" });
    return sendFlow2VlcDm(inbound, languageHint, deps);
  }

  const isHighConfidenceFlow2 =
    parsed.confidence === "high" &&
    (parsed.absenceSignal === true || parsed.absenceSignal === undefined);

  if (!isHighConfidenceFlow2 || inbound.fromUserId === null) {
    emitTrace("flow2", "vlc", { reason: "low-confidence" });
    return sendFlow2VlcDm(inbound, languageHint, deps);
  }

  const caller = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);
  if (!caller) {
    emitTrace("flow2", "vlc", { reason: "unregistered" });
    return sendFlow2VlcDm(inbound, languageHint, deps);
  }

  const callerLanguage = caller.language ?? languageHint;

  emitTrace("flow2", "create.start", { source: "photo" });
  try {
    await deps.createReceptionRequest(caller, {
      carrier: parsed.carrier,
      expectedWindowStartAt: parseIsoToUnixMs(parsed.expectedWindowStartAt),
      expectedWindowEndAt: parseIsoToUnixMs(parsed.expectedWindowEndAt),
    });
    emitTrace("flow2", "create.end", { source: "photo" });
  } catch (err) {
    console.error(
      "[create_reception_request] (photo path) failed for chatId",
      inbound.chatId,
      "userId",
      inbound.fromUserId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow2", "reject.redis-hiccup", { source: "photo" });
    return sendFlow2VlcDm(inbound, callerLanguage, deps);
  }

  return sendFlow2AckDm(inbound, callerLanguage, deps);
}

/**
 * #100: send the deterministic Flow 2 success ack DM via the channel's
 * `sendDirectMessage` dep and signal to the orchestrator that the agent
 * should NOT run. A send failure is logged but still returns "handled"
 * because the canonical state (ReceptionRequest written + group card
 * landed) is already correct — falling through to the agent would only
 * surface a free-form duplicate ack on a card that's already posted.
 */
async function sendFlow2AckDm(
  inbound: TelegramInboundMessage,
  language: string,
  deps: ProcessUpdateDeps,
): Promise<Flow2RouteResult> {
  const text = buildFlow2AckDm(language);
  try {
    emitTrace("dm", "start", { kind: "flow2-ack" });
    await deps.sendDirectMessage(inbound.chatId, text);
    emitTrace("dm", "end", { kind: "flow2-ack" });
  } catch (err) {
    console.error(
      "[flow-2-dm-ack] failed for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("dm", "error", { kind: "flow2-ack" });
  }
  return { kind: "handled" };
}

/**
 * #100: send the deterministic Flow 2 recovery prompt DM ("retry via
 * /receive, or /register first if you haven't"). Same fail-still-handled
 * contract as `sendFlow2AckDm` — we structurally avoid handing the
 * agent the DM photo turn even when the DM send fails, because the agent
 * has nothing useful to add (it'd just say the same thing in worse
 * shape, or fire a welcome wall).
 */
async function sendFlow2VlcDm(
  inbound: TelegramInboundMessage,
  language: string,
  deps: ProcessUpdateDeps,
): Promise<Flow2RouteResult> {
  const text = buildFlow2VisionLowConfidenceDm(language);
  try {
    emitTrace("dm", "start", { kind: "flow2-vlc" });
    await deps.sendDirectMessage(inbound.chatId, text);
    emitTrace("dm", "end", { kind: "flow2-vlc" });
  } catch (err) {
    console.error(
      "[flow-2-dm-vlc] failed for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("dm", "error", { kind: "flow2-vlc" });
  }
  return { kind: "handled" };
}

function parseIsoToUnixMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * v2.1 Slice 1 (#86) + #100: on every DM text inbound from a known
 * sender, call `classifyDmIntent` to decide whether this is a Flow 2 v2
 * trigger. If the classifier returns `confidence: "high"` AND the
 * sender is a registered resident, the channel deterministically:
 *
 *   1. Calls `createReceptionRequest(caller, fields)` (lib function)
 *      to write the request + post the neutral group card.
 *   2. Sends a deterministic localised ack DM via `sendDirectMessage`
 *      and returns `{ kind: "handled" }` so the orchestrator skips
 *      `sendToAsh` — closing #100's text-leak surface (welcome wall +
 *      duplicate registration confirmation + tripled ack observed on
 *      the live trace) structurally. The agent never runs on the
 *      success path.
 *
 * Every step is tolerant of failure: a classifier outage, an
 * unregistered caller, or a Redis/Bot-API hiccup on
 * `createReceptionRequest` all fall through to the v2 behaviour of
 * handing the raw text to the agent (`{ kind: "fallthrough" }`). The
 * card-posting decision is the only place a privacy-violating side
 * effect can land; if any upstream step fails, we'd rather miss the
 * routing than misroute.
 */
async function routeDmTextThroughClassifier(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
): Promise<Flow2RouteResult> {
  if (inbound.fromUserId === null) {
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  let classification: Flow2ClassificationResult;
  emitTrace("classifier", "start");
  try {
    classification = await deps.classifyDmIntent({
      text: inbound.text,
      languageHint: inbound.fromLanguageCode ?? undefined,
    });
    emitTrace("classifier", "end", {
      isFlow2: classification.isFlow2,
      confidence: classification.confidence,
    });
  } catch (err) {
    console.error(
      "[classify_dm_intent] failed for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("classifier", "error");
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  if (!classification.isFlow2 || classification.confidence !== "high") {
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  const caller = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);
  if (!caller) {
    // Unregistered users can't have a ReceptionRequest written for
    // them. Fall through and let the agent handle (it'll typically
    // ask them to /register first).
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  emitTrace("flow2", "create.start", { source: "classifier" });
  try {
    await deps.createReceptionRequest(caller, {
      carrier: classification.carrier,
      expectedDate: classification.expectedDate,
      expectedWindowStartAt: classification.expectedWindowStartAt,
      expectedWindowEndAt: classification.expectedWindowEndAt,
    });
    emitTrace("flow2", "create.end", { source: "classifier" });
  } catch (err) {
    console.error(
      "[create_reception_request] failed for chatId",
      inbound.chatId,
      "userId",
      inbound.fromUserId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow2", "reject.redis-hiccup", { source: "classifier" });
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  const language = caller.language ?? inbound.fromLanguageCode ?? "de";
  return sendFlow2AckDm(inbound, language, deps);
}

/**
 * v2.1 #106 Slice 1: route a group text message through the Flow 1
 * classifier. On a high-confidence verdict + a recipient that
 * resolves to a registered Resident, the channel deterministically:
 *
 *   1. Calls `registerPackage(holder, { recipientName, ... })` via
 *      the lib. The function writes the Package, links to any open
 *      Flow 2 request, and returns the resident-recipient summary.
 *   2. Posts ONE group ack + sends ONE recipient DM via
 *      `sendDirectMessage` (the dep is chat-id-agnostic — it sends
 *      to a group chat or a 1:1 chat identically; the `[Abgeholt]`
 *      keyboard rides along on both).
 *   3. Returns `{ kind: "handled" }` so the orchestrator skips
 *      `sendToAsh` — closing the agent text-leak surface the live
 *      trace 2026-05-22 produced (#105).
 *
 * Failure / disambiguation cases that this slice does NOT handle (Slice
 * 3 / #109 introduces the proper clarification synthetic):
 *
 *   - Classifier outage / both models error → stay silent. Logged so
 *     ops can see it; the group is not the right place to surface an
 *     internal hiccup, and the agent would just produce noise.
 *   - `isPackageRegistration === false` → stay silent. Off-topic chat,
 *     pickup confirmations, social posts.
 *   - `confidence !== "high"` → stay silent for now. Slice 3 will
 *     route this to a clarification synthetic.
 *   - 0 recipients on a high-conf positive → stay silent (defensive —
 *     the classifier prompt rules this out, but the schema permits it).
 *   - 2+ recipients → register only the registered-resident matches;
 *     post one combined group ack covering them. Unknown recipients in
 *     the same message stay silent (Slice 3 will handle).
 *   - Recipient resolves to known_telegram (not yet a Resident) → stay
 *     silent. Slice 3's clarification synthetic asks the holder for
 *     more info.
 *   - Recipient resolves to unknown → stay silent. Slice 3 will post
 *     the "kennt jemand X?" group question.
 *   - Unregistered holder (`registerPackage` throws with
 *     `REGISTER_PACKAGE_HOLDER_NOT_REGISTERED`) → send ONE best-effort
 *     DM to the holder pointing at `/register`. Stay silent in the
 *     group.
 *   - Any other `registerPackage` throw → stay silent (Redis hiccup,
 *     transient). Logged.
 */
async function routeGroupTextThroughClassifier(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
): Promise<Flow1RouteResult> {
  if (inbound.fromUserId === null) {
    // Anonymous group post (no `from` on the payload) — rare; can't
    // resolve the holder, so stay silent.
    return { kind: "silent" };
  }

  let classification: ClassifyGroupMessageResult;
  emitTrace("classifier", "start", { flow: "flow1" });
  try {
    classification = await deps.classifyGroupMessage({
      text: inbound.text,
      languageHint: inbound.fromLanguageCode ?? undefined,
    });
    emitTrace("classifier", "end", {
      flow: "flow1",
      isPackageRegistration: classification.isPackageRegistration,
      confidence: classification.confidence,
    });
  } catch (err) {
    console.error(
      "[classify_group_message] failed for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("classifier", "error", { flow: "flow1" });
    // Stay silent. Slice 3 (#109) introduces a clarification synthetic
    // for the agent; until then, a classifier outage means we miss the
    // routing — better than emitting a wall of free-form agent text.
    return { kind: "silent" };
  }

  if (
    !classification.isPackageRegistration ||
    classification.confidence !== "high" ||
    classification.recipients.length === 0
  ) {
    return { kind: "silent" };
  }

  // Resolve the holder (the user who posted in the group). They must
  // be a registered Resident — `registerPackage` throws otherwise.
  const holder = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);

  // For each named recipient: register a package + (when the recipient
  // resolves to a registered Resident) post ONE group ack + ONE DM.
  // Unknown / known_telegram recipients in the same message stay
  // silent (Slice 3 covers those).
  let anyRegistered = false;
  for (const namedRecipient of classification.recipients) {
    const recipientHouseNumber =
      namedRecipient.houseNumber ?? holder?.houseNumber ?? "";
    if (recipientHouseNumber === "") {
      // Defensive: no recipient house number AND no holder house
      // number to default to. Skip — the schema admits this only when
      // both are absent, which is a Slice-3 disambiguation case.
      continue;
    }

    let registered: RegisterPackageResult;
    emitTrace("flow1", "register.start", {
      recipient: namedRecipient.name,
    });
    try {
      registered = await deps.registerPackage(holder, {
        recipientName: namedRecipient.name,
        recipientHouseNumber,
        carrier: classification.carrier,
      });
      emitTrace("flow1", "register.end", {
        recipient: namedRecipient.name,
        resolution: registered.recipientResolution.kind,
      });
    } catch (err) {
      const errorCode =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: string }).code
          : undefined;
      if (errorCode === REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE) {
        // Best-effort DM nudge to the holder. The group stays silent.
        const language =
          inbound.fromLanguageCode &&
          normaliseLanguageCode(inbound.fromLanguageCode);
        const nudge = buildHolderNotRegisteredNudge(language);
        try {
          await deps.sendDirectMessage(inbound.fromUserId, nudge);
        } catch (dmErr) {
          // Bot-initiated DMs to users who haven't started a private
          // chat are forbidden by the Bot API. Log + move on.
          console.error(
            "[flow1] holder-not-registered nudge DM failed for userId",
            inbound.fromUserId,
            "error:",
            dmErr instanceof Error ? dmErr.message : dmErr,
          );
        }
        // The holder isn't a Resident — no further registrations are
        // possible on this turn. Break the loop.
        emitTrace("flow1", "reject.holder-not-registered");
        return { kind: "handled" };
      }
      console.error(
        "[register_package] failed for holder",
        inbound.fromUserId,
        "recipient",
        namedRecipient.name,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
      emitTrace("flow1", "register.error");
      // Skip this recipient; try the next one. Better partial outcome
      // than abandoning the whole turn.
      continue;
    }

    if (registered.recipientResolution.kind !== "resident") {
      // Slice 1: only the "registered resident" branch posts. Other
      // branches (known_telegram, unknown) stay silent — Slice 3
      // introduces the clarification synthetic for those.
      emitTrace("flow1", "silent", {
        reason: registered.recipientResolution.kind,
      });
      continue;
    }

    const groupAckText = buildGroupAckText({
      holder: registered.holder,
      recipient: registered.recipientResolution.resident,
    });
    const recipientDmText = buildRecipientDmText({
      holder: registered.holder,
      recipient: registered.recipientResolution.resident,
    });
    const keyboard = buildPickupKeyboard(registered.package.id);

    // Group ack. `sendDirectMessage` is chat-id-agnostic — sending to
    // `inbound.chatId` posts to the group when the inbound came from
    // a group.
    try {
      emitTrace("dm", "start", { kind: "flow1-group-ack" });
      await deps.sendDirectMessage(
        inbound.chatId,
        groupAckText,
        undefined,
        keyboard,
      );
      emitTrace("dm", "end", { kind: "flow1-group-ack" });
    } catch (err) {
      console.error(
        "[flow1] group ack post failed for chatId",
        inbound.chatId,
        "package",
        registered.package.id,
        "error:",
        err instanceof Error ? err.message : err,
      );
      emitTrace("dm", "error", { kind: "flow1-group-ack" });
    }

    // Recipient DM. Chat id for a 1:1 Telegram chat equals the
    // recipient's user id — same mapping the volunteer-accept path
    // relies on.
    const recipientChatId = Number(registered.recipientResolution.resident.id);
    if (Number.isFinite(recipientChatId)) {
      try {
        emitTrace("dm", "start", { kind: "flow1-recipient" });
        await deps.sendDirectMessage(
          recipientChatId,
          recipientDmText,
          undefined,
          keyboard,
        );
        emitTrace("dm", "end", { kind: "flow1-recipient" });
      } catch (err) {
        console.error(
          "[flow1] recipient DM failed for resident id",
          registered.recipientResolution.resident.id,
          "package",
          registered.package.id,
          "error:",
          err instanceof Error ? err.message : err,
        );
        emitTrace("dm", "error", { kind: "flow1-recipient" });
      }
    } else {
      console.error(
        "[flow1] recipient.id is not a finite number — skipping DM",
        { recipientId: registered.recipientResolution.resident.id },
      );
    }

    anyRegistered = true;
  }

  return { kind: anyRegistered ? "handled" : "silent" };
}

/**
 * v2.1 Slice 2 (#87): `/receive` slash-command route. Deterministic,
 * classifier-bypassing entry into Flow 2. The user explicitly invoked
 * the flow by typing `/receive`, so we treat it as high-confidence by
 * construction — no classifier call, no confidence threshold, no
 * fallthrough to the agent's intent reasoning.
 *
 * Parsing is a small regex extractor (`lib/slash-command.ts`): carrier
 * from {DHL, Hermes, DPD, GLS, UPS, Amazon}, date word from {heute,
 * morgen, übermorgen, today, tomorrow}, hour window like `14-16`. A
 * bare `/receive` produces an empty input; `createReceptionRequest`
 * still writes the request and the group card renders as the generic
 * "📦 Paket erwartet. Kann jemand annehmen?" — exactly the sparse-card
 * shape #87 asks for.
 *
 * Same failure-tolerance as the classifier path: unregistered caller or
 * a `createReceptionRequest` throw both fall through to handing the raw
 * `/receive ...` text to the agent. The agent will then prompt the user
 * to `/register` (unregistered case) or apologise and ask them to retry
 * (Redis hiccup) — neither leaks privacy because the card-posting side
 * effect never landed.
 */
async function routeReceiveCommand(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
): Promise<Flow2RouteResult> {
  if (inbound.fromUserId === null) {
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  const caller = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);
  if (!caller) {
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  const parsed = parseReceiveCommand(inbound.text);

  emitTrace("flow2", "create.start", { source: "slash-receive" });
  try {
    await deps.createReceptionRequest(caller, {
      carrier: parsed.carrier,
      expectedDate: parsed.expectedDate,
      expectedWindowStartAt: parsed.expectedWindowStartAt,
      expectedWindowEndAt: parsed.expectedWindowEndAt,
    });
    emitTrace("flow2", "create.end", { source: "slash-receive" });
  } catch (err) {
    console.error(
      "[/receive] createReceptionRequest failed for chatId",
      inbound.chatId,
      "userId",
      inbound.fromUserId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow2", "reject.redis-hiccup", { source: "slash-receive" });
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  const language = caller.language ?? inbound.fromLanguageCode ?? "de";
  return sendFlow2AckDm(inbound, language, deps);
}

/**
 * v2.1 Slice 4 (#89) + Bug 3 (#95) + #96 Part A/B: channel-deterministic
 * volunteer-accept handler. Owns the FULL lifecycle of an
 * `accept_reception_group:<id>` tap from a registered resident — including
 * the two outbound DMs that confirm the handoff. The agent is NEVER
 * invoked from this path.
 *
 * Sequence:
 *
 *   1. Resolve the volunteer's full `Resident` record via
 *      `getRegisteredResident`. The earlier `isRegisteredResident`
 *      check guarantees this returns non-null on the happy path; a
 *      null return here means a race between the gate and this lookup
 *      OR a Redis hiccup. Fail loud: toast the volunteer + leave the
 *      keyboard intact for a re-tap.
 *   2. Call `acceptReceptionRequest(volunteer, { requestId })` via the
 *      lib. The lib flips status to `matched`, sets
 *      `volunteerResidentId`, and returns pre-resolved
 *      `requester`/`volunteer` summaries plus the original
 *      `groupCardChatId` + `groupCardMessageId`. `availability` is
 *      omitted — the tap alone is the "I can help" signal. On throw:
 *      branch on the error's `.code` (#96 Part B) — a
 *      `ACCEPT_DIFFERENT_STREET` code strips the keyboard and shows
 *      the dedicated cross-street toast (the constraint is permanent
 *      so retrying via the same button can never succeed); any other
 *      class shows the generic retry toast and leaves the keyboard
 *      live. Either way the agent is NOT invoked.
 *   3. Ack the callback silently (clears the spinner) + strip the
 *      inline keyboard so the `[Ich kann helfen]` button can't be
 *      tapped twice. These run AFTER step 2 succeeds — so on a
 *      recoverable failure the keyboard stays live and the user can
 *      re-tap once the underlying hiccup clears.
 *   4. Edit the group card to `✅ angenommen von <volunteer.name>`.
 *      A failure here is logged but does NOT block the DMs: the
 *      canonical state (status: matched) already landed in step 2,
 *      so the card is just a display artefact.
 *   5. Deterministically send TWO DMs (#96 Part A):
 *        - to the volunteer (private chat = `volunteer.platformId`)
 *          with the operational handoff in the volunteer's language;
 *        - to the requester (private chat = `requester.id`) with the
 *          named confirmation + a `text_mention` MessageEntity over
 *          the volunteer's name so the requester sees a tap-to-DM
 *          ping. Each DM is rendered from a localised template per
 *          `lib/telegram-channel/volunteer-accept-dms.ts`. Either DM
 *          throwing is logged but does NOT bail the other — one DM
 *          landing is still useful (the canonical state is correct
 *          regardless).
 *
 * Privacy invariant (PRD §9): the only public surface in this flow is
 * the in-place card edit. Both DMs in step 5 stay private. The agent
 * never runs here, so it cannot mis-route output to the group.
 *
 * **v2.1 #96 Part A — kill agent text-leak.** Before this change the
 * channel handed the agent a `[VOLUNTEER_ACCEPTED]` synthetic and let
 * the model compose the two DMs. The live trace (#96 thread) showed
 * the model free-form-emitting card-shaped text to the GROUP — even
 * after Slice 5 (#90) had removed the tools, the v2 procedural prompt
 * persisted in the model's text output ("Ich kann das Bild nicht
 * direkt lesen…", "Ich konnte noch keine registrierten Nachbarn
 * finden…", etc.). The privacy leak the v2 regression at #85 created
 * survived in textual form. Deterministic DMs structurally close it:
 * the model has no output channel on this path.
 *
 * **v2.1 #96 Part B — dedicated cross-street toast.** The legacy
 * behaviour rendered the generic retry toast on a street-mismatch
 * throw AND left the keyboard live. The volunteer would re-tap (the
 * toast said "try again" and the button was still there) but the
 * underlying constraint — different `Resident.street` from the
 * request's `streetId` — is permanent. The lib now throws an
 * `AcceptReceptionRequestError` with `code: ACCEPT_DIFFERENT_STREET`
 * so the handler can render the dedicated toast and strip the
 * keyboard — no more re-tap loops.
 */
async function handleAcceptReceptionGroup(
  cb: TelegramInboundCallback,
  requestId: string,
  deps: ProcessUpdateDeps,
): Promise<Response> {
  const volunteerUserId = cb.fromUserId!;

  let volunteer: Resident | null;
  try {
    volunteer = await deps.getRegisteredResident(volunteerUserId);
  } catch (err) {
    console.error(
      "[accept_reception_group] getRegisteredResident threw for userId",
      volunteerUserId,
      "after passing the isRegisteredResident gate — failing loud (no agent fallback)",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    await deps
      .answerCallback(
        cb.callbackId,
        retryToastForLanguage(cb.fromLanguageCode),
      )
      .catch(() => undefined);
    return new Response(null, { status: 204 });
  }
  if (!volunteer) {
    // Race between the `isRegisteredResident` gate and this lookup —
    // fail loud per #95. Keyboard stays live so the volunteer can
    // re-tap once the gate/lookup race clears.
    console.error(
      "[accept_reception_group] getRegisteredResident returned null for userId",
      volunteerUserId,
      "after passing the isRegisteredResident gate (race or Redis hiccup) — failing loud (no agent fallback)",
    );
    await deps
      .answerCallback(
        cb.callbackId,
        retryToastForLanguage(cb.fromLanguageCode),
      )
      .catch(() => undefined);
    return new Response(null, { status: 204 });
  }

  let accepted: AcceptReceptionRequestResult;
  emitTrace("flow2", "accept.start");
  try {
    accepted = await deps.acceptReceptionRequest(volunteer, { requestId });
    emitTrace("flow2", "accept.end");
  } catch (err) {
    console.error(
      "[accept_reception_group] acceptReceptionRequest failed for userId",
      volunteerUserId,
      "requestId",
      requestId,
      "— failing loud (no agent fallback)",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    const errorCode =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    const language = volunteer.language ?? cb.fromLanguageCode;
    if (errorCode === ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE) {
      emitTrace("flow2", "reject.self");
      // #101: rejection is permanent *for this tapper only* — the lib
      // re-checks `requesterResidentId === caller.id` on every tap, so
      // a re-tap by the requester just produces the same toast again.
      // The button MUST stay live so other neighbours on the same street
      // can still claim the card. (Contrast with the cross-street branch
      // below, where the keyboard IS stripped because the constraint is
      // street-wide — no resident on the volunteer's street will ever be
      // able to claim that card.)
      await deps
        .answerCallback(
          cb.callbackId,
          selfAcceptToastForLanguage(language),
        )
        .catch(() => undefined);
      return new Response(null, { status: 204 });
    }
    if (errorCode === ACCEPT_DIFFERENT_STREET_ERROR_CODE) {
      emitTrace("flow2", "reject.cross-street");
      // #96 Part B: permanent rejection. Strip the keyboard so the
      // volunteer doesn't keep re-tapping (the toast already explains
      // why the tap can't succeed) and toast in their language.
      await deps
        .answerCallback(
          cb.callbackId,
          crossStreetToastForLanguage(language),
        )
        .catch(() => undefined);
      await deps
        .stripKeyboard(cb.chatId, cb.messageId)
        .catch(() => undefined);
      return new Response(null, { status: 204 });
    }
    // Recoverable failure class: generic retry toast + keyboard stays
    // live so the volunteer can re-tap once the underlying hiccup
    // clears. Same #95 contract as before for every non-street class.
    emitTrace("flow2", "reject.redis-hiccup", { stage: "accept" });
    await deps
      .answerCallback(cb.callbackId, retryToastForLanguage(language))
      .catch(() => undefined);
    return new Response(null, { status: 204 });
  }

  // Happy path: state flip succeeded. Now ack + strip + render the
  // `✅ angenommen` card. Doing the ack/strip AFTER the lib call (vs
  // before it in the v2 shape) is what makes the failure path above
  // leave the keyboard intact for a re-tap on recoverable errors.
  await deps.answerCallback(cb.callbackId).catch(() => undefined);
  await deps.stripKeyboard(cb.chatId, cb.messageId).catch(() => undefined);

  if (
    accepted.groupCardChatId !== null &&
    accepted.groupCardMessageId !== null
  ) {
    const cardText = `✅ angenommen von ${accepted.volunteer.name}`;
    try {
      await deps.editGroupCard(
        accepted.groupCardChatId,
        accepted.groupCardMessageId,
        cardText,
      );
    } catch (err) {
      // Edit failure is recoverable — state flip already landed, so we
      // still send the two deterministic DMs; the stale card can be
      // reconciled separately.
      console.error(
        "[accept_reception_group] editGroupCard failed for chatId",
        accepted.groupCardChatId,
        "messageId",
        accepted.groupCardMessageId,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
    }
  }

  // #96 Part A: emit BOTH DMs deterministically. No sendToAsh call —
  // the agent does not run on this path. Either DM throwing is logged
  // but the other still goes out.
  const volunteerDmText = buildVolunteerAcceptDmText(accepted);
  const volunteerChatId = Number(accepted.volunteer.platformId);
  if (Number.isFinite(volunteerChatId)) {
    try {
      emitTrace("dm", "start", { kind: "volunteer-accept" });
      await deps.sendDirectMessage(volunteerChatId, volunteerDmText);
      emitTrace("dm", "end", { kind: "volunteer-accept" });
    } catch (err) {
      console.error(
        "[accept_reception_group] volunteer DM failed for platformId",
        accepted.volunteer.platformId,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
    }
  } else {
    console.error(
      "[accept_reception_group] volunteer.platformId is not a finite number — skipping volunteer DM",
      { platformId: accepted.volunteer.platformId },
    );
  }

  const requesterDm = buildRequesterAcceptDm(accepted);
  const requesterChatId = Number(accepted.requester.id);
  if (Number.isFinite(requesterChatId)) {
    try {
      emitTrace("dm", "start", { kind: "requester-accept" });
      await deps.sendDirectMessage(
        requesterChatId,
        requesterDm.text,
        requesterDm.entities,
      );
      emitTrace("dm", "end", { kind: "requester-accept" });
    } catch (err) {
      console.error(
        "[accept_reception_group] requester DM failed for resident id",
        accepted.requester.id,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
    }
  } else {
    console.error(
      "[accept_reception_group] requester.id is not a finite number — skipping requester DM",
      { requesterId: accepted.requester.id },
    );
  }

  return new Response(null, { status: 204 });
}

/**
 * v2.1 Bug 3 (#95): localized retry toasts for the volunteer-accept
 * failure path. The toast text is the only feedback the volunteer
 * sees when the channel-deterministic accept aborts — picking the
 * right language matters. Fallback chain: a normalised non-null
 * input → German → German.
 *
 * The four covered languages mirror `FLOW_2_ACK_DMS` in `flow-2-dms.ts`
 * and the toast/template tables in `volunteer-accept-dms.ts` — keeping
 * the sets in lockstep means a future fifth language only needs to be
 * added once per file.
 *
 * Telegram's callback `answerCallbackQuery` toast is capped at 200
 * bytes (with `show_alert=false` it's even shorter on-screen) so each
 * string here is a single short sentence.
 */
const ACCEPT_RETRY_TOASTS: Readonly<Record<string, string>> = {
  de: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
  en: "Something went wrong. Please try again.",
  es: "Algo salió mal. Por favor inténtalo de nuevo.",
  tr: "Bir şeyler ters gitti. Lütfen tekrar deneyin.",
};

function retryToastForLanguage(raw: string | null | undefined): string {
  const normalised = normaliseLanguageCode(raw);
  if (normalised && ACCEPT_RETRY_TOASTS[normalised]) {
    return ACCEPT_RETRY_TOASTS[normalised]!;
  }
  return ACCEPT_RETRY_TOASTS["de"]!;
}

/**
 * Generic Flow-1 fallback synthetic for group photos when `getFileUrl`
 * throws — there's no URL to hand `parse_label`, so the agent's only
 * contribution on this branch is to ask the holder (in their language)
 * to type the recipient's name + house number. The synthetic stays in
 * English (the user's language is resolved off `Resident.language` at
 * agent runtime). Group photo path only — DM photos are channel-
 * deterministic (#100), no agent invocation.
 */
function buildPhotoUrlFailureMessage(captionForAgent: string): string {
  return [
    "[photo received, file url could not be resolved]",
    `caption: ${captionForAgent}`,
    "Please ask the holder (in their language) to type the recipient's name and house number so the package can be registered.",
  ].join(" ");
}

/**
 * v2.1 #97: channel-deterministic registration handler. Same shape as
 * `handleAcceptReceptionGroup` — owns the FULL lifecycle of a
 * registration inbound and returns `Response | null`:
 *
 *   - `Response` → registration handled (the channel already sent the
 *     confirmation DM); the orchestrator returns this directly and
 *     SKIPS `sendToAsh` entirely. No welcome wall, no Flow 2 misfire,
 *     no other bot messages.
 *   - `null`     → not a registration inbound (or the registration text
 *     parsed but the lib write failed). The orchestrator falls through
 *     to the classifier path so the agent gets a turn — same fail-safe
 *     pattern as Slice 1 (#86), Slice 2 (#87), Slice 3 (#88).
 *
 * Why two parsers (slash + free-text):
 *
 *   - `/register …` is the deterministic, intent-explicit entry — the
 *     user typed the slash so we apply the body regex and accept
 *     whatever parses. If the regex fails on `/register` (bare slash,
 *     or args that don't match), we still skip the agent and DM a
 *     one-sentence "try `/register Name, Street Number`" prompt rather
 *     than letting the welcome wall fire. The user is clearly trying
 *     to register; the model has no useful contribution to make there.
 *   - Free-text registration (e.g. `Diego de Miguel, Lutterothstrasse
 *     69 Erdgeschoss Links` with no slash) matches the same body
 *     regex but is more conservative — false positives on free text
 *     would silently overwrite Resident records. The body regex is
 *     strict (street-suffix + house number both required) so the
 *     false-positive surface is small.
 *
 * On free-text non-match we return `null` and let the classifier run —
 * the user might be sending a Flow 2 inbound that just happens to
 * contain a street name.
 */
async function handleRegistrationDm(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
): Promise<Response | null> {
  if (inbound.fromUserId === null) return null;

  const isSlash = isRegisterCommand(inbound.text);
  const parsed: ParsedRegistration | null = isSlash
    ? parseRegisterCommand(inbound.text)
    : parseFreeTextRegistration(inbound.text);

  // Free-text non-match — let the classifier path run.
  if (!isSlash && parsed === null) return null;

  const language = inbound.fromLanguageCode;

  // Slash invoked but args don't parse: skip the agent (it'd otherwise
  // emit the welcome wall) and DM a one-sentence localised prompt
  // pointing at the canonical shape.
  if (isSlash && parsed === null) {
    emitTrace("registration", "start", { phase: "usage-hint" });
    const prompt = buildRegisterUsageHint(language);
    try {
      emitTrace("dm", "start");
      await deps.sendDirectMessage(inbound.chatId, prompt);
      emitTrace("dm", "end");
    } catch (err) {
      console.error(
        "[handleRegistrationDm] usage-hint DM failed for chatId",
        inbound.chatId,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
    }
    emitTrace("registration", "end");
    return new Response(null, { status: 204 });
  }

  // Slash or free-text with a successful parse: write the Resident +
  // send ONE deterministic confirmation DM, then return 204.
  emitTrace("registration", "start");
  try {
    const { resident } = await deps.registerResident({
      name: parsed!.name,
      street: parsed!.street,
      houseNumber: parsed!.houseNumber,
      floor: parsed!.floor,
      buzzerName: parsed!.buzzerName,
      platformId: String(inbound.fromUserId),
      telegramLanguageCode: language,
    });
    const confirmation = buildRegistrationConfirmationDm({
      resident,
      fallbackLanguageCode: language,
    });
    try {
      emitTrace("dm", "start");
      await deps.sendDirectMessage(inbound.chatId, confirmation);
      emitTrace("dm", "end");
    } catch (err) {
      console.error(
        "[handleRegistrationDm] confirmation DM failed for chatId",
        inbound.chatId,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
    }
    emitTrace("registration", "end");
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error(
      "[handleRegistrationDm] registerResident failed for chatId",
      inbound.chatId,
      "userId",
      inbound.fromUserId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    // Lib write failed — fall through to the agent so the user gets
    // some response. Free-text inbound's registration write failing
    // also falls through (rather than swallowing into a generic
    // apology) so the agent can ask the user to retry.
    return null;
  }
}

/**
 * One-sentence localised prompt for a `/register` slash with no
 * parseable arguments. Same de/en/es/tr language set as the rest of the
 * channel; falls back to German.
 */
const REGISTER_USAGE_HINTS: Readonly<Record<string, string>> = {
  de: "Bitte schreibe: /register <Name>, <Straße> <Hausnummer> [Etage] [Klingelname]. Beispiel: /register Diego de Miguel, Lutterothstrasse 69 Erdgeschoss Links.",
  en: "Please write: /register <Name>, <Street> <House number> [Floor] [Buzzer]. Example: /register Diego de Miguel, Lutterothstrasse 69 Erdgeschoss Links.",
  es: "Por favor escribe: /register <Nombre>, <Calle> <Número> [Piso] [Timbre]. Ejemplo: /register Diego de Miguel, Lutterothstrasse 69 Erdgeschoss Links.",
  tr: "Lütfen şöyle yaz: /register <Ad>, <Sokak> <Numara> [Kat] [Zil]. Örnek: /register Diego de Miguel, Lutterothstrasse 69 Erdgeschoss Links.",
};

function buildRegisterUsageHint(raw: string | null | undefined): string {
  const normalised = normaliseLanguageCode(raw);
  if (normalised && REGISTER_USAGE_HINTS[normalised]) {
    return REGISTER_USAGE_HINTS[normalised]!;
  }
  return REGISTER_USAGE_HINTS["de"]!;
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

  // #102 live diagram: every inbound past verify+parse ignites the
  // CHANNEL box. The factory entered `runWithTrace(...)` before calling
  // us, so `emitTrace` publishes onto the bus the SSE route is feeding
  // to the browser. Emitting unconditionally — before the callback /
  // message branch — means the channel box lights on every shape the
  // orchestrator handles (callback taps, photos, slash, free-text DMs,
  // group messages).
  emitTrace("channel", "start");

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

  // v2.1 #97: registration is the explicit, channel-deterministic
  // onboarding entry. The slash variant must run BEFORE any other DM
  // route because `/register` IS the user's intent — no classifier
  // call, no agent invocation. The free-text variant runs in the same
  // position so a comma-separated "Name, Street Number" inbound also
  // bypasses the agent (the agent's only viable response is to
  // register the user, which we can do here without burning a turn).
  // Only DMs from known senders are eligible — group messages and
  // anonymous webhooks fall through to the legacy path.
  if (inbound.photoFileId === null && !inbound.isGroup && inbound.fromUserId !== null) {
    const handled = await handleRegistrationDm(inbound, deps);
    if (handled) return handled;
  }

  // v2.1 #100: Flow 2 entry paths (DM photo, DM text → classifier,
  // `/receive` slash) now own their own user-facing DM via
  // `sendDirectMessage`. Each route returns `Flow2RouteResult`:
  //
  //   - `{ kind: "handled" }`     → channel already sent the DM; skip
  //     `sendToAsh` entirely. Closes the agent text-leak surface that
  //     produced the welcome wall + duplicate registration + tripled
  //     ack on the live trace.
  //   - `{ kind: "fallthrough" }` → hand `toAgent` to `sendToAsh` (the
  //     route couldn't make a deterministic decision — typically an
  //     unregistered caller or Redis hiccup; the agent's existing
  //     instructions handle that).
  //
  // Group photos still go through the agent (Flow 1) and group text
  // messages also go through the agent (no Flow 2 in groups).
  let message: string;
  let trigger: TelegramTriggerKind;
  if (inbound.photoFileId !== null && !inbound.isGroup) {
    // DM photo path — fully channel-deterministic per #100.
    const result = await routeDmPhoto(inbound, inbound.photoFileId, deps);
    if (result.kind === "handled") return new Response(null, { status: 204 });
    message = result.toAgent;
    trigger = "telegram.photo";
  } else if (inbound.photoFileId !== null) {
    // Group photo path — Flow 1 / parse_label.
    message = await buildSyntheticGroupPhotoMessage(inbound, deps);
    trigger = "telegram.photo";
  } else if (!inbound.isGroup && inbound.fromUserId !== null) {
    // `/receive` is the explicit, classifier-bypassing entry point for
    // Flow 2 v2 (#87). It must run BEFORE `classify_dm_intent` because
    // the user invoking the slash is already a high-confidence signal
    // — there's no reason to ask Gemini Flash to second-guess them.
    const usedReceiveCommand = isReceiveCommand(inbound.text);
    const result = usedReceiveCommand
      ? await routeReceiveCommand(inbound, deps)
      : await routeDmTextThroughClassifier(inbound, deps);
    if (result.kind === "handled") return new Response(null, { status: 204 });
    message = result.toAgent;
    trigger = usedReceiveCommand ? "telegram.slash-receive" : "telegram.text-dm";
  } else if (inbound.isGroup) {
    // v2.1 #106 Slice 1: group text now routes through the Flow 1
    // classifier first. On a high-confidence package-registration
    // verdict with a registered recipient, the channel registers
    // the package + posts the group ack + DMs the recipient itself —
    // `sendToAsh` is NEVER called on that branch. On disambiguation
    // cases (low/medium confidence, unknown/known_telegram recipient,
    // unregistered holder), Slice 1 stays silent; Slice 3 (#109)
    // introduces the clarification synthetic for the agent.
    const result = await routeGroupTextThroughClassifier(inbound, deps);
    if (result.kind === "handled" || result.kind === "silent") {
      return new Response(null, { status: 204 });
    }
    message = result.toAgent;
    trigger = "telegram.group";
  } else {
    // Anonymous DM (no `from` on the payload). Rare — Telegram normally
    // attaches a `from` on every message. Bucket with text-dm so the
    // dashboard's Trigger column still populates rather than reading
    // `—`.
    message = inbound.text;
    trigger = "telegram.text-dm";
  }

  // v2.1 #99: attribute the post-routing inbound shape onto the active
  // OTel span so Agent Runs shows what fired this turn. The Trigger
  // column populates whenever the channel hands a message to the
  // agent — channel-deterministic paths (Flow 2 entries, registration,
  // volunteer-accept) return earlier and never reach this line.
  deps.setTriggerAttribute?.(trigger);

  // #102 live diagram: the AGENT box only lights on these fallthrough
  // paths — Flow 2 entries, registration, volunteer-accept all return
  // earlier. This is the structural invariant v2.1 enforces; the
  // diagram makes it visible to booth visitors.
  emitTrace("agent", "start", { trigger });

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
