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
 * Photo path (v2.1 #128): routing is by the unified
 * `parse_package_photo` tool's `kind` discriminator, not chat type. Both
 * branches are fully channel-deterministic — the agent never runs on a
 * photo turn under any condition.
 *
 *   - DM photo → `parse_package_photo` + channel-side routing on `kind`:
 *     - `kind: "shipping_label"` → Flow 1 register (resolve recipient,
 *       call `registerPackage`, post announce-only group ack to the
 *       holder's street group, DM recipient with `[Abgeholt]`). The
 *       privacy-correct entry surface for photo-based Flow 1.
 *     - `kind: "tracking_page"`  → Flow 2 (write `ReceptionRequest`,
 *       send localised ack DM). Same business outcome as the pre-#128
 *       path; the routing signal is `kind` rather than the previous
 *       `absenceSignal === undefined` heuristic.
 *     - `kind: "unknown"`        → 3-path recovery DM (retake label /
 *       type text / `/receive`).
 *
 *   - Group photo → `parse_package_photo` + privacy nudge:
 *     - `kind: "shipping_label"` → DM the SENDER privately with a
 *       nudge ("please send labels to me in DM"). NO Package write,
 *       NO group post. The label PII (recipient name + house number)
 *       must not land in the group; the only correct response is to
 *       redirect the user to DM. The bot has no admin powers to delete
 *       the offending group post.
 *     - `kind: "tracking_page"` / `kind: "unknown"` → silent.
 *
 * The vision tool routes through Vercel AI Gateway with Gemini 3.1
 * Flash Lite as primary and Claude Sonnet 4.6 as fallback. The
 * trade-off (inherited from #107): the vision call no longer lands
 * inside `ash.turn` because the agent never runs on the happy path.
 * Observability lives on the custom OTel spans emitted by `lib/trace.ts`.
 *
 * @see lib/telegram-channel/verify.ts            — header check
 * @see lib/telegram-channel/inbound.ts           — payload → canonical message
 * @see lib/telegram-channel/outbound.ts          — `drainSessionToTelegram`
 * @see lib/telegram-channel/keyboards.ts         — answer + edit Bot API helpers
 * @see agent/tools/parse_package_photo.ts        — unified vision tool (#128)
 */

import type { Session } from "experimental-ash/channels";

import type {
  AcceptReceptionRequestInput,
  AcceptReceptionRequestResult,
  CreateReceptionRequestInput,
  CreateReceptionRequestResult,
} from "../reception-request.js";
import { normaliseLanguageCode } from "../language.js";
import {
  REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE,
  type RecipientResolution,
  type RegisterPackageInput,
  type RegisterPackageResult,
} from "../package.js";
import type { ConfirmPickupResult } from "../pickup.js";
import type {
  Package,
  PackageCarrier,
  ReceptionRequest,
  Resident,
} from "../redis.js";
import { emitTrace } from "../trace.js";
import {
  type RegisterResidentInput,
  type RegisterResidentResult,
} from "../registration.js";

import { buildState } from "./orchestrator/build-state.js";
import { match } from "./orchestrator/match.js";
import { runActions } from "./orchestrator/run-actions.js";
import type { State } from "./orchestrator/state.js";
import {
  buildFlow1ClarificationSynthetic,
  buildGroupAckText,
  buildGroupLabelPrivacyNudge,
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

export type { TelegramChannelState, TelegramSessionAuth, TelegramTriggerKind } from "./types.js";
import type { TelegramChannelState, TelegramSessionAuth, TelegramTriggerKind } from "./types.js";

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
   * Always a plain `string`. Photo turns (DM or group) never invoke
   * `sendToAsh` after v2.1 #128 — the channel branches on the unified
   * vision tool's `kind` and handles every outcome deterministically.
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
   * v2.1 #128: unified vision parser. Wired by the factory to
   * `agent/tools/parse_package_photo.ts`'s `execute({ imageUrl,
   * caption })`. Replaces the pre-#128 `parseLabel` + `parseTrackingPage`
   * split — one LLM call returns a discriminated union on `kind`, the
   * channel branches on that:
   *
   *   - `kind: "shipping_label"` → Flow 1 entry. On a DM photo: register
   *     the package (resolve recipient, call lib `registerPackage`, post
   *     announce-only group ack, DM the recipient with `[Abgeholt]`).
   *     On a group photo: NEVER register — DM the sender a privacy
   *     nudge ("send labels to me directly").
   *   - `kind: "tracking_page"` → Flow 2 entry. On a DM photo: write
   *     `ReceptionRequest` + post group volunteer card. On a group photo:
   *     silent (group photos never go through Flow 2 by design — `/receive`
   *     is the explicit Flow 2 entry).
   *   - `kind: "unknown"`        → DM photo: send the 3-path recovery DM
   *     (retake label / type text / `/receive`). Group photo: silent.
   *
   * Privacy invariant: the routing decision lives in the model output's
   * `kind`. Even if the agent's reasoning is wrong, no Package row lands
   * unless `routeDmPhoto` decided to register based on
   * `kind === "shipping_label"`, and no group post lands ever from a
   * group photo (group photos are now read-only on the bot's side).
   *
   * Throws when the underlying model + fallback both fail — the
   * orchestrator's catch logs the error and sends the deterministic
   * recovery DM on the DM photo path, stays silent on the group photo
   * path.
   */
  readonly parsePackagePhoto: (input: {
    imageUrl: string;
    caption?: string;
  }) => Promise<
    | {
        kind: "shipping_label";
        carrier: PackageCarrier;
        recipientName?: string;
        recipientHouseNumber?: string;
        trackingNumber?: string;
        confidence: "high" | "medium" | "low";
        reason: string;
      }
    | {
        kind: "tracking_page";
        carrier: PackageCarrier;
        trackingNumber?: string;
        expectedWindowStartAt?: string;
        expectedWindowEndAt?: string;
        confidence: "high" | "medium" | "low";
        reason: string;
      }
    | { kind: "unknown"; confidence: "low"; reason: string }
  >;
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
   * v2.1 #121 (Flow 2 → Flow 1 volunteer DM-text early-arrival): list
   * `matched` ReceptionRequests on the caller's street where the caller
   * is the *volunteer* (they tapped `[Ich kann helfen]` on a Flow 2
   * card and the package has now arrived early). Used exclusively by
   * the `flow2-volunteer-early-arrival` DM-text route to resolve
   * "which Flow 2 ask is this volunteer reporting on?" before writing
   * the Package + flipping the request to `fulfilled`.
   *
   * Branching on `[].length`:
   *
   *   - 0 → fall through to the agent. The caller might be a walk-up
   *     holder of an unrelated package; the agent can route to Flow 1
   *     photo onboarding or `register_package`.
   *   - 1 → continue: register the Package, flip the RR, DM both sides.
   *   - 2+ → fall through to the agent. Disambiguation needs a
   *     clarifying question and is not in scope for this slice.
   *
   * Implemented in the factory via `listReceptionRequestsForStreet` +
   * an in-memory filter on `volunteerResidentId === caller.id` +
   * `status === "matched"`. Returns matched-status RRs in arbitrary
   * order — disambiguation only fires on the 2+-match branch which
   * falls through anyway, so ordering doesn't matter on the 1-match
   * happy path.
   *
   * Throws bubble up; the caller catches them and falls through to the
   * agent rather than misregistering a Package.
   */
  readonly listMatchedReceptionRequestsForVolunteer: (
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
   * v2.1 #128: resolve a street identifier to its Telegram group chat id
   * so the DM-photo Flow 1 register branch can post the announce-only
   * group ack to the correct group. The pre-#128 group-photo Flow 1 route
   * used `inbound.chatId` (which IS the group when the inbound came from
   * a group); a DM-initiated Flow 1 register doesn't have that, so it
   * needs an explicit lookup.
   *
   * Single-street MVP: the factory returns
   * `Number(process.env.TELEGRAM_GROUP_CHAT_ID)` regardless of `street`.
   * Multi-street future: per-street map lookup.
   *
   * Returns `null` when the env var is missing or unparseable. The
   * caller treats `null` as "can't post the group ack" — the Package row
   * + recipient DM still land; only the group announcement is skipped.
   */
  readonly streetGroupChatId: (street: string) => number | null;
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
  readonly setTriggerAttribute: (trigger: TelegramTriggerKind) => void;
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
 *                                        agent: never after v2.1 #128
 *                                        (kept in the union so legacy
 *                                        traces still parse).
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
  | "flow2-volunteer-early-arrival"
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

/**
 * v2.1 #135 (Slice 4 of the state-machine refactor umbrella):
 * channel-deterministic callback dispatch lives entirely in the
 * orchestrator engine now. `buildState` pre-calls the lib side
 * effect (`confirmPickup` / `acceptReceptionRequest`) and encodes the
 * outcome as a State variant; `match` returns the action list (ack +
 * keyboard strip + DMs / toasts); `runActions` executes it with the
 * legacy tolerance contract (DM/card/ack/strip swallow errors and
 * keep going). Callback actions that still need the agent
 * (`accept_reception_request` stale, `decline_reception_request`,
 * `remind_later`, unknown) flow through the `callback-agent` variant.
 */
async function dispatchCallback(
  cb: TelegramInboundCallback,
  deps: ProcessUpdateDeps,
): Promise<Response> {
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

  const state = await buildState({ kind: "callback", callback: cb }, deps);
  const { actions } = match(state);
  await runActions(actions, deps);
  return new Response(null, { status: 204 });
}

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

/**
 * v2.1 #128: group photo route — privacy nudge ONLY, never registers.
 *
 * Pre-#128, a shipping-label photo posted to the street group would
 * register the package via the channel-side Flow 1 path. That posted
 * a group ack and DM'd the recipient, which is the right business
 * outcome — but the underlying privacy violation (the label PII landed
 * publicly in the group chat) was baked into the entry surface. #128
 * inverts the policy: Flow 1 registration is now the DM-photo path
 * only. The group photo route exists solely to nudge a misbehaving
 * sender privately.
 *
 * Branches by `kind`:
 *
 *   - `shipping_label` → DM the sender the privacy nudge in their
 *     language. NO Package write, NO group post, NO group ack. The
 *     original group post stays as-is (the bot is not an admin and
 *     can't delete it).
 *   - `tracking_page`  → silent. Tracking pages don't carry recipient
 *     PII but they also don't belong as group public posts; the
 *     deterministic `/receive` slash + DM photo entry are the
 *     supported Flow 2 surfaces.
 *   - `unknown`        → silent. We don't know what was posted; we
 *     don't comment.
 *
 * Failure modes (getFileUrl throw, parse_package_photo throw): silent.
 * The agent is never in the loop on this surface.
 */
async function routeGroupPhoto(
  inbound: TelegramInboundMessage,
  fileId: string,
  deps: ProcessUpdateDeps,
): Promise<Flow1RouteResult> {
  if (inbound.fromUserId === null) {
    // Anonymous group photo (no `from` on the payload) — can't
    // resolve the sender to DM them privately, so stay silent.
    return { kind: "silent" };
  }

  const captionText = inbound.text.length > 0 ? inbound.text : undefined;
  const senderLanguage = inbound.fromLanguageCode
    ? (normaliseLanguageCode(inbound.fromLanguageCode) ?? "de")
    : "de";

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
    return { kind: "silent" };
  }

  let parsed: Awaited<ReturnType<ProcessUpdateDeps["parsePackagePhoto"]>>;
  emitTrace("vision", "start", { tool: "parse_package_photo" });
  try {
    parsed = await deps.parsePackagePhoto({ imageUrl, caption: captionText });
    emitTrace("vision", "end", {
      tool: "parse_package_photo",
      kind: parsed.kind,
      confidence: parsed.confidence,
    });
  } catch (err) {
    console.error(
      "[parse_package_photo] failed (group) for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("vision", "error", { tool: "parse_package_photo" });
    return { kind: "silent" };
  }

  if (parsed.kind !== "shipping_label") {
    // tracking_page / unknown in a group: silent. The bot has nothing
    // to say without leaking either the photo content or the sender's
    // identity-around-a-package.
    emitTrace("flow1", "silent", {
      reason: parsed.kind === "tracking_page" ? "group-tracking-page" : "group-unknown",
      source: "photo",
    });
    return { kind: "silent" };
  }

  // shipping_label in a group — the policy break #128 closes. DM the
  // sender privately with the nudge so they know to send labels in DM
  // next time. Best-effort: a user who has never opened a chat with the
  // bot will refuse the outbound; the channel logs that and the group
  // post is left as-is (no admin powers to delete it).
  const nudge = buildGroupLabelPrivacyNudge(senderLanguage);
  try {
    emitTrace("dm", "start", { kind: "flow1-group-label-privacy-nudge" });
    await deps.sendDirectMessage(inbound.fromUserId, nudge);
    emitTrace("dm", "end", { kind: "flow1-group-label-privacy-nudge" });
  } catch (err) {
    console.error(
      "[flow1] group-label privacy nudge DM failed for userId",
      inbound.fromUserId,
      "error:",
      err instanceof Error ? err.message : err,
    );
    emitTrace("dm", "error", { kind: "flow1-group-label-privacy-nudge" });
  }
  return { kind: "silent" };
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
    return dispatchCallback(callback, deps);
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

  // v2.1 Slice 3+4+5 (#134/#135/#136): DM paths (registration, photo, text,
  // /receive) all flow through the state-machine engine. buildState
  // pre-computes the routing context (resident lookup, classifier verdict,
  // vision parse, mutation outcomes per ADR D3 amendment), match dispatches
  // on the resulting State variant, and runActions executes the action list
  // — emitting the agent SendToAsh action when the engine deems the inbound
  // a fallthrough.
  //
  // Only group photos and group text still go through the legacy dispatcher
  // (Slice 6 / #137).
  if (!inbound.isGroup) {
    try {
      const state: State = await buildState(
        { kind: "dm", message: inbound },
        deps,
      );
      const { actions } = match(state);
      await runActions(actions, deps);
      return new Response(null, { status: 204 });
    } catch (err) {
      // Runner Tier 2 actions (registerResident from
      // register-and-confirm-resident) rethrow on failure. The deleted
      // handleRegistrationDm + legacy DM routes also fell through to the
      // agent on Redis hiccups — preserve that fallback by handing the
      // raw text to sendToAsh after logging the diagnostic. Tier 2
      // mutations on the photo/text/receive paths live in buildState now
      // (ADR D3 amendment), so any throw here is structural (a registration
      // runner failure or an unhandled error inside the engine).
      console.error(
        "[process-update] registration runActions failed for chatId",
        inbound.chatId,
        "userId",
        inbound.fromUserId,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
      // Fall through to the agent with raw text — same fallback the deleted
      // handleRegistrationDm used on registerResident failure.
      deps.setTriggerAttribute?.("telegram.text-dm");
      emitTrace("agent", "start", { trigger: "telegram.text-dm" });
      const session = await deps.sendToAsh(inbound.text, {
        auth,
        continuationToken,
        state: {
          chatId: inbound.chatId,
          isGroup: inbound.isGroup,
          fromUserId: inbound.fromUserId,
          fromLanguageCode: inbound.fromLanguageCode,
        },
      });
      deps.waitUntil(deps.drainSession(session, inbound.chatId));
      return new Response(null, { status: 204 });
    }
  }

  // Group routes (Slice 6 / #137 — still in legacy dispatcher).
  let message: string;
  let trigger: TelegramTriggerKind;
  if (inbound.photoFileId !== null) {
    // v2.1 #128: group photo route is privacy-nudge only — on
    // `kind: "shipping_label"` the channel DMs the sender to send labels
    // in DM next time; on every other kind (tracking_page, unknown) and
    // on any vision/getFileUrl failure the route stays silent. NO
    // registration, NO group post. The agent never runs on a group
    // photo.
    const result = await routeGroupPhoto(inbound, inbound.photoFileId, deps);
    if (result.kind === "handled" || result.kind === "silent") {
      return new Response(null, { status: 204 });
    }
    message = result.toAgent;
    trigger = "telegram.photo";
  } else {
    // v2.1 #106 Slice 1: group text classifier-deterministic register.
    const result = await routeGroupTextThroughClassifier(inbound, deps);
    if (result.kind === "handled" || result.kind === "silent") {
      return new Response(null, { status: 204 });
    }
    message = result.toAgent;
    trigger = "telegram.group";
  }

  // v2.1 #99: attribute the post-routing inbound shape onto the active
  // OTel span so Agent Runs shows what fired this turn. The Trigger
  // column populates whenever the channel hands a message to the
  // agent — channel-deterministic paths (Flow 2 entries, registration,
  // volunteer-accept) return earlier and never reach this line.
  deps.setTriggerAttribute(trigger);

  // #102 live diagram: the AGENT box only lights on these fallthrough
  // paths — Flow 2 entries, registration, volunteer-accept all return
  // earlier. This is the structural invariant v2.1 enforces.
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
