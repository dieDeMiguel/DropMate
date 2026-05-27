import { normaliseLanguageCode } from "../../language.js";
import { buildDmTextPickupConfirmedText } from "../flow-1-dms.js";
import {
  buildHolderThanksDmText,
  pickupAlreadyDoneToast,
  pickupNotRecipientToast,
  pickupRetryToast,
} from "../pickup-dms.js";
import {
  buildRequesterAcceptDm,
  buildVolunteerAcceptDmText,
  crossStreetToastForLanguage,
  selfAcceptToastForLanguage,
} from "../volunteer-accept-dms.js";
import { Action } from "./action.js";
import type { State } from "./state.js";

/**
 * Pure synchronous dispatcher (ADR D1).
 *
 * Takes a fully-built `State` and returns the ordered list of `Action`
 * values the runner should execute. Every `state.kind` arm must be
 * present — the `never`-typed default enforces exhaustiveness at
 * compile time. Adding a new inbound shape to `State` without a
 * corresponding arm here is a TypeScript error.
 *
 * Slice 4 (#135) lands the callback arms. Slices 3, 5, 6 still throw
 * "not yet migrated" for their state kinds.
 */
export function match(state: State): { state: State; actions: Action[] } {
  switch (state.kind) {
    case "dm-registration":
      throw new Error("dm-registration: not yet migrated — see Slice 3 (#134)");

    case "callback-pickup":
      return { state, actions: callbackPickupActions(state) };

    case "callback-pickup-not-recipient":
      return { state, actions: callbackPickupNotRecipientActions(state) };

    case "callback-pickup-already-done":
      return { state, actions: callbackPickupAlreadyDoneActions(state) };

    case "callback-pickup-error":
      return { state, actions: callbackPickupErrorActions(state) };

    case "callback-pickup-unregistered":
      return { state, actions: callbackPickupUnregisteredActions(state) };

    case "callback-accept":
      return { state, actions: callbackAcceptActions(state) };

    case "callback-accept-self":
      return { state, actions: callbackAcceptSelfActions(state) };

    case "callback-accept-cross-street":
      return { state, actions: callbackAcceptCrossStreetActions(state) };

    case "callback-accept-error":
      return { state, actions: callbackAcceptErrorActions(state) };

    case "callback-accept-unregistered":
      return { state, actions: callbackAcceptUnregisteredActions(state) };

    case "callback-agent":
      return { state, actions: callbackAgentActions(state) };

    case "dm-photo":
      throw new Error("dm-photo: not yet migrated — see Slice 5 (#136)");

    case "dm-text":
      throw new Error("dm-text: not yet migrated — see Slice 5 (#136)");

    case "dm-receive-cmd":
      throw new Error("dm-receive-cmd: not yet migrated — see Slice 5 (#136)");

    case "group-photo":
      throw new Error("group-photo: not yet migrated — see Slice 6 (#137)");

    case "group-text":
      throw new Error("group-text: not yet migrated — see Slice 6 (#137)");

    default: {
      const _exhaustive: never = state;
      throw new Error(`match: unhandled state kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// callback-pickup* — confirm_pickup tap branches (v2.1 #108)
// ---------------------------------------------------------------------------

function callbackPickupActions(
  state: Extract<State, { kind: "callback-pickup" }>,
): Action[] {
  const { inbound: cb, caller, result } = state;
  const actions: Action[] = [
    Action.answerCallback(cb.callbackId),
    Action.stripKeyboard(cb.chatId, cb.messageId),
    Action.sendDirectMessage(
      cb.chatId,
      buildDmTextPickupConfirmedText(caller.language ?? cb.fromLanguageCode),
      { traceStage: "dm", traceExtras: { kind: "flow1-pickup-confirm" } },
    ),
  ];

  if (result.holder) {
    const holderChatId = Number(result.holder.platformId);
    if (Number.isFinite(holderChatId)) {
      actions.push(
        Action.sendDirectMessage(
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
          { traceStage: "dm", traceExtras: { kind: "pickup-holder-thanks" } },
        ),
      );
    } else {
      actions.push(
        Action.logError(
          "[orchestrator/callback-pickup] holder.platformId is not a finite number — skipping thanks DM",
          { platformId: result.holder.platformId },
        ),
      );
    }
  }

  return actions;
}

function callbackPickupNotRecipientActions(
  state: Extract<State, { kind: "callback-pickup-not-recipient" }>,
): Action[] {
  const { inbound: cb, caller } = state;
  return [
    Action.answerCallback(
      cb.callbackId,
      pickupNotRecipientToast(caller.language ?? cb.fromLanguageCode),
    ),
    // v2.1 #114: keyboard stays live. With the keyboard living only
    // on the recipient's DM (a 1:1 chat), a non-recipient tap that
    // reaches here can only come from a stale pre-#114 group keyboard
    // — stripping it would punish every other resident's view of that
    // historical message.
  ];
}

function callbackPickupAlreadyDoneActions(
  state: Extract<State, { kind: "callback-pickup-already-done" }>,
): Action[] {
  const { inbound: cb, caller } = state;
  return [
    Action.answerCallback(
      cb.callbackId,
      pickupAlreadyDoneToast(caller.language ?? cb.fromLanguageCode),
    ),
    // Keyboard already stripped from the previous success — no
    // further keyboard action needed.
  ];
}

function callbackPickupErrorActions(
  state: Extract<State, { kind: "callback-pickup-error" }>,
): Action[] {
  const { inbound: cb, language } = state;
  return [
    Action.answerCallback(cb.callbackId, pickupRetryToast(language)),
    // Keyboard stays live so the recipient can re-tap once the
    // underlying hiccup clears.
  ];
}

function callbackPickupUnregisteredActions(
  state: Extract<State, { kind: "callback-pickup-unregistered" }>,
): Action[] {
  const { inbound: cb } = state;
  return [
    Action.answerCallback(
      cb.callbackId,
      pickupNotRecipientToast(cb.fromLanguageCode),
    ),
    // v2.1 #114: keyboard stays live. Same rationale as
    // PICKUP_NOT_RECIPIENT — only path here is a stale pre-#114
    // group keyboard.
  ];
}

// ---------------------------------------------------------------------------
// callback-accept* — accept_reception_group tap branches (v2.1 #96)
// ---------------------------------------------------------------------------

function callbackAcceptActions(
  state: Extract<State, { kind: "callback-accept" }>,
): Action[] {
  const { inbound: cb, result } = state;
  const actions: Action[] = [
    Action.answerCallback(cb.callbackId),
    Action.stripKeyboard(cb.chatId, cb.messageId),
  ];

  if (result.groupCardChatId !== null && result.groupCardMessageId !== null) {
    actions.push(
      Action.editGroupCard(
        result.groupCardChatId,
        result.groupCardMessageId,
        `✅ angenommen von ${result.volunteer.name}`,
        { traceStage: "flow2.edit" },
      ),
    );
  }

  // Volunteer DM — operational handoff.
  const volunteerDmText = buildVolunteerAcceptDmText(result);
  const volunteerChatId = Number(result.volunteer.platformId);
  if (Number.isFinite(volunteerChatId)) {
    actions.push(
      Action.sendDirectMessage(volunteerChatId, volunteerDmText, {
        traceStage: "dm",
        traceExtras: { kind: "volunteer-accept" },
      }),
    );
  } else {
    actions.push(
      Action.logError(
        "[orchestrator/callback-accept] volunteer.platformId is not a finite number — skipping volunteer DM",
        { platformId: result.volunteer.platformId },
      ),
    );
  }

  // Requester DM — named confirmation with text_mention entity.
  const requesterDm = buildRequesterAcceptDm(result);
  const requesterChatId = Number(result.requester.id);
  if (Number.isFinite(requesterChatId)) {
    actions.push(
      Action.sendDirectMessage(requesterChatId, requesterDm.text, {
        traceStage: "dm",
        traceExtras: { kind: "requester-accept" },
        entities: requesterDm.entities,
      }),
    );
  } else {
    actions.push(
      Action.logError(
        "[orchestrator/callback-accept] requester.id is not a finite number — skipping requester DM",
        { requesterId: result.requester.id },
      ),
    );
  }

  return actions;
}

function callbackAcceptSelfActions(
  state: Extract<State, { kind: "callback-accept-self" }>,
): Action[] {
  const { inbound: cb, volunteer } = state;
  const language = volunteer.language ?? cb.fromLanguageCode;
  return [
    Action.answerCallback(cb.callbackId, selfAcceptToastForLanguage(language)),
    // #101: keyboard MUST stay live so other neighbours on the same
    // street can still claim. The rejection is per-tapper, not per-card.
  ];
}

function callbackAcceptCrossStreetActions(
  state: Extract<State, { kind: "callback-accept-cross-street" }>,
): Action[] {
  const { inbound: cb, volunteer } = state;
  const language = volunteer.language ?? cb.fromLanguageCode;
  return [
    Action.answerCallback(cb.callbackId, crossStreetToastForLanguage(language)),
    // #96 Part B: permanent rejection. Strip the keyboard so the
    // volunteer doesn't keep re-tapping.
    Action.stripKeyboard(cb.chatId, cb.messageId),
  ];
}

function callbackAcceptErrorActions(
  state: Extract<State, { kind: "callback-accept-error" }>,
): Action[] {
  const { inbound: cb, language } = state;
  return [
    Action.answerCallback(cb.callbackId, retryToastForLanguage(language)),
    // Recoverable failure → keyboard stays live so the volunteer can
    // re-tap once the underlying hiccup clears.
  ];
}

function callbackAcceptUnregisteredActions(
  state: Extract<State, { kind: "callback-accept-unregistered" }>,
): Action[] {
  const { inbound: cb } = state;
  return [
    Action.answerCallback(
      cb.callbackId,
      "Bitte zuerst /register, um Paketen zu helfen.",
    ),
    // Keyboard stays intact — the user can re-tap after /register.
  ];
}

// ---------------------------------------------------------------------------
// callback-agent — actions that still fall through to the agent
// ---------------------------------------------------------------------------

function callbackAgentActions(
  state: Extract<State, { kind: "callback-agent" }>,
): Action[] {
  const { inbound: cb, synthetic } = state;
  const attributes: Record<string, string> = {};
  if (cb.fromLanguageCode) attributes["languageCode"] = cb.fromLanguageCode;
  const auth = {
    principalId: String(cb.fromUserId),
    principalType: "user" as const,
    authenticator: "telegram" as const,
    attributes,
  };
  return [
    Action.answerCallback(cb.callbackId),
    Action.stripKeyboard(cb.chatId, cb.messageId),
    Action.setTriggerAttribute("telegram.callback"),
    Action.sendToAsh(synthetic, auth, `tg:${cb.chatId}`, {
      chatId: cb.chatId,
      isGroup: cb.isGroup,
      fromUserId: cb.fromUserId,
      fromLanguageCode: cb.fromLanguageCode,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Retry-toast localisation (mirrors the table in process-update.ts).
// ---------------------------------------------------------------------------

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
