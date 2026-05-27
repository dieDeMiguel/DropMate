import {
  ACCEPT_DIFFERENT_STREET_ERROR_CODE,
  ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE,
  type AcceptReceptionRequestResult,
  type CreateReceptionRequestInput,
  type CreateReceptionRequestResult,
} from "../../reception-request.js";
import {
  PICKUP_ALREADY_DONE_ERROR_CODE,
  PICKUP_NOT_RECIPIENT_ERROR_CODE,
  type ConfirmPickupResult,
} from "../../pickup.js";
import {
  REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE,
  type RecipientResolution,
  type RegisterPackageInput,
  type RegisterPackageResult,
} from "../../package.js";
import type { Package, PackageCarrier, ReceptionRequest, Resident } from "../../redis.js";
import {
  isStartCommand,
  isRegisterCommand,
  parseFreeTextRegistration,
} from "../../registration.js";
import {
  isReceiveCommand,
  parseReceiveCommand,
} from "../../slash-command.js";
import { normaliseLanguageCode } from "../../language.js";
import { emitTrace } from "../../trace.js";
import {
  buildFlow1ClarificationSynthetic,
  captionLooksLikeMultiRecipient,
  type Flow1ClarificationReason,
} from "../flow-1-dms.js";
import type { TelegramInboundMessage } from "../inbound.js";
import type {
  ClassifierVerdict,
  GroupClassifierVerdict,
  GroupTextOutcome,
  State,
  VisionVerdict,
} from "./state.js";
import type { Inbound } from "./event.js";

/**
 * Dependencies the `buildState` I/O orchestrator needs.
 *
 * These mirror the relevant fields on `ProcessUpdateDeps` so the
 * factory can wire the same dep handles. Defined here rather than
 * importing from the legacy dispatcher so the orchestrator module
 * stays decoupled from `process-update.ts`.
 */
