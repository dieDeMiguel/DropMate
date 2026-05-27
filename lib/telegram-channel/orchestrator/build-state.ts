import {
  ACCEPT_DIFFERENT_STREET_ERROR_CODE,
  ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE,
  type AcceptReceptionRequestResult,
} from "../../reception-request.js";
import {
  PICKUP_ALREADY_DONE_ERROR_CODE,
  PICKUP_NOT_RECIPIENT_ERROR_CODE,
  type ConfirmPickupResult,
} from "../../pickup.js";
import type { Resident } from "../../redis.js";
import {
  isStartCommand,
  isRegisterCommand,
  parseFreeTextRegistration,
} from "../../registration.js";
import { emitTrace } from "../../trace.js";
import type {
  ClassifierVerdict,
  GroupClassifierVerdict,
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
 * still fall through to `sendToAsh`. Inlines the legacy
 * `synthesizeCallbackMessage` from `process-update.ts` (deleted by
 * Slice 4 / #135) so the unknown / decline / remind / stale-accept
 * paths preserve their existing text.
 *
 * Kept in English regardless of the user's language: the agent's
 * system prompt + the user's stored `Resident.language` drive the
 * *reply* localisation. The synthetic itself is internal scaffolding
 * the user never sees.
 */
function synthesizeAgentSynthetic(parsed: ParsedCallbackData): string {
  switch (parsed.action) {
    case "accept_reception_request":
      // Legacy DM-3 button callback. The agent tool that used to back
      // this branch was hard-deleted by v2.1 Slice 5 (#90); the
      // channel never wires this callback anymore. Apologise briefly
      // in the tapper's language if it ever arrives via a stale
      // message.
      return "[button-tap] An old 'I can help' button was tapped, but the channel-side flow has changed. Apologise briefly in the tapper's language and ask them to wait for the next group card.";
    case "accept_reception_group":
      // Defensive: reachable only on a malformed
      // `accept_reception_group` (parsed.id missing). The
      // happy/error paths are owned by `buildState`'s
      // callback-accept-* variants.
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
      caller: callerPlaceholder(cb.fromLanguageCode),
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
    return { kind: "callback-pickup-error", inbound: cb, caller };
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
    // Fake a "volunteer" of null to drive the error toast. We need a
    // Resident on the state variant for the volunteer's language —
    // but here we have nothing. Build a minimal placeholder so the
    // toast resolves via cb.fromLanguageCode.
    return {
      kind: "callback-accept-error",
      inbound: cb,
      volunteer: volunteerPlaceholder(cb.fromLanguageCode),
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
      volunteer: volunteerPlaceholder(cb.fromLanguageCode),
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
    return { kind: "callback-accept-error", inbound: cb, volunteer };
  }
}

/**
 * Minimal Resident shape used purely to drive the
 * `callback-accept-error` / `callback-pickup-error` toast's language
 * fallback when the caller's Resident record can't be resolved (the
 * lookup threw before we could populate it). The match arm only reads
 * `.language`, so the other fields are placeholders.
 */
function volunteerPlaceholder(languageCode: string | null): Resident {
  return {
    id: "",
    name: "",
    street: "",
    houseNumber: "",
    platformId: "",
    platform: "telegram",
    language: languageCode ?? undefined,
    availabilityPatterns: [],
    registeredAt: 0,
    source: "explicit",
    confirmed: false,
  };
}

const callerPlaceholder = volunteerPlaceholder;

/**
 * Pre-computes the full context for an inbound update and returns the
 * appropriate `State` variant (ADR D3). `match` is pure-synchronous;
 * all async I/O happens here before `match` is called.
 *
 * The builder is a mechanical dispatch on inbound kind only — no
 * business logic. Slices 3–6 fill in `dm` and `group` arms; Slice 4
 * (#135) implements the `callback` arm.
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
      // Guard: fromUserId must be present (anonymous DMs fall through to legacy).
      if (
        msg.fromUserId !== null &&
        msg.photoFileId === null &&
        (isStartCommand(msg.text) ||
          isRegisterCommand(msg.text) ||
          parseFreeTextRegistration(msg.text) !== null)
      ) {
        return { kind: "dm-registration", inbound: msg };
      }
      throw new Error(
        "buildState dm: not yet migrated for non-registration DMs — see Slice 5 (#136)",
      );
    }

    case "group":
      throw new Error(
        "buildState group: not yet migrated — see Slice 6 (#137)",
      );

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
