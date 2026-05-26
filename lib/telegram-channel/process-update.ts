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
 * Photo path: routing is by chat type. Both branches are fully
 * channel-deterministic — the agent never runs on a Flow 1 / Flow 2
 * photo on the happy path.
 *
 *   - Group photo → Flow 1 (the holder is showing a shipping label
 *     they received on someone else's package). The channel resolves
 *     the Telegram `file_id` to a signed HTTPS URL via `getFileUrl`,
 *     calls `parseLabel({ imageUrl, caption })` itself (v2.1 #107 /
 *     Slice 2 of #106 — partial revert of #79 for parse_label), and
 *     on `confidence === "high"` + a recipient that resolves to a
 *     registered Resident calls `registerPackage` directly, posts the
 *     deterministic group ack, and DMs the recipient with the
 *     `[Abgeholt]` keyboard. `sendToAsh` is never called. Every other
 *     branch (low/medium-conf parse, missing recipient,
 *     known_telegram / unknown recipient, parse_label outage,
 *     getFileUrl failure) stays silent in Slice 2; Slice 3 (#109)
 *     introduces the `[FLOW_1 CLARIFICATION]` synthetic with hard
 *     prohibitions on free-form output for the disambiguation cases.
 *     Pre-#107: the orchestrator handed the agent a `[photo received]
 *     file_url=…` synthetic and the agent invoked `parse_label`
 *     itself — that closed the observability gap from pre-#79 but
 *     left the agent on the inbound surface, which the live trace
 *     2026-05-22 (#105) showed produces 20+ free-form German messages
 *     on a single inbound. Pulling the decision OUT of the model
 *     closes the text-leak surface structurally.
 *   - DM photo → `parse_tracking_page` + channel-side routing
 *     (Flow 2 v2.1 / #88, fully agent-bypassed per #100). On
 *     `confidence === "high"` AND `absenceSignal` in {`true`,
 *     `undefined`}, the channel writes the `ReceptionRequest` directly
 *     via `createReceptionRequest` and sends the requester ONE
 *     localised ack DM via `sendDirectMessage`. On any other outcome
 *     (low/medium confidence, explicit `absenceSignal: false`, parse
 *     failure, unregistered caller, Redis hiccup), the channel sends
 *     a localised recovery prompt DM pointing at `/receive` (Slice 2 /
 *     #87) and inline `/register` for unregistered senders. The agent
 *     never runs on the DM photo path under any condition.
 *
 * Both vision tools route through Vercel AI Gateway with Gemini 3.1
 * Flash Lite as primary and Claude Sonnet 4.6 as fallback. The
 * trade-off Slice 2 accepts (per #107's design call): `parse_label`'s
 * token spend no longer lands inside `ash.turn` because the agent
 * never runs on the channel-deterministic happy path. Observability
 * lives on the custom OTel spans emitted by `lib/trace.ts`.
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
  type RecipientResolution,
  type RegisterPackageInput,
  type RegisterPackageResult,
} from "../package.js";
import {
  PICKUP_ALREADY_DONE_ERROR_CODE,
  PICKUP_NOT_RECIPIENT_ERROR_CODE,
  type ConfirmPickupResult,
} from "../pickup.js";
import type {
  Package,
  PackageCarrier,
  ReceptionRequest,
  Resident,
} from "../redis.js";
import { emitTrace } from "../trace.js";
import {
  buildRegistrationConfirmationDm,
  isRegisterCommand,
  isStartCommand,
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
  buildDmTextPickupAlreadyDoneText,
  buildDmTextPickupConfirmedText,
  buildDmTextPickupMultiplePackagesText,
  buildDmTextPickupNoOpenPackagesText,
  buildDmTextPickupRetryText,
  buildDmTextPickupWaitingOnVolunteerText,
  buildFlow1ClarificationSynthetic,
  buildGroupAckText,
  buildHolderConfirmationDmText,
  buildHolderNotRegisteredNudge,
  buildPickupKeyboard,
  buildRecipientDmText,
  buildUnknownRecipientGroupQuestion,
  captionLooksLikeMultiRecipient,
  type Flow1ClarificationReason,
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
  buildHolderThanksDmText,
  pickupAlreadyDoneToast,
  pickupNotRecipientToast,
  pickupRetryToast,
} from "./pickup-dms.js";
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
   * Group photos route through the channel-side `parseLabel` (Slice 2
   * of #106 / #107) — the orchestrator picks the DM vs group branch
   * off `inbound.isGroup`.
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
   * v2.1 #107 (Slice 2 of #106): vision parser for shipping-label
   * photos. Wired by the factory to `agent/tools/parse_label.ts`'s
   * `execute({ imageUrl, caption })`. The orchestrator calls this
   * exactly once per inbound group photo update; the structured
   * result drives the channel-side routing decision in
   * `routeGroupPhoto`:
   *
   *   - `confidence === "high"` AND `recipientName` present AND the
   *     resolved recipient is a registered Resident → channel calls
   *     `registerPackage` directly + posts the deterministic group
   *     ack + DMs the recipient via `sendDirectMessage`. No agent
   *     invocation.
   *   - anything else (low/medium confidence, missing recipientName,
   *     parse_label throws, getFileUrl throws, recipient resolves to
   *     known_telegram / unknown, unregistered holder) → channel
   *     stays silent (no group leak). Slice 3 (#109) will introduce
   *     the `[FLOW_1 CLARIFICATION]` synthetic for the disambiguation
   *     cases.
   *
   * Throws when the underlying model + fallback both fail — the
   * orchestrator's catch logs the error and stays silent (Slice 3
   * deferral) so the group is never spammed by a vision outage.
   *
   * Pre-#107 the agent invoked this tool itself via a `[photo
   * received] file_url=…` synthetic (#79 promotion). Slice 2 partially
   * reverts that for `parse_label` specifically — the structural fix
   * for Flow 1's text-leak surface needs the registration decision OUT
   * of the model entirely. The trade-off is that the `parse_label`
   * call no longer lands inside `ash.turn`; on a channel-deterministic
   * happy path the agent never runs, so there's no `ash.turn` to
   * attribute the spend to anyway. Observability for the vision call
   * lands on the custom OTel span this module emits via `emitTrace`.
   */
  readonly parseLabel: (input: {
    imageUrl: string;
    caption?: string;
  }) => Promise<{
    carrier: PackageCarrier;
    trackingNumber?: string;
    recipientName?: string;
    recipientHouseNumber?: string;
    confidence: "high" | "medium" | "low";
    reason: string;
  }>;
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
  }) => Promise<DmIntentClassificationResult>;
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
   * v2.1 #109 (Slice 3 of #105): pure recipient-resolution lookup, no
   * Package write. The channel calls this at medium-conf classifier or
   * vision verdicts to decide whether to register (if resolution is
   * `resident`) or fall through to the agent's `[FLOW_1 CLARIFICATION]`
   * synthetic (if the recipient doesn't resolve to a registered
   * Resident). At high-conf the channel calls `registerPackage`
   * directly — which calls `resolveRecipient` internally — so the
   * high-conf path keeps its single-round-trip shape; this dep only
   * fires on the medium-conf branch.
   *
   * Implemented in the factory via `lib/package.ts::resolveRecipient`.
   * Throws bubble up; the channel's catch treats a thrown lookup as
   * "unknown" and falls through with `reason=low-conf`.
   */
  readonly resolveRecipient: (
    recipientName: string,
    recipientHouseNumber: string,
  ) => Promise<RecipientResolution>;
  /**
   * v2.1 #108 (Slice 4 of #105): channel-side handle for the
   * lib-level `confirmPickup`. The channel calls this directly when
   * a registered resident taps `[Abgeholt]` on the group ack or
   * recipient DM posted by Slice 1 (#106) so the status flip + the
   * group-edit + the holder thanks DM all land BEFORE — and
   * INSTEAD of — any agent invocation. Mirrors the v2.1 #96 Part A
   * volunteer-accept shape exactly: throws typed `ConfirmPickupError`
   * with codes the orchestrator branches on, no Ash-context
   * dependency so tests can stub the dep without spinning up Redis.
   *
   * Implemented in the factory via the lib-level `confirmPickup` from
   * `lib/pickup.ts`. Throwing with `PICKUP_NOT_RECIPIENT` →
   * dedicated toast + keyboard stripped. Throwing with
   * `PICKUP_ALREADY_DONE` → dedicated toast (keyboard already
   * stripped from the previous success). Any other throw →
   * generic retry toast + keyboard stays live so the recipient can
   * re-tap once the underlying hiccup clears.
   */
  readonly confirmPickup: (
    caller: Resident,
    packageId: string,
  ) => Promise<ConfirmPickupResult>;
  /**
   * v2.1 #110: list held packages on the caller's street whose
   * recipient is the caller themselves. Used by the DM-text
   * pickup-confirmation route to resolve "which package?" before
   * calling `confirmPickup`. Returns the held subset in arbitrary
   * order; the caller branches on `[].length`:
   *
   *   - 0 → DM "you have no open packages with me"
   *   - 1 → call `confirmPickup` deterministically
   *   - 2+ → DM "which one? tap [Abgeholt] in the per-package DM above"
   *
   * Implemented in the factory via `listHeldPackagesForStreet` +
   * an in-memory filter on `recipientResidentId === caller.id`. The
   * spike-scale tradeoff `listHeldPackagesForStreet` already accepts
   * (full street scan per query) is fine here too — pickup-via-DM
   * is rare and the street is small.
   *
   * Throws bubble up; the channel catches them and DMs the generic
   * retry prompt rather than handing the inbound to the agent.
   */
  readonly listOpenPackagesForRecipient: (
    caller: Resident,
  ) => Promise<readonly Package[]>;
  /**
   * v2.1 #122: list `matched` ReceptionRequests on the caller's
   * street where the caller is the requester (their package is on the
   * way and a volunteer has already claimed it, but the volunteer
   * hasn't reported the arrival yet). Used exclusively by the
   * DM-text pickup-confirmation 0-match branch to upgrade the
   * generic "no open packages" DM to a context-aware "waiting on
   * volunteer" DM that names the volunteer.
   *
   * Returns matched-status RRs sorted most-recent-first (caller picks
   * the first when there are several). Implemented in the factory via
   * `listReceptionRequestsForStreet` + an in-memory filter on
   * `requesterResidentId === caller.id` + `status === "matched"`.
   * Same spike-scale tradeoff as `listOpenPackagesForRecipient` — a
   * full street scan per query is fine; this only fires on the
   * 0-package branch which is itself a rare path.
   *
   * Throws bubble up; the caller catches them and falls through to
   * the existing "no open packages" DM (no regression on the pre-#122
   * UX when the new lookup hiccups).
   */
  readonly listMatchedReceptionRequestsForRequester: (
    caller: Resident,
  ) => Promise<readonly ReceptionRequest[]>;
  /**
   * v2.1 #122: resolve a Resident by their stored platform id (the
   * `Resident.id` / `Resident.platformId` string, NOT the numeric
   * Telegram user id consumed by `getRegisteredResident`). Used by
   * the DM-text pickup-confirmation "waiting on volunteer" branch
   * to look up the matched RR's volunteer record so the DM can
   * name them.
   *
   * Implemented in the factory via `lib/redis.ts::getResident`.
   *
   * Returning `null` on miss is normal — the channel falls back to
   * the volunteer-name-free phrasing rather than throwing. Throws
   * bubble up; the caller treats a thrown lookup as "unresolvable"
   * and uses the same fallback.
   */
  readonly getResidentByPlatformId: (
    platformId: string,
  ) => Promise<Resident | null>;
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
 *   - `telegram.callback`              — callback actions that still
 *                                        reach the agent (stale
 *                                        `accept_reception_request`,
 *                                        `decline_reception_request`,
 *                                        `remind_later`, unknown).
 *                                        `confirm_pickup` no longer
 *                                        reaches the agent after v2.1
 *                                        #108 (Slice 4 of #105) —
 *                                        the channel handles those
 *                                        taps deterministically.
 */
export type TelegramTriggerKind =
  | "telegram.text-dm"
  | "telegram.group"
  | "telegram.photo"
  | "telegram.slash-receive"
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
 * v2.1 #110: `kind` is the routing discriminator. Pre-#110 callers
 * branched on the boolean `isFlow2`; post-#110 the equivalent check
 * is `kind === "flow2-reception"`. Tests + callers updated in lockstep.
 *
 * @see agent/tools/classify_dm_intent.ts
 */
export type DmIntentKind =
  | "flow2-reception"
  | "pickup-confirmation"
  | "registration"
  | "other";

export interface DmIntentClassificationResult {
  readonly kind: DmIntentKind;
  readonly absenceSignal: boolean;
  readonly carrier?: PackageCarrier;
  readonly expectedDate?: string;
  readonly expectedWindowStartAt?: number;
  readonly expectedWindowEndAt?: number;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

/**
 * @deprecated Pre-#110 alias for {@link DmIntentClassificationResult}.
 * Kept as a type alias only so external imports — should there be any
 * — break loudly at the schema mismatch rather than the rename.
 */
export type Flow2ClassificationResult = DmIntentClassificationResult;

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

  // v2.1 #108 (Slice 4 of #105): channel-deterministic pickup tap.
  // The `[Abgeholt]` callback is handled here end-to-end (status flip
  // via `confirmPickup`, DM the holder, strip the recipient DM
  // keyboard) and `sendToAsh` is NEVER called on this path. Mirrors
  // the volunteer-accept callback architecture (#96) one-for-one.
  // v2.1 #114 (Slice 1 of #113) dropped the group-ack edit step —
  // the group ack is announce-only and the only tap surface left is
  // the recipient's 1:1 DM.
  //
  // The pre-#108 path was: gate-on-recipient-scope + ack + strip +
  // hand the agent a `[button-tap] confirm_pickup` synthetic. The
  // model then ran the deleted `confirm_pickup` tool. Pulling the
  // decision OUT of the model closes the same v1-style text-leak
  // surface #100 closed for Flow 2 acks.
  if (parsed.action === "confirm_pickup" && parsed.id) {
    return handleConfirmPickup(cb, parsed.id, deps);
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
  // OTel span so Agent Runs shows what fired this turn. After v2.1
  // #108 (Slice 4 of #105) channel-handles `confirm_pickup` taps
  // deterministically without invoking the agent, the only callbacks
  // that still reach this synthetic path are the legacy ones
  // (`accept_reception_request`, `decline_reception_request`,
  // `remind_later`, unknown actions) — they all share the generic
  // `telegram.callback` bucket so we can still distinguish them from
  // text/photo/slash triggers in dashboard filters.
  deps.setTriggerAttribute?.("telegram.callback");

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
 * v2.1 #107 (Slice 2 of #106): channel-deterministic group photo route.
 *
 * Same architectural shape as `routeGroupTextThroughClassifier` — the
 * channel resolves the photo URL, calls `parse_label` itself (partial
 * revert of #79 for parse_label specifically), and decides whether to
 * register the Package, post a deterministic group question
 * (`kennt jemand X?`), or fall through to the agent with a
 * `[FLOW_1 CLARIFICATION]` synthetic. `sendToAsh` is only invoked on
 * the fallthrough branch — and the synthetic constrains the agent to
 * a single short clarifying question with no tool calls + no group
 * output, so the v1-style 20+-message wall the live trace 2026-05-22
 * (#105) produced stays structurally impossible.
 *
 * Branch table (v2.1 #109 Slice 3 of #105):
 *
 *   - getFileUrl throws            → `fallthrough reason=parse-failed`
 *                                    (no URL, can't surface anything
 *                                    more specific to the agent)
 *   - parseLabel throws            → `fallthrough reason=parse-failed`
 *   - confidence: "low"            → `fallthrough reason=low-conf`
 *                                    (or `ambiguous-multi` when the
 *                                    caption mentions 2+ names)
 *   - high/medium + no recipient   → `fallthrough reason=missing-recipient`
 *                                    (or `ambiguous-multi`)
 *   - high-conf + resident         → register + group ack + recipient DM
 *   - high-conf + known_telegram   → register (Package row landed for
 *                                    later cron sweeps) + silent
 *   - high-conf + unknown          → register + group question
 *                                    (`📦 Paket für X – kennt jemand X?`)
 *   - medium-conf + resident       → register (treat as high-conf when
 *                                    the second signal converges)
 *   - medium-conf + non-resident   → `fallthrough reason=low-conf`
 *                                    (no Package write — holder
 *                                    clarifies, classifier reruns,
 *                                    Slice 1/2 handles deterministically)
 *   - unregistered holder          → `/register` nudge DM, silent in
 *                                    group (matches text path / #106)
 */
/**
 * v2.1 #116 (Slice 3 of #113): private holder confirmation DM sent
 * INSTEAD of the group ack when a Flow 1 registration LINKS to a Flow 2
 * `ReceptionRequest`. The original Flow 2 group card is the public
 * announcement; the holder still needs a private signal that the
 * channel registered the package and notified the recipient.
 *
 * Shared by both the photo route (`routeGroupPhoto`) and the text route
 * (`routeGroupTextThroughClassifier`). Failures are swallowed (logged)
 * — same shape the group ack post + recipient DM use; a transient
 * Telegram outage shouldn't roll back the Package write.
 */
async function sendFlow1HolderConfirmation(args: {
  readonly deps: ProcessUpdateDeps;
  readonly registered: RegisterPackageResult;
  readonly source: "photo" | "text";
}): Promise<void> {
  const { deps, registered, source } = args;
  if (registered.recipientResolution.kind !== "resident") {
    // Defensive: only called from the resident branch. The narrowed
    // type is established at the call sites, but the helper guards
    // against future refactors handing it a non-resident resolution.
    return;
  }
  const holderChatId = Number(registered.holder.platformId);
  if (!Number.isFinite(holderChatId)) {
    console.error(
      "[flow1] holder.platformId is not a finite number — skipping holder confirmation DM",
      { platformId: registered.holder.platformId, source },
    );
    return;
  }
  const text = buildHolderConfirmationDmText({
    recipientName: registered.recipientResolution.resident.name,
    language: registered.holder.language,
  });
  try {
    emitTrace("dm", "start", { kind: "flow1-holder-confirmation" });
    await deps.sendDirectMessage(holderChatId, text);
    emitTrace("dm", "end", { kind: "flow1-holder-confirmation" });
  } catch (err) {
    console.error(
      `[flow1] holder confirmation DM (${source}) failed for platformId`,
      registered.holder.platformId,
      "package",
      registered.package.id,
      "error:",
      err instanceof Error ? err.message : err,
    );
    emitTrace("dm", "error", { kind: "flow1-holder-confirmation" });
  }
}

async function routeGroupPhoto(
  inbound: TelegramInboundMessage,
  fileId: string,
  deps: ProcessUpdateDeps,
): Promise<Flow1RouteResult> {
  if (inbound.fromUserId === null) {
    // Anonymous group photo (no `from` on the payload) — can't
    // resolve the holder, so stay silent.
    return { kind: "silent" };
  }

  const captionText = inbound.text.length > 0 ? inbound.text : undefined;
  const holderLanguage = inbound.fromLanguageCode
    ? (normaliseLanguageCode(inbound.fromLanguageCode) ?? "de")
    : "de";

  function fallthroughClarification(args: {
    reason: Flow1ClarificationReason;
    parsed?: { carrier?: string; recipientName?: string; confidence?: "low" | "medium" | "high" };
    holder: Resident | null;
  }): Flow1RouteResult {
    emitTrace("flow1", "fallthrough", {
      reason: args.reason,
      source: "photo",
    });
    return {
      kind: "fallthrough",
      toAgent: buildFlow1ClarificationSynthetic({
        language: args.holder?.language ?? holderLanguage,
        reason: args.reason,
        source: "photo",
        carrier: args.parsed?.carrier,
        recipientName: args.parsed?.recipientName,
        confidence: args.parsed?.confidence,
        caption: captionText,
        holderName: args.holder?.name,
        holderHouseNumber: args.holder?.houseNumber,
      }),
    };
  }

  // Resolve the holder eagerly — every fallthrough branch needs the
  // holder name + house in the synthetic so the agent's clarifying
  // question can address them by name. A null holder still lets us
  // emit a fallthrough (synthetic embeds "(unknown)") but the
  // unregistered-holder branch below short-circuits to the /register
  // nudge before that case is reachable.
  const holder = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);

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
    return fallthroughClarification({ reason: "parse-failed", holder });
  }

  let parsed: Awaited<ReturnType<ProcessUpdateDeps["parseLabel"]>>;
  emitTrace("vision", "start", { tool: "parse_label" });
  try {
    parsed = await deps.parseLabel({ imageUrl, caption: captionText });
    emitTrace("vision", "end", {
      tool: "parse_label",
      confidence: parsed.confidence,
    });
  } catch (err) {
    console.error(
      "[parse_label] failed for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("vision", "error", { tool: "parse_label" });
    return fallthroughClarification({ reason: "parse-failed", holder });
  }

  // Disambiguation branches that don't depend on resolution. The
  // ambiguous-multi heuristic upgrades a low-conf / missing-recipient
  // reason when the caption clearly names two recipients — the
  // agent's clarifying question can then ask about the second label
  // directly.
  const multi = captionLooksLikeMultiRecipient(captionText);
  if (parsed.confidence === "low") {
    return fallthroughClarification({
      reason: multi ? "ambiguous-multi" : "low-conf",
      parsed,
      holder,
    });
  }
  if (!parsed.recipientName) {
    return fallthroughClarification({
      reason: multi ? "ambiguous-multi" : "missing-recipient",
      parsed,
      holder,
    });
  }

  const recipientHouseNumber =
    parsed.recipientHouseNumber ?? holder?.houseNumber ?? "";
  if (recipientHouseNumber === "") {
    return fallthroughClarification({
      reason: "missing-recipient",
      parsed,
      holder,
    });
  }

  // Medium-conf: only register when the recipient resolves to a
  // registered Resident. Otherwise fall through so the agent can ask
  // the holder to disambiguate (no Package write — the holder's
  // restated reply will be re-classified at high confidence and
  // register cleanly).
  if (parsed.confidence === "medium") {
    let resolution: RecipientResolution;
    try {
      resolution = await deps.resolveRecipient(
        parsed.recipientName,
        recipientHouseNumber,
      );
    } catch (err) {
      console.error(
        "[resolveRecipient] (photo, medium-conf) failed for recipient",
        parsed.recipientName,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
      return fallthroughClarification({ reason: "low-conf", parsed, holder });
    }
    if (resolution.kind !== "resident") {
      return fallthroughClarification({ reason: "low-conf", parsed, holder });
    }
    // Resolution converges; continue to register below.
  }

  let registered: RegisterPackageResult;
  emitTrace("flow1", "register.start", {
    recipient: parsed.recipientName,
    source: "photo",
  });
  try {
    registered = await deps.registerPackage(holder, {
      recipientName: parsed.recipientName,
      recipientHouseNumber,
      carrier: parsed.carrier,
      trackingNumber: parsed.trackingNumber,
    });
    emitTrace("flow1", "register.end", {
      recipient: parsed.recipientName,
      resolution: registered.recipientResolution.kind,
      source: "photo",
    });
  } catch (err) {
    const errorCode =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (errorCode === REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE) {
      const language =
        inbound.fromLanguageCode &&
        normaliseLanguageCode(inbound.fromLanguageCode);
      const nudge = buildHolderNotRegisteredNudge(language);
      try {
        await deps.sendDirectMessage(inbound.fromUserId, nudge);
      } catch (dmErr) {
        console.error(
          "[flow1] holder-not-registered nudge DM (photo) failed for userId",
          inbound.fromUserId,
          "error:",
          dmErr instanceof Error ? dmErr.message : dmErr,
        );
      }
      emitTrace("flow1", "reject.holder-not-registered", { source: "photo" });
      return { kind: "handled" };
    }
    console.error(
      "[register_package] (photo) failed for holder",
      inbound.fromUserId,
      "recipient",
      parsed.recipientName,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow1", "register.error", { source: "photo" });
    return { kind: "silent" };
  }

  if (registered.recipientResolution.kind === "unknown") {
    // High-conf unknown recipient: post the deterministic group
    // question. The Package row is already in Redis so the cron
    // sweep can age it out if nobody claims (#109 acceptance: no
    // change to the cron schedule).
    const question = buildUnknownRecipientGroupQuestion(
      parsed.recipientName,
      holder?.language ?? holderLanguage,
    );
    try {
      emitTrace("dm", "start", { kind: "flow1-unknown-recipient" });
      await deps.sendDirectMessage(inbound.chatId, question);
      emitTrace("dm", "end", { kind: "flow1-unknown-recipient" });
    } catch (err) {
      console.error(
        "[flow1] unknown-recipient group question (photo) failed for chatId",
        inbound.chatId,
        "error:",
        err instanceof Error ? err.message : err,
      );
      emitTrace("dm", "error", { kind: "flow1-unknown-recipient" });
    }
    return { kind: "handled" };
  }

  if (registered.recipientResolution.kind !== "resident") {
    // known_telegram: the recipient has posted in the group but
    // hasn't /register'd. The Package row landed; we don't have a
    // DM channel to them yet. Stay silent (deferred — Slice 4 of a
    // future iteration could text_mention them in the group ack
    // without leaking the holder's buzzer/floor).
    emitTrace("flow1", "silent", {
      reason: registered.recipientResolution.kind,
      source: "photo",
    });
    return { kind: "silent" };
  }

  const recipientDmText = buildRecipientDmText({
    holder: registered.holder,
    recipient: registered.recipientResolution.resident,
  });
  // v2.1 #114: pickup keyboard lives only on the recipient DM now —
  // the group ack is announce-only. Pickup is private business
  // between the recipient and the bot.
  const recipientKeyboard = buildPickupKeyboard(registered.package.id);

  // v2.1 #116 (Slice 3 of #113): if this registration LINKS to a Flow 2
  // ReceptionRequest (the holder is fulfilling a pre-announced "I won't
  // be home" ask), suppress the group ack — the original Flow 2 group
  // post is the announcement — and DM the holder a private confirmation
  // instead. The recipient DM still fires unchanged.
  if (registered.receptionRequestFulfilled !== null) {
    await sendFlow1HolderConfirmation({
      deps,
      registered,
      source: "photo",
    });
  } else {
    const groupAckText = buildGroupAckText({
      holder: registered.holder,
      recipient: registered.recipientResolution.resident,
    });
    // Group ack. `sendDirectMessage` is chat-id-agnostic — sending to
    // `inbound.chatId` posts to the group when the inbound came from a
    // group. No inline keyboard (v2.1 #114).
    try {
      emitTrace("dm", "start", { kind: "flow1-group-ack" });
      await deps.sendDirectMessage(inbound.chatId, groupAckText);
      emitTrace("dm", "end", { kind: "flow1-group-ack" });
    } catch (err) {
      console.error(
        "[flow1] group ack post (photo) failed for chatId",
        inbound.chatId,
        "package",
        registered.package.id,
        "error:",
        err instanceof Error ? err.message : err,
      );
      emitTrace("dm", "error", { kind: "flow1-group-ack" });
    }
  }

  const recipientChatId = Number(registered.recipientResolution.resident.id);
  if (Number.isFinite(recipientChatId)) {
    try {
      emitTrace("dm", "start", { kind: "flow1-recipient" });
      await deps.sendDirectMessage(
        recipientChatId,
        recipientDmText,
        undefined,
        recipientKeyboard,
      );
      emitTrace("dm", "end", { kind: "flow1-recipient" });
    } catch (err) {
      console.error(
        "[flow1] recipient DM (photo) failed for resident id",
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
      "[flow1] recipient.id is not a finite number — skipping DM (photo)",
      { recipientId: registered.recipientResolution.resident.id },
    );
  }

  return { kind: "handled" };
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
 * v2.1 Slice 1 (#86) + #100 + #110: on every DM text inbound from a
 * known sender, call `classifyDmIntent` to decide which Flow path the
 * inbound belongs to. v2.1 #110 widened the routing from a boolean
 * `isFlow2` to a discriminated `kind`, adding a pickup-confirmation
 * branch ("Hab abgeholt" / "Picked up" / "Recibido" / "Teslim aldım"):
 *
 *   - `kind: "flow2-reception"` + high-confidence + registered caller
 *     → call `createReceptionRequest` + send localised ack DM. No
 *     agent involvement. (#86 / #100)
 *   - `kind: "pickup-confirmation"` + high-confidence + registered
 *     caller → resolve the caller's open packages, call `confirmPickup`
 *     deterministically when there's exactly one. No agent
 *     involvement on any pickup-confirmation branch (#110).
 *   - Anything else → fall through to the agent with the raw text.
 *
 * Every step is tolerant of failure: a classifier outage, an
 * unregistered caller, or a Redis/Bot-API hiccup all fall through to
 * the v2 behaviour of handing the raw text to the agent
 * (`{ kind: "fallthrough" }`). The card-posting and pickup-closure
 * decisions are the only places a privacy-violating or
 * canonical-state-corrupting side effect can land; if any upstream
 * step fails, we'd rather miss the routing than misroute.
 */
async function routeDmTextThroughClassifier(
  inbound: TelegramInboundMessage,
  deps: ProcessUpdateDeps,
): Promise<Flow2RouteResult> {
  if (inbound.fromUserId === null) {
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  let classification: DmIntentClassificationResult;
  emitTrace("classifier", "start");
  try {
    classification = await deps.classifyDmIntent({
      text: inbound.text,
      languageHint: inbound.fromLanguageCode ?? undefined,
    });
    emitTrace("classifier", "end", {
      intentKind: classification.kind,
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

  // v2.1 #110: pickup-confirmation has a structurally different
  // shape from flow2-reception (no createReceptionRequest, different
  // dep), so dispatch on `kind` first.
  if (
    classification.kind === "pickup-confirmation" &&
    classification.confidence === "high"
  ) {
    return routeDmTextPickupConfirmation(inbound, deps);
  }

  if (
    classification.kind !== "flow2-reception" ||
    classification.confidence !== "high"
  ) {
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
 * v2.1 #110: route a DM-text pickup confirmation. The classifier
 * verdict `kind === "pickup-confirmation"` + high-confidence already
 * filtered the inbound; here we resolve "which package?" and call
 * `lib/pickup.ts::confirmPickup` deterministically when there's
 * exactly one open package addressed to the caller.
 *
 * Branches:
 *
 *   - Unregistered caller     → fallthrough (agent will ask them to
 *                                /register).
 *   - 0 open packages         → v2.1 #122: check for `matched`
 *                                ReceptionRequests where the caller
 *                                is the requester. If ≥1 match, DM
 *                                "your package isn't here yet — X is
 *                                collecting it for you" naming the
 *                                volunteer (most-recent RR wins).
 *                                Otherwise fall back to the pre-#122
 *                                "you have no open packages" DM.
 *                                Either way: handled (no agent).
 *   - 2+ open packages        → DM "tap [Abgeholt] in the per-package
 *                                DM above" + handled (v2.1 #115). DM
 *                                text alone can't disambiguate; the
 *                                recipient's per-package DM thread is
 *                                the only surface with a button per
 *                                package since #114 killed the group
 *                                keyboard, so we point them there.
 *   - 1 open package          → call `confirmPickup`. On success: send
 *                                a confirmation DM to the caller +
 *                                the holder thanks DM (same template
 *                                pickup-dms.ts uses for the button-tap
 *                                path). v2.1 #114 dropped the
 *                                group-ack edit on both surfaces —
 *                                the group ack is announce-only and
 *                                the close-the-loop signal lives on
 *                                the DM side.
 *   - PICKUP_ALREADY_DONE     → DM "already picked up" + handled.
 *   - Other throw / lookup    → DM retry prompt + handled. We don't
 *     hiccup                     fall through, because the agent on
 *                                this surface is more likely to
 *                                misroute than to add value.
 *
 * `sendToAsh` is NEVER called on any pickup-confirmation branch.
 */
async function routeDmTextPickupConfirmation(
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
    // Unregistered → fallthrough so the agent can ask them to /register.
    return { kind: "fallthrough", toAgent: inbound.text };
  }

  const language = caller.language ?? inbound.fromLanguageCode ?? "de";

  let open: readonly Package[];
  try {
    open = await deps.listOpenPackagesForRecipient(caller);
  } catch (err) {
    console.error(
      "[flow1-pickup-dm] listOpenPackagesForRecipient failed for userId",
      inbound.fromUserId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    await deps
      .sendDirectMessage(inbound.chatId, buildDmTextPickupRetryText(language))
      .catch(() => undefined);
    return { kind: "handled" };
  }

  if (open.length === 0) {
    // v2.1 #122: before sending the generic "no open packages" DM,
    // check whether the caller actually has a `matched` ReceptionRequest
    // as requester. If yes, their package IS on the way — a volunteer
    // has claimed but not yet reported. Send the context-aware
    // "waiting on volunteer" DM (names the volunteer when resolvable)
    // instead of the misleading "no open packages" copy.
    //
    // Either lookup throwing is non-fatal — fall through to the
    // pre-#122 generic DM so the new branch can never regress the
    // existing 0-match UX.
    let matched: readonly ReceptionRequest[] = [];
    try {
      matched =
        await deps.listMatchedReceptionRequestsForRequester(caller);
    } catch (err) {
      console.error(
        "[flow1-pickup-dm] listMatchedReceptionRequestsForRequester failed for userId",
        inbound.fromUserId,
        "error:",
        err instanceof Error ? err.message : err,
      );
    }

    if (matched.length > 0) {
      // Most-recent-first ordering is the factory's contract; pick the
      // first entry as the canonical "package the requester has in mind".
      const req = matched[0]!;
      let volunteerName: string | null = null;
      if (req.volunteerResidentId) {
        try {
          const volunteer = await deps.getResidentByPlatformId(
            req.volunteerResidentId,
          );
          volunteerName = volunteer?.name ?? null;
        } catch (err) {
          console.error(
            "[flow1-pickup-dm] getResidentByPlatformId failed for volunteer",
            req.volunteerResidentId,
            "error:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      await deps
        .sendDirectMessage(
          inbound.chatId,
          buildDmTextPickupWaitingOnVolunteerText({
            volunteerName,
            language,
          }),
        )
        .catch(() => undefined);
      return { kind: "handled" };
    }

    await deps
      .sendDirectMessage(
        inbound.chatId,
        buildDmTextPickupNoOpenPackagesText(language),
      )
      .catch(() => undefined);
    return { kind: "handled" };
  }

  if (open.length > 1) {
    await deps
      .sendDirectMessage(
        inbound.chatId,
        buildDmTextPickupMultiplePackagesText(language),
      )
      .catch(() => undefined);
    return { kind: "handled" };
  }

  const pkg = open[0]!;
  emitTrace("flow1", "pickup.start", { packageId: pkg.id, source: "dm-text" });
  let result: ConfirmPickupResult;
  try {
    result = await deps.confirmPickup(caller, pkg.id);
    emitTrace("flow1", "pickup.end", { packageId: pkg.id, source: "dm-text" });
  } catch (err) {
    const errorCode =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (errorCode === PICKUP_ALREADY_DONE_ERROR_CODE) {
      emitTrace("flow1", "pickup.reject.already-done", {
        packageId: pkg.id,
        source: "dm-text",
      });
      await deps
        .sendDirectMessage(
          inbound.chatId,
          buildDmTextPickupAlreadyDoneText(language),
        )
        .catch(() => undefined);
      return { kind: "handled" };
    }
    // PICKUP_NOT_RECIPIENT shouldn't fire here because we resolved
    // the package list off `recipientResidentId === caller.id`. If it
    // does (race against a concurrent flip), bucket with the generic
    // retry — the user can try again and `listOpenPackagesForRecipient`
    // will then return [].
    console.error(
      "[flow1-pickup-dm] confirmPickup failed for userId",
      inbound.fromUserId,
      "packageId",
      pkg.id,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow1", "pickup.reject.redis-hiccup", {
      packageId: pkg.id,
      source: "dm-text",
    });
    await deps
      .sendDirectMessage(inbound.chatId, buildDmTextPickupRetryText(language))
      .catch(() => undefined);
    return { kind: "handled" };
  }

  // Happy path: status flipped. Send a confirmation DM to the caller
  // + the holder thanks DM. Group ack stays untouched on both
  // surfaces since v2.1 #114.
  try {
    emitTrace("dm", "start", { kind: "flow1-pickup-confirm" });
    await deps.sendDirectMessage(
      inbound.chatId,
      buildDmTextPickupConfirmedText(language),
    );
    emitTrace("dm", "end", { kind: "flow1-pickup-confirm" });
  } catch (err) {
    console.error(
      "[flow1-pickup-dm] confirmation DM failed for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error ? err.message : err,
    );
    emitTrace("dm", "error", { kind: "flow1-pickup-confirm" });
  }

  if (result.holder) {
    const holderChatId = Number(result.holder.platformId);
    if (Number.isFinite(holderChatId)) {
      try {
        emitTrace("dm", "start", { kind: "pickup-holder-thanks" });
        await deps.sendDirectMessage(
          holderChatId,
          buildHolderThanksDmText({
            holder: result.holder,
            recipient: result.recipient ?? {
              id: result.package.recipientResidentId ?? "",
              name: result.package.recipientName,
              houseNumber: result.package.recipientHouseNumber,
              language: null,
            },
          }),
        );
        emitTrace("dm", "end", { kind: "pickup-holder-thanks" });
      } catch (err) {
        console.error(
          "[flow1-pickup-dm] holder thanks DM failed for platformId",
          result.holder.platformId,
          "error:",
          err instanceof Error ? err.message : err,
        );
        emitTrace("dm", "error", { kind: "pickup-holder-thanks" });
      }
    } else {
      console.error(
        "[flow1-pickup-dm] holder.platformId is not a finite number — skipping thanks DM",
        { platformId: result.holder.platformId },
      );
    }
  }

  return { kind: "handled" };
}

/**
 * v2.1 #106 Slice 1 + #109 Slice 3: route a group text message through
 * the Flow 1 classifier. The channel decides — outside the model — what
 * to do with each inbound:
 *
 *   1. High-conf + resident      → register + group ack + recipient DM
 *                                  (#106 Slice 1)
 *   2. High-conf + unknown       → register + post the deterministic
 *                                  group question ("kennt jemand X?")
 *                                  (#109 Slice 3)
 *   3. High-conf + known_telegram → register + silent (no DM channel
 *                                   to a non-Resident; later iteration
 *                                   could mention them in the ack)
 *   4. Medium-conf + resident    → register (treat as high-conf when
 *                                  the second signal converges) (#109)
 *   5. Medium-conf + non-resident → `fallthrough reason=low-conf`
 *                                   (no Package write — holder
 *                                   clarifies, classifier reruns) (#109)
 *   6. Medium-conf + multi-recipient → `fallthrough reason=ambiguous-multi`
 *                                       (rejecting bulk register at
 *                                       reduced confidence) (#109)
 *   7. Low-conf + isPkgReg       → `fallthrough reason=low-conf` or
 *                                  `ambiguous-multi` (#109)
 *   8. isPkgReg + 0 recipients   → `fallthrough reason=missing-recipient`
 *                                  (#109)
 *   9. Unregistered holder       → `/register` nudge DM, silent in group
 *                                  (#106 Slice 1)
 *  10. Classifier outage         → silent (we can't even tell whether
 *                                  the inbound was package-related;
 *                                  emitting a synthetic for every
 *                                  classifier failure on every group
 *                                  message would be noise)
 *  11. isPkgReg: false           → silent (off-topic, social chat)
 *
 * `sendToAsh` is invoked only on the fallthrough branches, and the
 * synthetic constrains the agent to a single short clarifying question
 * with no tool calls + no group output — so the v1-style 20+-message
 * wall the live trace 2026-05-22 (#105) produced stays structurally
 * impossible.
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

  const holderLanguage = inbound.fromLanguageCode
    ? (normaliseLanguageCode(inbound.fromLanguageCode) ?? "de")
    : "de";

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
    // Stay silent on a classifier outage. The text path has no
    // upstream signal that this inbound is package-related (unlike
    // the photo path where the user uploading a photo IS the
    // signal). Emitting a clarification synthetic for every random
    // off-topic group message would be louder than v2's text leak.
    return { kind: "silent" };
  }

  if (!classification.isPackageRegistration) {
    return { kind: "silent" };
  }

  // Resolve the holder eagerly — every register / fallthrough branch
  // below uses the holder name + house. A null holder is the
  // unregistered-holder case (handled when registerPackage throws).
  const holder = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);

  function fallthroughClarification(
    reason: Flow1ClarificationReason,
  ): Flow1RouteResult {
    emitTrace("flow1", "fallthrough", { reason, source: "text" });
    return {
      kind: "fallthrough",
      toAgent: buildFlow1ClarificationSynthetic({
        language: holder?.language ?? holderLanguage,
        reason,
        source: "text",
        carrier: classification.carrier,
        recipientName: classification.recipients[0]?.name,
        confidence: classification.confidence,
        caption: inbound.text,
        holderName: holder?.name,
        holderHouseNumber: holder?.houseNumber,
      }),
    };
  }

  // Positive registration but no recipients in the parsed payload —
  // ask the holder to name them.
  if (classification.recipients.length === 0) {
    return fallthroughClarification("missing-recipient");
  }

  // Low-conf positive: fall through (caption multi-name heuristic
  // bumps to ambiguous-multi when the model under-counted recipients).
  if (classification.confidence === "low") {
    return fallthroughClarification(
      classification.recipients.length >= 2 ||
        captionLooksLikeMultiRecipient(inbound.text)
        ? "ambiguous-multi"
        : "low-conf",
    );
  }

  // Medium-conf + 2+ recipients is too risky to bulk-register — fall
  // through with ambiguous-multi so the agent asks the holder to
  // confirm each recipient.
  if (
    classification.confidence === "medium" &&
    classification.recipients.length > 1
  ) {
    return fallthroughClarification("ambiguous-multi");
  }

  // Medium-conf single recipient: resolve first WITHOUT writing the
  // Package. Only register when the resolution converges on a known
  // Resident; otherwise fall through to the agent so the holder can
  // disambiguate (and the next inbound's classifier run can hit the
  // high-conf path cleanly).
  if (classification.confidence === "medium") {
    const namedRecipient = classification.recipients[0]!;
    const houseNumber =
      namedRecipient.houseNumber ?? holder?.houseNumber ?? "";
    if (houseNumber === "") {
      return fallthroughClarification("missing-recipient");
    }
    let resolution: RecipientResolution;
    try {
      resolution = await deps.resolveRecipient(namedRecipient.name, houseNumber);
    } catch (err) {
      console.error(
        "[resolveRecipient] (text, medium-conf) failed for recipient",
        namedRecipient.name,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
      return fallthroughClarification("low-conf");
    }
    if (resolution.kind !== "resident") {
      return fallthroughClarification("low-conf");
    }
    // Resolution converges on resident — fall through to the register
    // loop below by treating this as the high-conf path. The loop
    // already handles the 1-recipient case correctly.
  }

  // High-conf (or medium-conf-converged-to-resident): for each
  // recipient, register a Package and dispatch on resolution:
  //   - resident       → group ack + recipient DM
  //   - unknown        → group question (#109)
  //   - known_telegram → silent (Package landed for cron sweep)
  let anyHandled = false;
  for (const namedRecipient of classification.recipients) {
    const recipientHouseNumber =
      namedRecipient.houseNumber ?? holder?.houseNumber ?? "";
    if (recipientHouseNumber === "") {
      // Defensive: schema admits both absent. Single-recipient case
      // was already caught above; in the multi-recipient loop, skip
      // this entry — partial outcome beats abandoning the whole turn.
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
        const language =
          inbound.fromLanguageCode &&
          normaliseLanguageCode(inbound.fromLanguageCode);
        const nudge = buildHolderNotRegisteredNudge(language);
        try {
          await deps.sendDirectMessage(inbound.fromUserId, nudge);
        } catch (dmErr) {
          console.error(
            "[flow1] holder-not-registered nudge DM failed for userId",
            inbound.fromUserId,
            "error:",
            dmErr instanceof Error ? dmErr.message : dmErr,
          );
        }
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
      continue;
    }

    if (registered.recipientResolution.kind === "unknown") {
      // High-conf unknown: post the deterministic group question.
      const question = buildUnknownRecipientGroupQuestion(
        namedRecipient.name,
        holder?.language ?? holderLanguage,
      );
      try {
        emitTrace("dm", "start", { kind: "flow1-unknown-recipient" });
        await deps.sendDirectMessage(inbound.chatId, question);
        emitTrace("dm", "end", { kind: "flow1-unknown-recipient" });
      } catch (err) {
        console.error(
          "[flow1] unknown-recipient group question failed for chatId",
          inbound.chatId,
          "error:",
          err instanceof Error ? err.message : err,
        );
        emitTrace("dm", "error", { kind: "flow1-unknown-recipient" });
      }
      anyHandled = true;
      continue;
    }

    if (registered.recipientResolution.kind !== "resident") {
      // known_telegram: Package row is in Redis for the cron sweep
      // but we have no DM channel to a non-Resident. Stay silent
      // for this recipient.
      emitTrace("flow1", "silent", {
        reason: registered.recipientResolution.kind,
      });
      anyHandled = true;
      continue;
    }

    const recipientDmText = buildRecipientDmText({
      holder: registered.holder,
      recipient: registered.recipientResolution.resident,
    });
    // v2.1 #114: pickup keyboard lives only on the recipient DM now —
    // the group ack is announce-only. Pickup is private business
    // between the recipient and the bot.
    const recipientKeyboard = buildPickupKeyboard(registered.package.id);

    // v2.1 #116 (Slice 3 of #113): same suppression branch as the
    // photo route — when this registration LINKS to a Flow 2
    // ReceptionRequest, the original Flow 2 group post is the
    // announcement; the new "Paket von X an Y" group ack would be
    // redundant noise. DM the holder a private confirmation instead.
    if (registered.receptionRequestFulfilled !== null) {
      await sendFlow1HolderConfirmation({
        deps,
        registered,
        source: "text",
      });
    } else {
      const groupAckText = buildGroupAckText({
        holder: registered.holder,
        recipient: registered.recipientResolution.resident,
      });
      try {
        emitTrace("dm", "start", { kind: "flow1-group-ack" });
        await deps.sendDirectMessage(inbound.chatId, groupAckText);
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
    }

    const recipientChatId = Number(registered.recipientResolution.resident.id);
    if (Number.isFinite(recipientChatId)) {
      try {
        emitTrace("dm", "start", { kind: "flow1-recipient" });
        await deps.sendDirectMessage(
          recipientChatId,
          recipientDmText,
          undefined,
          recipientKeyboard,
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

    anyHandled = true;
  }

  return { kind: anyHandled ? "handled" : "silent" };
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
 * v2.1 #108 (Slice 4 of #105) — channel-deterministic pickup tap.
 * Updated by v2.1 #114 (Slice 1 of #113) to drop the group-card
 * edit and to leave the keyboard intact on non-recipient
 * rejections, since the pickup keyboard now lives only on the
 * recipient's 1:1 DM (the group ack stays announce-only).
 *
 * Resolves the caller via `getRegisteredResident`, dispatches to
 * the lib-level `confirmPickup`, then on success ack + strip the
 * recipient's DM keyboard + DM the holder thanks. `sendToAsh` is
 * NEVER called on this path — the agent does not run on the
 * pickup-tap surface.
 *
 * Error class → toast / keyboard treatment:
 *
 *   - getRegisteredResident throws / returns null (race vs
 *     directory): generic retry toast, keyboard stays live.
 *   - caller resolves to null (unregistered tapper): not-recipient
 *     toast. Keyboard stays live (only path here is a stale
 *     pre-#114 group keyboard; touching it would punish every
 *     other resident's view of that historical message).
 *   - confirmPickup throws `PICKUP_NOT_RECIPIENT`: dedicated
 *     toast only. Same stale-group-keyboard reasoning as the
 *     unregistered branch — do not strip.
 *   - confirmPickup throws `PICKUP_ALREADY_DONE`: dedicated toast
 *     only; keyboard already stripped from the previous success
 *     on the recipient's DM.
 *   - other throw (Redis hiccup): generic retry toast, keyboard
 *     stays live.
 *
 * Ack + strip happen AFTER the lib call (vs before it) so the
 * failure path leaves the keyboard intact on recoverable errors.
 * Same #95 invariant the volunteer-accept handler relies on.
 *
 * sendDirectMessage failures after the lib call succeeded are
 * logged but never raised: the canonical state in Redis is
 * correct, and any DM retry can land separately without
 * re-flipping the package status.
 */
async function handleConfirmPickup(
  cb: TelegramInboundCallback,
  packageId: string,
  deps: ProcessUpdateDeps,
): Promise<Response> {
  if (cb.fromUserId === null) {
    // Defensive: the callback parser populates fromUserId from
    // `callback_query.from.id` which is required by the Bot API.
    // If it's somehow null, the caller can't be scoped — keep the
    // keyboard live and toast generic.
    await deps
      .answerCallback(cb.callbackId, pickupRetryToast(cb.fromLanguageCode))
      .catch(() => undefined);
    return new Response(null, { status: 204 });
  }

  let caller: Resident | null;
  try {
    caller = await deps.getRegisteredResident(cb.fromUserId);
  } catch (err) {
    console.error(
      "[confirm_pickup] getRegisteredResident threw for userId",
      cb.fromUserId,
      "— failing loud (no agent fallback)",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    await deps
      .answerCallback(cb.callbackId, pickupRetryToast(cb.fromLanguageCode))
      .catch(() => undefined);
    return new Response(null, { status: 204 });
  }
  if (!caller) {
    // Pickup taps from unregistered users get the not-recipient
    // toast — an unregistered user is by definition not the
    // recipient of any Package (recipientResidentId would never
    // match). v2.1 #114: do NOT strip the keyboard. The only place
    // the pickup keyboard can land in the new design is the
    // recipient's own DM (a 1:1 chat), and a non-recipient tap
    // arriving here can only come from a stale pre-#114 group
    // keyboard; the recipient's DM keyboard stays for them.
    await deps
      .answerCallback(
        cb.callbackId,
        pickupNotRecipientToast(cb.fromLanguageCode),
      )
      .catch(() => undefined);
    return new Response(null, { status: 204 });
  }

  let result: ConfirmPickupResult;
  emitTrace("flow1", "pickup.start", { packageId });
  try {
    result = await deps.confirmPickup(caller, packageId);
    emitTrace("flow1", "pickup.end", { packageId });
  } catch (err) {
    const errorCode =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    const language = caller.language ?? cb.fromLanguageCode;
    if (errorCode === PICKUP_NOT_RECIPIENT_ERROR_CODE) {
      emitTrace("flow1", "pickup.reject.not-recipient", { packageId });
      await deps
        .answerCallback(cb.callbackId, pickupNotRecipientToast(language))
        .catch(() => undefined);
      // v2.1 #114: do NOT strip the keyboard. With the keyboard
      // living only on the recipient's DM (a 1:1 chat), a
      // non-recipient tap that reaches here can only come from a
      // stale pre-#114 group keyboard — stripping it would punish
      // every other resident's view of that historical message.
      // The recipient's DM keyboard stays untouched.
      return new Response(null, { status: 204 });
    }
    if (errorCode === PICKUP_ALREADY_DONE_ERROR_CODE) {
      emitTrace("flow1", "pickup.reject.already-done", { packageId });
      await deps
        .answerCallback(cb.callbackId, pickupAlreadyDoneToast(language))
        .catch(() => undefined);
      // Keyboard already stripped from the previous success — no
      // further keyboard action needed.
      return new Response(null, { status: 204 });
    }
    console.error(
      "[confirm_pickup] confirmPickup failed for userId",
      cb.fromUserId,
      "packageId",
      packageId,
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow1", "pickup.reject.redis-hiccup", { packageId });
    await deps
      .answerCallback(cb.callbackId, pickupRetryToast(language))
      .catch(() => undefined);
    return new Response(null, { status: 204 });
  }

  // Happy path: status flipped. Ack + strip the keyboard on the
  // recipient's DM (where the tap originated — the only surface
  // that carries the pickup keyboard in v2.1 #114), then DM the
  // holder thanks. Doing the strip AFTER the lib call (vs before)
  // is what makes the failure path above leave the keyboard intact
  // on recoverable errors. The group ack message is left untouched
  // — pickup is private business and the group narration stays at
  // the original "📦 Paket von X an Y." announcement (v2.1 #114).
  await deps.answerCallback(cb.callbackId).catch(() => undefined);
  await deps.stripKeyboard(cb.chatId, cb.messageId).catch(() => undefined);

  // DM the holder thanks (when we can resolve a chat id for them).
  // The holder's `platformId` equals their Telegram user id, which
  // is also the 1:1 chat id for DMs. Skipped when the holder record
  // is unresolvable (de-registered between Slice 1's write and the
  // recipient tapping) — better to omit the thanks than to spam
  // someone else's chat.
  if (result.holder) {
    const holderChatId = Number(result.holder.platformId);
    if (Number.isFinite(holderChatId)) {
      try {
        emitTrace("dm", "start", { kind: "pickup-holder-thanks" });
        await deps.sendDirectMessage(
          holderChatId,
          buildHolderThanksDmText({
            holder: result.holder,
            recipient: result.recipient ?? {
              id: result.package.recipientResidentId ?? "",
              name: result.package.recipientName,
              houseNumber: result.package.recipientHouseNumber,
              language: null,
            },
          }),
        );
        emitTrace("dm", "end", { kind: "pickup-holder-thanks" });
      } catch (err) {
        console.error(
          "[confirm_pickup] holder thanks DM failed for platformId",
          result.holder.platformId,
          "error:",
          err instanceof Error ? err.message : err,
        );
        emitTrace("dm", "error", { kind: "pickup-holder-thanks" });
      }
    } else {
      console.error(
        "[confirm_pickup] holder.platformId is not a finite number — skipping thanks DM",
        { platformId: result.holder.platformId },
      );
    }
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

  // `/start` is Telegram's standard first-contact command (tap-to-start
  // emits it). The deterministic response is the same one-sentence
  // `/register …` usage hint we already send for a bare `/register`.
  // Without this hard-route the inbound falls through to the agent,
  // which (live trace 2026-05-22) emits a welcome wall against
  // instructions.
  if (isStartCommand(inbound.text)) {
    const language = inbound.fromLanguageCode;
    emitTrace("registration", "start", { phase: "start-command" });
    const prompt = buildRegisterUsageHint(language);
    try {
      emitTrace("dm", "start");
      await deps.sendDirectMessage(inbound.chatId, prompt);
      emitTrace("dm", "end");
    } catch (err) {
      console.error(
        "[handleRegistrationDm] /start usage-hint DM failed for chatId",
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
    // v2.1 #107 (Slice 2 of #106): group photo route is now channel-
    // deterministic. On a high-confidence parse_label + registered
    // recipient the channel registers the package, posts the group
    // ack, and DMs the recipient — sendToAsh is NEVER called. Every
    // other branch (low/medium-conf parse, missing recipient,
    // unknown/known_telegram resolution, parse_label outage,
    // getFileUrl failure) stays silent. Slice 3 (#109) will introduce
    // the [FLOW_1 CLARIFICATION] synthetic for the disambiguation
    // cases — until then, silent is the correct interim behaviour.
    const result = await routeGroupPhoto(inbound, inbound.photoFileId, deps);
    if (result.kind === "handled" || result.kind === "silent") {
      return new Response(null, { status: 204 });
    }
    message = result.toAgent;
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