export interface BuildStateDeps {
  readonly getRegisteredResident: (userId: number) => Promise<Resident | null>;
  readonly isRegisteredResident: (userId: number) => Promise<boolean>;
  readonly confirmPickup: (
    caller: Resident,
    packageId: string,
  ) => Promise<ConfirmPickupResult>;
  readonly acceptReceptionRequest: (
    caller: Resident,
    input: { readonly requestId?: string; readonly availability?: string },
  ) => Promise<AcceptReceptionRequestResult>;
  readonly parsePackagePhoto: (input: {
    imageUrl: string;
    caption?: string;
  }) => Promise<VisionVerdict>;
  readonly getFileUrl: (fileId: string) => Promise<string>;
  readonly classifyDmIntent: (input: {
    text: string;
    languageHint?: string;
  }) => Promise<ClassifierVerdict>;
  readonly classifyGroupMessage: (input: {
    text: string;
    languageHint?: string;
  }) => Promise<GroupClassifierVerdict>;
  // v2.1 #106 Slice 1: channel-side handle for the lib-level
  // `registerPackage`. Per ADR D3 amendment, `buildState` calls this for
  // each high-conf (or medium-resolved) recipient so the per-recipient
  // outcome (resident / unknown / known_telegram / holder-not-registered
  // / other error) is encoded as a `GroupTextOutcome` for `match` to
  // dispatch on without re-reading the registration result.
  readonly registerPackage: (
    holder: Resident | null,
    input: RegisterPackageInput,
  ) => Promise<RegisterPackageResult>;
  readonly createReceptionRequest: (
    caller: Resident,
    input: CreateReceptionRequestInput,
  ) => Promise<CreateReceptionRequestResult>;
  // v2.1 #109: pure recipient-resolution lookup, no Package write. Used
  // by `buildGroupTextState` at medium-conf single-recipient verdicts to
  // decide whether to register (resolution → resident) or fall through
  // to the agent (resolution → unknown / known_telegram).
  readonly resolveRecipient: (
    recipientName: string,
    recipientHouseNumber: string,
  ) => Promise<RecipientResolution>;
  readonly listOpenPackagesForRecipient: (
    caller: Resident,
  ) => Promise<readonly Package[]>;
  readonly listMatchedReceptionRequestsForRequester: (
    caller: Resident,
  ) => Promise<readonly ReceptionRequest[]>;
  readonly listMatchedReceptionRequestsForVolunteer: (
    caller: Resident,
  ) => Promise<readonly ReceptionRequest[]>;
  readonly getResidentByPlatformId: (
    platformId: string,
  ) => Promise<Resident | null>;
  readonly streetGroupChatId: (street: string) => number | null;
}

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
 * Compose the agent-bound synthetic message for callback actions that
 * still fall through to `sendToAsh` (decline / remind / unknown).
 *
 * `confirm_pickup` + `accept_reception_group` are channel-deterministic
 * (own callback-pickup-* / callback-accept-* state variants). Slice 7
 * (#138) deleted the legacy `accept_reception_request` (DM-3 button — the
 * backing tool was hard-deleted by v2.1 Slice 5 / #90) and the malformed
 * `accept_reception_group` fallback cases from this switch — those are
 * cold paths whose stale-keyboard cases hit the generic default arm.
 *
 * Kept in English regardless of the user's language: the agent's
 * system prompt + the user's stored `Resident.language` drive the
 * *reply* localisation. The synthetic itself is internal scaffolding
 * the user never sees.
 */
function synthesizeAgentSynthetic(parsed: ParsedCallbackData): string {
  switch (parsed.action) {
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
 * Build a `callback-pickup-*` State variant for a `confirm_pickup:<packageId>`
 * tap. Resolves the caller, calls `confirmPickup`, and encodes the
 * outcome:
 *
 *   - caller unregistered / lookup hiccup → `callback-pickup-unregistered`
 *     (same toast as not-recipient — an unregistered user can't be the
 *     recipient of any Package).
 *   - confirmPickup throws `PICKUP_NOT_RECIPIENT` → `callback-pickup-not-recipient`.
 *   - confirmPickup throws `PICKUP_ALREADY_DONE`  → `callback-pickup-already-done`.
 *   - any other throw                              → `callback-pickup-error`.
 *   - success                                       → `callback-pickup` (carries
 *     the `ConfirmPickupResult` for the holder thanks DM).
 *
 * Emits `flow1.pickup.start/end/error` traces in lockstep with the lib
 * call so the trace topology stays identical to the legacy handler.
 */
async function buildCallbackPickupState(
  inbound: Inbound & { kind: "callback" },
  packageId: string,
  deps: BuildStateDeps,
): Promise<State> {
  const cb = inbound.callback;

  let caller: Resident | null;
  try {
    caller = await deps.getRegisteredResident(cb.fromUserId);
  } catch (err) {
    console.error(
      "[orchestrator/callback-pickup] getRegisteredResident threw for userId",
      cb.fromUserId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    // Redis hiccup is recoverable — retry toast + keyboard stays
    // live. Distinguished from the null-resident branch below (which
    // is a deterministic "you can't be the recipient" rejection).
    return {
      kind: "callback-pickup-error",
      inbound: cb,
      language: cb.fromLanguageCode,
    };
  }
  if (!caller) {
    return { kind: "callback-pickup-unregistered", inbound: cb };
  }

  emitTrace("flow1", "pickup.start", { packageId });
  try {
    const result = await deps.confirmPickup(caller, packageId);
    emitTrace("flow1", "pickup.end", { packageId });
    return { kind: "callback-pickup", inbound: cb, caller, result };
  } catch (err) {
    const errorCode =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (errorCode === PICKUP_NOT_RECIPIENT_ERROR_CODE) {
      emitTrace("flow1", "pickup.reject.not-recipient", { packageId });
      return { kind: "callback-pickup-not-recipient", inbound: cb, caller };
    }
    if (errorCode === PICKUP_ALREADY_DONE_ERROR_CODE) {
      emitTrace("flow1", "pickup.reject.already-done", { packageId });
      return { kind: "callback-pickup-already-done", inbound: cb, caller };
    }
    console.error(
      "[orchestrator/callback-pickup] confirmPickup failed for userId",
      cb.fromUserId,
      "packageId",
      packageId,
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow1", "pickup.reject.redis-hiccup", { packageId });
    return {
      kind: "callback-pickup-error",
      inbound: cb,
      language: caller.language ?? cb.fromLanguageCode,
    };
  }
}

/**
 * Build a `callback-accept-*` State variant for an
 * `accept_reception_group:<requestId>` tap. Gates on
 * `isRegisteredResident` (matches the legacy precheck — a thrown
 * lookup is treated as unregistered), resolves the volunteer's full
 * Resident, calls `acceptReceptionRequest`, and dispatches on the
 * outcome:
 *
 *   - gate rejects / lookup throws       → `callback-accept-unregistered`
 *   - resident-lookup race (null result) → `callback-accept-error`
 *   - acceptReceptionRequest throws
 *     `ACCEPT_RECEPTION_SELF_NOT_ALLOWED` → `callback-accept-self`
 *   - acceptReceptionRequest throws
 *     `ACCEPT_DIFFERENT_STREET`           → `callback-accept-cross-street`
 *   - any other throw                     → `callback-accept-error`
 *   - success                              → `callback-accept` (carries
 *     the `AcceptReceptionRequestResult` for the card edit + two DMs).
 *
 * Emits `flow2.accept.start/end/reject.*` traces in lockstep with the
 * lib call.
 */
async function buildCallbackAcceptState(
  inbound: Inbound & { kind: "callback" },
  requestId: string,
  deps: BuildStateDeps,
): Promise<State> {
  const cb = inbound.callback;

  const registered = await deps
    .isRegisteredResident(cb.fromUserId)
    .catch(() => false);
  if (!registered) {
    return { kind: "callback-accept-unregistered", inbound: cb };
  }

  let volunteer: Resident | null;
  try {
    volunteer = await deps.getRegisteredResident(cb.fromUserId);
  } catch (err) {
    console.error(
      "[orchestrator/callback-accept] getRegisteredResident threw for userId",
      cb.fromUserId,
      "after passing the isRegisteredResident gate — failing loud (no agent fallback)",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    // The volunteer's Resident record is unavailable, so the toast
    // falls back to cb.fromLanguageCode.
    return {
      kind: "callback-accept-error",
      inbound: cb,
      language: cb.fromLanguageCode,
    };
  }
  if (!volunteer) {
    console.error(
      "[orchestrator/callback-accept] getRegisteredResident returned null for userId",
      cb.fromUserId,
      "after passing the isRegisteredResident gate (race or Redis hiccup) — failing loud (no agent fallback)",
    );
    return {
      kind: "callback-accept-error",
      inbound: cb,
      language: cb.fromLanguageCode,
    };
  }

  emitTrace("flow2", "accept.start");
  try {
    const result = await deps.acceptReceptionRequest(volunteer, { requestId });
    emitTrace("flow2", "accept.end");
    return { kind: "callback-accept", inbound: cb, volunteer, result };
  } catch (err) {
    const errorCode =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (errorCode === ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE) {
      emitTrace("flow2", "reject.self");
      return { kind: "callback-accept-self", inbound: cb, volunteer };
    }
    if (errorCode === ACCEPT_DIFFERENT_STREET_ERROR_CODE) {
      emitTrace("flow2", "reject.cross-street");
      return { kind: "callback-accept-cross-street", inbound: cb, volunteer };
    }
    console.error(
      "[orchestrator/callback-accept] acceptReceptionRequest failed for userId",
      cb.fromUserId,
      "requestId",
      requestId,
      "— failing loud (no agent fallback)",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow2", "reject.redis-hiccup", { stage: "accept" });
    return {
      kind: "callback-accept-error",
      inbound: cb,
      language: volunteer.language ?? cb.fromLanguageCode,
    };
  }
}

// ---------------------------------------------------------------------------
// DM photo — v2.1 #128 + Slice 5 (#136)
//
// `buildState` owns the full Flow 1 register / Flow 2 create / VLC dispatch
// because the routing decisions depend on the side-effect outcomes (ADR D3
// amendment): match needs to know whether `registerPackage` threw
// `HOLDER_NOT_REGISTERED`, whether the recipient resolved to a Resident, etc.
//
// Trace stage names mirror what the runner's auto-trace would emit
// (`vision.start/end/error`, `flow1.register.start/end/error`, etc.). ADR D4
// amendment: stage names are the contract; emit location is implementation
// detail. No `buildState.*` namespace.
// ---------------------------------------------------------------------------

function parseIsoToUnixMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Run the unified vision tool on a DM photo. Owns the
 * `vision.start/end/error` trace topology so callers downstream can rely on
 * the same shape the runner's auto-trace would have emitted.
 *
 * Returns `null` when `getFileUrl` throws — the caller treats that as the
 * "VLC recovery DM" path (same legacy behaviour).
 */
async function parseDmPhoto(
  inbound: TelegramInboundMessage,
  fileId: string,
  deps: BuildStateDeps,
): Promise<VisionVerdict | null> {
  const captionText = inbound.text.length > 0 ? inbound.text : undefined;

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
    return null;
  }

  emitTrace("vision", "start", { tool: "parse_package_photo" });
  try {
    const parsed = await deps.parsePackagePhoto({ imageUrl, caption: captionText });
    emitTrace("vision", "end", {
      tool: "parse_package_photo",
      kind: parsed.kind,
      confidence: parsed.confidence,
    });
    return parsed;
  } catch (err) {
    console.error(
      "[parse_package_photo] failed for chatId",
      inbound.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("vision", "error", { tool: "parse_package_photo" });
    return null;
  }
}

/**
 * Build the `dm-photo-flow1-*` State variant for a DM shipping-label photo.
 * Mirrors the pre-Slice-5 `routeDmPhotoShippingLabel` + `routeDmPhotoFlow1Register`
 * branch table.
 */
async function buildDmPhotoShippingLabelState(
  inbound: TelegramInboundMessage,
  parsed: VisionVerdict & { kind: "shipping_label" },
  languageHint: string,
  deps: BuildStateDeps,
): Promise<State> {
  if (inbound.fromUserId === null) {
    emitTrace("flow1", "silent", { reason: "anonymous", source: "dm-photo" });
    return { kind: "dm-photo-vlc", inbound, language: languageHint };
  }

  const holder = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);
  const holderLanguage = holder?.language ?? languageHint;

  if (parsed.confidence === "low") {
    emitTrace("flow1", "fallthrough", { reason: "low-conf", source: "dm-photo" });
    return { kind: "dm-photo-vlc", inbound, language: holderLanguage };
  }

  if (!parsed.recipientName) {
    emitTrace("flow1", "fallthrough", {
      reason: "missing-recipient",
      source: "dm-photo",
    });
    return { kind: "dm-photo-vlc", inbound, language: holderLanguage };
  }

  const recipientHouseNumber =
    parsed.recipientHouseNumber ?? holder?.houseNumber ?? "";
  if (recipientHouseNumber === "") {
    emitTrace("flow1", "fallthrough", {
      reason: "missing-recipient",
      source: "dm-photo",
    });
    return { kind: "dm-photo-vlc", inbound, language: holderLanguage };
  }

  if (parsed.confidence === "medium") {
    let resolution: RecipientResolution;
    try {
      resolution = await deps.resolveRecipient(
        parsed.recipientName,
        recipientHouseNumber,
      );
    } catch (err) {
      console.error(
        "[resolveRecipient] (dm-photo, medium-conf) failed for recipient",
        parsed.recipientName,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
      return { kind: "dm-photo-vlc", inbound, language: holderLanguage };
    }
    if (resolution.kind !== "resident") {
      emitTrace("flow1", "fallthrough", {
        reason: "low-conf",
        source: "dm-photo",
      });
      return { kind: "dm-photo-vlc", inbound, language: holderLanguage };
    }
  }

  // High-conf, or medium-conf-converged-to-resident: register the Package.
  emitTrace("flow1", "register.start", {
    recipient: parsed.recipientName,
    source: "dm-photo",
  });
  let registered: RegisterPackageResult;
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
      source: "dm-photo",
    });
  } catch (err) {
    const errorCode =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (errorCode === REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE) {
      emitTrace("flow1", "reject.holder-not-registered", { source: "dm-photo" });
      return {
        kind: "dm-photo-flow1-holder-not-registered",
        inbound,
        language: inbound.fromLanguageCode,
      };
    }
    console.error(
      "[register_package] (dm-photo) failed for holder",
      inbound.fromUserId,
      "recipient",
      parsed.recipientName,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow1", "register.error", { source: "dm-photo" });
    return { kind: "dm-photo-vlc", inbound, language: holderLanguage };
  }

  const groupChatId = holder ? deps.streetGroupChatId(holder.street) : null;
  const resolutionKind = registered.recipientResolution.kind;

  if (resolutionKind === "resident") {
    return {
      kind: "dm-photo-flow1-resident",
      inbound,
      result: registered,
      groupChatId,
    };
  }

  if (resolutionKind === "unknown" && groupChatId !== null) {
    return {
      kind: "dm-photo-flow1-unknown",
      inbound,
      recipientName: parsed.recipientName,
      holderLanguage: holder?.language ?? languageHint,
      groupChatId,
    };
  }

  // known_telegram OR (unknown + null group chat id): Package row landed,
  // no DM channel to drive — stay silent.
  emitTrace("flow1", "silent", {
    reason: resolutionKind,
    source: "dm-photo",
  });
  return {
    kind: "dm-photo-flow1-silent",
    inbound,
    reason: resolutionKind === "known_telegram" ? "known_telegram" : "unknown",
  };
}

/**
 * Build the `dm-photo-flow2-*` State variant for a DM tracking-page photo.
 * Mirrors the pre-Slice-5 `routeDmPhotoTrackingPage`.
 */
async function buildDmPhotoTrackingPageState(
  inbound: TelegramInboundMessage,
  parsed: VisionVerdict & { kind: "tracking_page" },
  languageHint: string,
  deps: BuildStateDeps,
): Promise<State> {
  if (parsed.confidence !== "high" || inbound.fromUserId === null) {
    emitTrace("flow2", "vlc", { reason: "low-confidence" });
    return { kind: "dm-photo-vlc", inbound, language: languageHint };
  }

  const caller = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);
  if (!caller) {
    emitTrace("flow2", "vlc", { reason: "unregistered" });
    return { kind: "dm-photo-vlc", inbound, language: languageHint };
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
    return { kind: "dm-photo-vlc", inbound, language: callerLanguage };
  }

  return { kind: "dm-photo-flow2-created", inbound, language: callerLanguage };
}

async function buildDmPhotoState(
  inbound: TelegramInboundMessage,
  fileId: string,
  deps: BuildStateDeps,
): Promise<State> {
  const languageHint = inbound.fromLanguageCode ?? "de";
  const parsed = await parseDmPhoto(inbound, fileId, deps);
  if (parsed === null) {
    return { kind: "dm-photo-vlc", inbound, language: languageHint };
  }

  if (parsed.kind === "unknown") {
    emitTrace("flow2", "vlc", { reason: "vision-unknown" });
    return { kind: "dm-photo-vlc", inbound, language: languageHint };
  }

  if (parsed.kind === "tracking_page") {
    return buildDmPhotoTrackingPageState(inbound, parsed, languageHint, deps);
  }

  // parsed.kind === "shipping_label"
  return buildDmPhotoShippingLabelState(inbound, parsed, languageHint, deps);
}

// ---------------------------------------------------------------------------
// DM text — Slice 5 (#136). Welcome-wall fix lives in the medium/low-conf
// branch: registered + classifier-medium/low → bounded VLC DM, NEVER agent.
// ---------------------------------------------------------------------------

async function buildDmTextPickupConfirmationState(
  inbound: TelegramInboundMessage,
  caller: Resident,
  language: string,
  deps: BuildStateDeps,
): Promise<State> {
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
    return { kind: "dm-text-pickup-retry", inbound, language };
  }

  if (open.length === 0) {
    let matched: readonly ReceptionRequest[] = [];
    try {
      matched = await deps.listMatchedReceptionRequestsForRequester(caller);
    } catch (err) {
      console.error(
        "[flow1-pickup-dm] listMatchedReceptionRequestsForRequester failed for userId",
        inbound.fromUserId,
        "error:",
        err instanceof Error ? err.message : err,
      );
    }

    if (matched.length > 0) {
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
      return { kind: "dm-text-pickup-waiting", inbound, language, volunteerName };
    }

    return { kind: "dm-text-pickup-no-open", inbound, language };
  }

  if (open.length > 1) {
    return { kind: "dm-text-pickup-multiple", inbound, language };
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
      return { kind: "dm-text-pickup-already-done", inbound, language };
    }
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
    return { kind: "dm-text-pickup-retry", inbound, language };
  }

  return { kind: "dm-text-pickup-confirmed", inbound, language, result };
}

async function buildDmTextVolunteerEarlyArrivalState(
  inbound: TelegramInboundMessage,
  caller: Resident,
  language: string,
  classifierCarrier: PackageCarrier | undefined,
  deps: BuildStateDeps,
): Promise<State> {
  let matchedAsVolunteer: readonly ReceptionRequest[];
  try {
    matchedAsVolunteer =
      await deps.listMatchedReceptionRequestsForVolunteer(caller);
  } catch (err) {
    console.error(
      "[flow2-volunteer-early-arrival] listMatchedReceptionRequestsForVolunteer failed for userId",
      inbound.fromUserId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    return { kind: "dm-text-agent", inbound };
  }

  if (matchedAsVolunteer.length === 0) {
    return { kind: "dm-text-agent", inbound };
  }
  if (matchedAsVolunteer.length > 1) {
    return { kind: "dm-text-agent", inbound };
  }

  const req = matchedAsVolunteer[0]!;
  const carrier: PackageCarrier =
    classifierCarrier && classifierCarrier !== "unknown"
      ? classifierCarrier
      : req.carrier && req.carrier !== "unknown"
        ? req.carrier
        : "unknown";

  emitTrace("flow1", "register.start", {
    source: "flow2-volunteer-early-arrival",
    requestId: req.id,
  });
  let registered: RegisterPackageResult;
  try {
    registered = await deps.registerPackage(caller, {
      recipientName: req.requesterName,
      recipientHouseNumber: req.requesterHouseNumber,
      carrier,
    });
    emitTrace("flow1", "register.end", {
      source: "flow2-volunteer-early-arrival",
      requestId: req.id,
      packageId: registered.package.id,
    });
  } catch (err) {
    console.error(
      "[flow2-volunteer-early-arrival] registerPackage failed for userId",
      inbound.fromUserId,
      "requestId",
      req.id,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("flow1", "register.reject.redis-hiccup", {
      source: "flow2-volunteer-early-arrival",
      requestId: req.id,
    });
    return { kind: "dm-text-volunteer-early-arrival-retry", inbound, language };
  }

  return {
    kind: "dm-text-volunteer-early-arrival",
    inbound,
    language,
    result: registered,
    req,
  };
}

async function buildDmTextState(
  inbound: TelegramInboundMessage,
  deps: BuildStateDeps,
): Promise<State> {
  if (inbound.fromUserId === null) {
    return { kind: "dm-text-agent", inbound };
  }

  let classification: ClassifierVerdict;
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
    return { kind: "dm-text-agent", inbound };
  }

  const caller = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);
  if (!caller) {
    // Unregistered users fall through to the agent regardless of intent.
    // The welcome-wall fix only protects REGISTERED users — an unregistered
    // user's "real" intent is /register, which the agent can prompt for.
    return { kind: "dm-text-agent", inbound };
  }

  const language = caller.language ?? inbound.fromLanguageCode ?? "de";

  // Welcome-wall fix (#136): medium/low-confidence on a registered resident
  // → bounded VLC DM, NEVER agent. Closes the v2 regression class
  // structurally — the agent has no output channel on this branch.
  if (classification.confidence !== "high") {
    emitTrace("flow2", "vlc", { reason: "classifier-low-conf" });
    return { kind: "dm-text-vlc", inbound, language };
  }

  if (classification.kind === "pickup-confirmation") {
    return buildDmTextPickupConfirmationState(inbound, caller, language, deps);
  }

  if (classification.kind === "flow2-volunteer-early-arrival") {
    return buildDmTextVolunteerEarlyArrivalState(
      inbound,
      caller,
      language,
      classification.carrier,
      deps,
    );
  }

  if (classification.kind !== "flow2-reception") {
    // High-conf "other" / "registration" — fall through to the agent.
    return { kind: "dm-text-agent", inbound };
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
    return { kind: "dm-text-agent", inbound };
  }

  return { kind: "dm-text-flow2-reception-created", inbound, language };
}

// ---------------------------------------------------------------------------
// `/receive` slash command — Slice 5 (#136).
// ---------------------------------------------------------------------------

async function buildDmReceiveCmdState(
  inbound: TelegramInboundMessage,
  deps: BuildStateDeps,
): Promise<State> {
  if (inbound.fromUserId === null) {
    return { kind: "dm-receive-cmd-agent", inbound };
  }

  const caller = await deps
    .getRegisteredResident(inbound.fromUserId)
    .catch(() => null);
  if (!caller) {
    return { kind: "dm-receive-cmd-agent", inbound };
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
    return { kind: "dm-receive-cmd-agent", inbound };
  }

  const language = caller.language ?? inbound.fromLanguageCode ?? "de";
  return { kind: "dm-receive-cmd-created", inbound, language };
}

/**
 * Build a `group-photo` State variant for a group inbound carrying a
 * photo. Anonymous group photos are filtered out by the dispatch above;
 * here we know `inbound.fromUserId !== null`. Fans out
 * `getRegisteredResident` + `getFileUrl` → `parsePackagePhoto`, then
 * encodes the outcome:
 *
 *   - vision threw / getFileUrl threw  → `group-silent` (no nudge, no
 *     register; legacy `routeGroupPhoto` stayed silent on both failure
 *     modes).
 *   - vision.kind !== "shipping_label" → `group-silent` (#128: tracking_page
 *     / unknown in a group never trigger the agent).
 *   - vision.kind === "shipping_label" → `group-photo-nudge` (the
 *     privacy nudge case; `match` emits the DM).
 *
 * `flow1.silent` traces fire here for the tracking_page / unknown
 * branches to mirror the legacy `routeGroupPhoto` shape.
 */
async function buildGroupPhotoState(
  msg: TelegramInboundMessage,
  photoFileId: string,
  deps: BuildStateDeps,
): Promise<State> {
  const fromUserId = msg.fromUserId!;
  const captionText = msg.text.length > 0 ? msg.text : undefined;

  let imageUrl: string;
  try {
    imageUrl = await deps.getFileUrl(photoFileId);
  } catch (err) {
    console.error(
      "[parse_photo] getFileUrl failed (group) for chatId",
      msg.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    return { kind: "group-silent", inbound: msg };
  }

  let vision: VisionVerdict;
  emitTrace("vision", "start", { tool: "parse_package_photo" });
  try {
    vision = await deps.parsePackagePhoto({ imageUrl, caption: captionText });
    emitTrace("vision", "end", {
      tool: "parse_package_photo",
      kind: vision.kind,
      confidence: vision.confidence,
    });
  } catch (err) {
    console.error(
      "[parse_package_photo] failed (group) for chatId",
      msg.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("vision", "error", { tool: "parse_package_photo" });
    return { kind: "group-silent", inbound: msg };
  }

  if (vision.kind !== "shipping_label") {
    emitTrace("flow1", "silent", {
      reason: vision.kind === "tracking_page" ? "group-tracking-page" : "group-unknown",
      source: "photo",
    });
    return { kind: "group-silent", inbound: msg };
  }

  return {
    kind: "group-photo-nudge",
    inbound: msg,
    senderUserId: fromUserId,
    senderLanguageCode: msg.fromLanguageCode,
  };
}

/**
 * Build a group-text State variant. Mirrors the legacy
 * `routeGroupTextThroughClassifier` dispatch table (#106 Slice 1 +
 * #109 Slice 3):
 *
 *   - classifier outage              → `group-silent`
 *   - !isPackageRegistration         → `group-silent`
 *   - 0 recipients                   → `group-text-clarification` (missing-recipient)
 *   - low-conf                       → `group-text-clarification` (low-conf or ambiguous-multi)
 *   - medium-conf + 2+ recipients    → `group-text-clarification` (ambiguous-multi)
 *   - medium-conf + missing house    → `group-text-clarification` (missing-recipient)
 *   - medium-conf + non-resident res → `group-text-clarification` (low-conf)
 *   - high-conf / medium-resolved:
 *       - registerPackage loop:
 *           - holder-not-registered  → `group-text-holder-not-registered`
 *           - other error            → outcome `register-error`
 *           - success                → outcome `resident` / `unknown` / `known-telegram`
 *       → `group-text-registered`
 *
 * `flow1.register.start/end/error` + `flow1.reject.*` + `flow1.silent`
 * traces fire here in lockstep with the lib calls — stage names are
 * identical to what the runner's auto-trace would have emitted for an
 * `Action.registerPackage`, per ADR D4 amendment.
 */
async function buildGroupTextState(
  msg: TelegramInboundMessage,
  deps: BuildStateDeps,
): Promise<State> {
  const fromUserId = msg.fromUserId!;

  const holderLanguage = msg.fromLanguageCode
    ? (normaliseLanguageCode(msg.fromLanguageCode) ?? "de")
    : "de";

  let classification: GroupClassifierVerdict;
  emitTrace("classifier", "start", { flow: "flow1" });
  try {
    classification = await deps.classifyGroupMessage({
      text: msg.text,
      languageHint: msg.fromLanguageCode ?? undefined,
    });
    emitTrace("classifier", "end", {
      flow: "flow1",
      isPackageRegistration: classification.isPackageRegistration,
      confidence: classification.confidence,
    });
  } catch (err) {
    console.error(
      "[classify_group_message] failed for chatId",
      msg.chatId,
      "error:",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    emitTrace("classifier", "error", { flow: "flow1" });
    return { kind: "group-silent", inbound: msg };
  }

  if (!classification.isPackageRegistration) {
    return { kind: "group-silent", inbound: msg };
  }

  const holder = await deps
    .getRegisteredResident(fromUserId)
    .catch(() => null);

  function clarification(reason: Flow1ClarificationReason): State {
    emitTrace("flow1", "fallthrough", { reason, source: "text" });
    return {
      kind: "group-text-clarification",
      inbound: msg,
      synthetic: buildFlow1ClarificationSynthetic({
        language: holder?.language ?? holderLanguage,
        reason,
        source: "text",
        carrier: classification.carrier,
        recipientName: classification.recipients[0]?.name,
        confidence: classification.confidence,
        caption: msg.text,
        holderName: holder?.name,
        holderHouseNumber: holder?.houseNumber,
      }),
    };
  }

  if (classification.recipients.length === 0) {
    return clarification("missing-recipient");
  }

  if (classification.confidence === "low") {
    return clarification(
      classification.recipients.length >= 2 ||
        captionLooksLikeMultiRecipient(msg.text)
        ? "ambiguous-multi"
        : "low-conf",
    );
  }

  if (
    classification.confidence === "medium" &&
    classification.recipients.length > 1
  ) {
    return clarification("ambiguous-multi");
  }

  if (classification.confidence === "medium") {
    // Medium-conf single recipient: resolve first WITHOUT writing.
    const namedRecipient = classification.recipients[0]!;
    const houseNumber = namedRecipient.houseNumber ?? holder?.houseNumber ?? "";
    if (houseNumber === "") {
      return clarification("missing-recipient");
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
      return clarification("low-conf");
    }
    if (resolution.kind !== "resident") {
      return clarification("low-conf");
    }
    // Resolution converges on a Resident — fall through to the
    // registration loop with the loop treating this as high-conf.
  }

  // High-conf (or medium-converged-to-resident): registerPackage loop.
  const outcomes: GroupTextOutcome[] = [];
  for (const namedRecipient of classification.recipients) {
    const recipientHouseNumber =
      namedRecipient.houseNumber ?? holder?.houseNumber ?? "";
    if (recipientHouseNumber === "") {
      // Defensive: schema admits both absent. Single-recipient case
      // was already caught above. In the multi-recipient loop, skip
      // this entry — partial outcome beats abandoning the whole turn.
      continue;
    }

    emitTrace("flow1", "register.start", { recipient: namedRecipient.name });
    let registered: RegisterPackageResult;
    try {
      const input: RegisterPackageInput = {
        recipientName: namedRecipient.name,
        recipientHouseNumber,
        ...(classification.carrier ? { carrier: classification.carrier } : {}),
      };
      registered = await deps.registerPackage(holder, input);
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
        emitTrace("flow1", "reject.holder-not-registered");
        return {
          kind: "group-text-holder-not-registered",
          inbound: msg,
          holderUserId: fromUserId,
        };
      }
      console.error(
        "[register_package] failed for holder",
        fromUserId,
        "recipient",
        namedRecipient.name,
        "error:",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
      );
      emitTrace("flow1", "register.error");
      outcomes.push({ kind: "register-error", recipientName: namedRecipient.name });
      continue;
    }

    if (registered.recipientResolution.kind === "unknown") {
      outcomes.push({
        kind: "unknown",
        recipientName: namedRecipient.name,
        result: registered,
      });
      continue;
    }
    if (registered.recipientResolution.kind === "known_telegram") {
      emitTrace("flow1", "silent", { reason: "known_telegram" });
      outcomes.push({ kind: "known-telegram", result: registered });
      continue;
    }
    outcomes.push({ kind: "resident", result: registered });
  }

  return {
    kind: "group-text-registered",
    inbound: msg,
    holderLanguage,
    outcomes,
  };
}

/**
 * Pre-computes the full context for an inbound update and returns the
 * appropriate `State` variant (ADR D3). `match` is pure-synchronous;
 * all async I/O happens here before `match` is called.
 *
 * The builder is a mechanical dispatch on inbound kind only — no
 * business logic. Slices 3–6 fill in `dm` and `group` arms; Slice 4
 * (#135) implements the `callback` arm; Slice 6 (#137) implements the
 * `group` arm.
 *
 * Orchestration entry point:
 *
 *   const state   = await buildState(inbound, deps);
 *   const { actions } = match(state);
 *   await runActions(actions, deps);
 */
export async function buildState(
  inbound: Inbound,
  deps: BuildStateDeps,
): Promise<State> {
  switch (inbound.kind) {
    case "dm": {
      const msg = inbound.message;
      // Registration detection is synchronous — no async I/O for this variant.
      // Guard: fromUserId must be present (anonymous DMs flow into the
      // photo/text/receive arms below, which themselves treat
      // `fromUserId === null` as a fallthrough trigger).
      if (
        msg.fromUserId !== null &&
        msg.photoFileId === null &&
        (isStartCommand(msg.text) ||
          isRegisterCommand(msg.text) ||
          parseFreeTextRegistration(msg.text) !== null)
      ) {
        return { kind: "dm-registration", inbound: msg };
      }
      if (msg.photoFileId !== null) {
        return buildDmPhotoState(msg, msg.photoFileId, deps);
      }
      if (isReceiveCommand(msg.text)) {
        return buildDmReceiveCmdState(msg, deps);
      }
      return buildDmTextState(msg, deps);
    }

    case "group": {
      const msg = inbound.message;
      // Anonymous group post (no `from`): silent. We can't DM the sender
      // and there's no actionable identity for any other path.
      if (msg.fromUserId === null) {
        return { kind: "group-silent", inbound: msg };
      }
      if (msg.photoFileId !== null) {
        return buildGroupPhotoState(msg, msg.photoFileId, deps);
      }
      return buildGroupTextState(msg, deps);
    }

    case "callback": {
      const parsed = parseCallbackData(inbound.callback.data);

      if (parsed.action === "confirm_pickup" && parsed.id) {
        return buildCallbackPickupState(inbound, parsed.id, deps);
      }

      if (parsed.action === "accept_reception_group" && parsed.id) {
        return buildCallbackAcceptState(inbound, parsed.id, deps);
      }

      // Every other callback action (legacy `accept_reception_request`,
      // `decline_reception_request`, `remind_later`, malformed
      // `accept_reception_group`, unknown actions) falls through to
      // the agent with an engineered synthetic.
      return {
        kind: "callback-agent",
        inbound: inbound.callback,
        synthetic: synthesizeAgentSynthetic(parsed),
      };
    }

    default: {
      const _exhaustive: never = inbound;
      throw new Error(`buildState: unhandled inbound kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
