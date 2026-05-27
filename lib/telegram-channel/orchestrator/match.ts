import {
  isStartCommand,
  isRegisterCommand,
  parseRegisterCommand,
  parseFreeTextRegistration,
  type ParsedRegistration,
} from "../../registration.js";
import { normaliseLanguageCode } from "../../language.js";
import {
  buildDmTextPickupAlreadyDoneText,
  buildDmTextPickupConfirmedText,
  buildDmTextPickupMultiplePackagesText,
  buildDmTextPickupNoOpenPackagesText,
  buildDmTextPickupRetryText,
  buildDmTextPickupWaitingOnVolunteerText,
  buildGroupAckText,
  buildGroupLabelPrivacyNudge,
  buildHolderConfirmationDmText,
  buildHolderNotRegisteredNudge,
  buildPickupKeyboard,
  buildRecipientDmText,
  buildUnknownRecipientGroupQuestion,
} from "../flow-1-dms.js";
import {
  buildFlow2AckDm,
  buildVlc3PathDm,
} from "../flow-2-dms.js";
import {
  buildHolderThanksDmText,
  buildRecipientReadyToPickUpDmText,
  buildVolunteerEarlyArrivalAckDmText,
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
import type { GroupTextOutcome, State } from "./state.js";
import type { TelegramSessionAuth } from "../types.js";

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
 * Pure synchronous dispatcher (ADR D1).
 *
 * Takes a fully-built `State` and returns the ordered list of `Action`
 * values the runner should execute. Every `state.kind` arm must be
 * present — the `never`-typed default enforces exhaustiveness at
 * compile time. Adding a new inbound shape to `State` without a
 * corresponding arm here is a TypeScript error.
 *
 * Slice 3 (#134) lands the dm-registration arm. Slice 4 (#135) lands
 * the callback-* arms. Slices 5, 6 still throw "not yet migrated".
 */
export function match(state: State): { state: State; actions: Action[] } {
  switch (state.kind) {
    case "dm-registration": {
      const { inbound } = state;
      const chatId = inbound.chatId;
      const language = inbound.fromLanguageCode;

      if (isStartCommand(inbound.text)) {
        const usageHint = buildRegisterUsageHint(language);
        return {
          state,
          actions: [
            Action.emitTrace("registration", "start", { phase: "start-command" }),
            Action.sendDirectMessage(chatId, usageHint, { traceStage: "dm" }),
            Action.emitTrace("registration", "end"),
          ],
        };
      }

      const isSlash = isRegisterCommand(inbound.text);
      const parsed: ParsedRegistration | null = isSlash
        ? parseRegisterCommand(inbound.text)
        : parseFreeTextRegistration(inbound.text);

      if (isSlash && parsed === null) {
        const usageHint = buildRegisterUsageHint(language);
        return {
          state,
          actions: [
            Action.emitTrace("registration", "start", { phase: "usage-hint" }),
            Action.sendDirectMessage(chatId, usageHint, { traceStage: "dm" }),
            Action.emitTrace("registration", "end"),
          ],
        };
      }

      // parsed is non-null (slash with args or free-text match).
      // fromUserId is guaranteed non-null by buildState's detection guard.
      return {
        state,
        actions: [
          Action.registerAndConfirmResident(
            chatId,
            {
              name: parsed!.name,
              street: parsed!.street,
              houseNumber: parsed!.houseNumber,
              floor: parsed!.floor,
              buzzerName: parsed!.buzzerName,
              platformId: String(inbound.fromUserId!),
              telegramLanguageCode: language,
            },
            language,
          ),
        ],
      };
    }

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

    case "dm-photo-flow1-resident":
      return { state, actions: dmPhotoFlow1ResidentActions(state) };

    case "dm-photo-flow1-unknown":
      return { state, actions: dmPhotoFlow1UnknownActions(state) };

    case "dm-photo-flow1-silent":
      return { state, actions: [] };

    case "dm-photo-flow1-holder-not-registered":
      return { state, actions: dmPhotoFlow1HolderNotRegisteredActions(state) };

    case "dm-photo-flow2-created":
      return { state, actions: dmPhotoFlow2CreatedActions(state) };

    case "dm-photo-vlc":
      return { state, actions: dmPhotoVlcActions(state) };

    case "dm-text-flow2-reception-created":
      return { state, actions: dmTextFlow2ReceptionCreatedActions(state) };

    case "dm-text-pickup-confirmed":
      return { state, actions: dmTextPickupConfirmedActions(state) };

    case "dm-text-pickup-already-done":
      return { state, actions: dmTextPickupAlreadyDoneActions(state) };

    case "dm-text-pickup-retry":
      return { state, actions: dmTextPickupRetryActions(state) };

    case "dm-text-pickup-no-open":
      return { state, actions: dmTextPickupNoOpenActions(state) };

    case "dm-text-pickup-waiting":
      return { state, actions: dmTextPickupWaitingActions(state) };

    case "dm-text-pickup-multiple":
      return { state, actions: dmTextPickupMultipleActions(state) };

    case "dm-text-volunteer-early-arrival":
      return { state, actions: dmTextVolunteerEarlyArrivalActions(state) };

    case "dm-text-volunteer-early-arrival-retry":
      return { state, actions: dmTextVolunteerEarlyArrivalRetryActions(state) };

    case "dm-text-vlc":
      return { state, actions: dmTextVlcActions(state) };

    case "dm-text-agent":
      return { state, actions: dmTextAgentActions(state) };

    case "dm-receive-cmd-created":
      return { state, actions: dmReceiveCmdCreatedActions(state) };

    case "dm-receive-cmd-agent":
      return { state, actions: dmReceiveCmdAgentActions(state) };

    case "group-silent":
      return { state, actions: [] };

    case "group-photo-nudge":
      return { state, actions: groupPhotoNudgeActions(state) };

    case "group-text-clarification":
      return { state, actions: groupTextClarificationActions(state) };

    case "group-text-holder-not-registered":
      return { state, actions: groupTextHolderNotRegisteredActions(state) };

    case "group-text-registered":
      return { state, actions: groupTextRegisteredActions(state) };

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

// ---------------------------------------------------------------------------
// dm-photo-* — Slice 5 (#136) DM photo route. Every branch resolves
// channel-deterministically; the agent never runs on this surface.
// ---------------------------------------------------------------------------

function dmPhotoFlow1ResidentActions(
  state: Extract<State, { kind: "dm-photo-flow1-resident" }>,
): Action[] {
  const { result, groupChatId } = state;
  // buildState only emits this variant when the resolution converged on a
  // Resident — the narrowing is a defensive invariant for the runtime.
  if (result.recipientResolution.kind !== "resident") {
    return [
      Action.logError(
        "[orchestrator/dm-photo-flow1-resident] recipient resolution not 'resident' — skipping DMs",
        { resolution: result.recipientResolution.kind },
      ),
    ];
  }
  const recipientResident = result.recipientResolution.resident;
  const actions: Action[] = [];

  if (result.receptionRequestFulfilled !== null) {
    // v2.1 #116: registration LINKS a Flow 2 RR — DM the holder a private
    // confirmation in place of the group ack. The original Flow 2 group
    // post is the announcement.
    const holderChatId = Number(result.holder.platformId);
    if (Number.isFinite(holderChatId)) {
      actions.push(
        Action.sendDirectMessage(
          holderChatId,
          buildHolderConfirmationDmText({
            recipientName: recipientResident.name,
            language: result.holder.language,
          }),
          {
            traceStage: "dm",
            traceExtras: { kind: "flow1-holder-confirmation" },
          },
        ),
      );
    } else {
      actions.push(
        Action.logError(
          "[flow1] holder.platformId is not a finite number — skipping holder confirmation DM",
          { platformId: result.holder.platformId, source: "photo" },
        ),
      );
    }
  } else if (groupChatId !== null) {
    actions.push(
      Action.sendDirectMessage(
        groupChatId,
        buildGroupAckText({
          holder: result.holder,
          recipient: recipientResident,
        }),
        {
          traceStage: "dm",
          traceExtras: { kind: "flow1-group-ack" },
        },
      ),
    );
  }
  // If receptionRequestFulfilled === null and groupChatId === null, the
  // legacy code emitted a console.warn — preserve via Action.logError so a
  // misconfigured env var stays visible in logs. The recipient DM still
  // fires below.
  if (
    result.receptionRequestFulfilled === null &&
    groupChatId === null
  ) {
    actions.push(
      Action.logError(
        "[flow1] streetGroupChatId returned null — skipping group ack",
        { holderHouseNumber: result.holder.houseNumber },
      ),
    );
  }

  const recipientChatId = Number(recipientResident.id);
  if (Number.isFinite(recipientChatId)) {
    actions.push(
      Action.sendDirectMessage(
        recipientChatId,
        buildRecipientDmText({
          holder: result.holder,
          recipient: recipientResident,
        }),
        {
          traceStage: "dm",
          traceExtras: { kind: "flow1-recipient" },
          keyboard: buildPickupKeyboard(result.package.id),
        },
      ),
    );
  } else {
    actions.push(
      Action.logError(
        "[flow1] recipient.id is not a finite number — skipping DM (dm-photo)",
        { recipientId: recipientResident.id },
      ),
    );
  }

  return actions;
}

function dmPhotoFlow1UnknownActions(
  state: Extract<State, { kind: "dm-photo-flow1-unknown" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.groupChatId,
      buildUnknownRecipientGroupQuestion(
        state.recipientName,
        state.holderLanguage ?? "de",
      ),
      {
        traceStage: "dm",
        traceExtras: { kind: "flow1-unknown-recipient" },
      },
    ),
  ];
}

function dmPhotoFlow1HolderNotRegisteredActions(
  state: Extract<State, { kind: "dm-photo-flow1-holder-not-registered" }>,
): Action[] {
  if (state.inbound.fromUserId === null) {
    // Defensive: buildState only emits this variant when fromUserId is set.
    return [];
  }
  const language =
    state.language && normaliseLanguageCode(state.language);
  return [
    Action.sendDirectMessage(
      state.inbound.fromUserId,
      buildHolderNotRegisteredNudge(language),
      {
        traceStage: "dm",
        traceExtras: { kind: "flow1-holder-not-registered" },
      },
    ),
  ];
}

function dmPhotoFlow2CreatedActions(
  state: Extract<State, { kind: "dm-photo-flow2-created" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildFlow2AckDm(state.language),
      {
        traceStage: "dm",
        traceExtras: { kind: "flow2-ack" },
      },
    ),
  ];
}

function dmPhotoVlcActions(
  state: Extract<State, { kind: "dm-photo-vlc" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildVlc3PathDm(state.language),
      {
        traceStage: "dm",
        traceExtras: { kind: "vlc-3-path" },
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// dm-text-* — Slice 5 (#136) DM text route. The welcome-wall structural fix
// lives here: `dm-text-vlc` is emitted for any medium/low-confidence
// classifier verdict on a registered resident. The agent is never invoked
// on that branch — closing the v2 regression class structurally.
// ---------------------------------------------------------------------------

function dmTextFlow2ReceptionCreatedActions(
  state: Extract<State, { kind: "dm-text-flow2-reception-created" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildFlow2AckDm(state.language),
      {
        traceStage: "dm",
        traceExtras: { kind: "flow2-ack" },
      },
    ),
  ];
}

function dmTextPickupConfirmedActions(
  state: Extract<State, { kind: "dm-text-pickup-confirmed" }>,
): Action[] {
  const { inbound, language, result } = state;
  const actions: Action[] = [
    Action.sendDirectMessage(
      inbound.chatId,
      buildDmTextPickupConfirmedText(language),
      {
        traceStage: "dm",
        traceExtras: { kind: "flow1-pickup-confirm" },
      },
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
          {
            traceStage: "dm",
            traceExtras: { kind: "pickup-holder-thanks" },
          },
        ),
      );
    } else {
      actions.push(
        Action.logError(
          "[flow1-pickup-dm] holder.platformId is not a finite number — skipping thanks DM",
          { platformId: result.holder.platformId },
        ),
      );
    }
  }
  return actions;
}

function dmTextPickupAlreadyDoneActions(
  state: Extract<State, { kind: "dm-text-pickup-already-done" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildDmTextPickupAlreadyDoneText(state.language),
      { traceStage: "dm", traceExtras: { kind: "flow1-pickup-already-done" } },
    ),
  ];
}

function dmTextPickupRetryActions(
  state: Extract<State, { kind: "dm-text-pickup-retry" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildDmTextPickupRetryText(state.language),
      { traceStage: "dm", traceExtras: { kind: "flow1-pickup-retry" } },
    ),
  ];
}

function dmTextPickupNoOpenActions(
  state: Extract<State, { kind: "dm-text-pickup-no-open" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildDmTextPickupNoOpenPackagesText(state.language),
      { traceStage: "dm", traceExtras: { kind: "flow1-pickup-no-open" } },
    ),
  ];
}

function dmTextPickupWaitingActions(
  state: Extract<State, { kind: "dm-text-pickup-waiting" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildDmTextPickupWaitingOnVolunteerText({
        volunteerName: state.volunteerName,
        language: state.language,
      }),
      { traceStage: "dm", traceExtras: { kind: "flow1-pickup-waiting" } },
    ),
  ];
}

function dmTextPickupMultipleActions(
  state: Extract<State, { kind: "dm-text-pickup-multiple" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildDmTextPickupMultiplePackagesText(state.language),
      { traceStage: "dm", traceExtras: { kind: "flow1-pickup-multiple" } },
    ),
  ];
}

function dmTextVolunteerEarlyArrivalActions(
  state: Extract<State, { kind: "dm-text-volunteer-early-arrival" }>,
): Action[] {
  const { inbound, language, result, req } = state;
  const actions: Action[] = [];

  // Recipient DM: name the volunteer + attach the [Abgeholt] keyboard.
  if (result.recipientResolution.kind === "resident") {
    const recipientChatId = Number(req.requesterResidentId);
    if (Number.isFinite(recipientChatId)) {
      actions.push(
        Action.sendDirectMessage(
          recipientChatId,
          buildRecipientReadyToPickUpDmText({
            volunteerName: result.holder.name,
            language: result.recipientResolution.resident.language,
          }),
          {
            traceStage: "dm",
            traceExtras: { kind: "flow2-volunteer-early-arrival-recipient" },
            keyboard: buildPickupKeyboard(result.package.id),
          },
        ),
      );
    } else {
      actions.push(
        Action.logError(
          "[flow2-volunteer-early-arrival] requesterResidentId is not a finite number — skipping recipient DM",
          { requesterResidentId: req.requesterResidentId },
        ),
      );
    }
  } else {
    actions.push(
      Action.logError(
        "[flow2-volunteer-early-arrival] recipient resolved to non-resident — skipping recipient DM",
        { resolution: result.recipientResolution.kind },
      ),
    );
  }

  // Volunteer ack DM.
  actions.push(
    Action.sendDirectMessage(
      inbound.chatId,
      buildVolunteerEarlyArrivalAckDmText({
        requesterName: req.requesterName,
        language,
      }),
      {
        traceStage: "dm",
        traceExtras: { kind: "flow2-volunteer-early-arrival-ack" },
      },
    ),
  );

  return actions;
}

function dmTextVolunteerEarlyArrivalRetryActions(
  state: Extract<State, { kind: "dm-text-volunteer-early-arrival-retry" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildDmTextPickupRetryText(state.language),
      {
        traceStage: "dm",
        traceExtras: { kind: "flow2-volunteer-early-arrival-retry" },
      },
    ),
  ];
}

function dmTextVlcActions(
  state: Extract<State, { kind: "dm-text-vlc" }>,
): Action[] {
  // Welcome-wall fix (#136): a registered resident hitting medium/low
  // classifier confidence gets the bounded 3-path VLC recovery DM, NOT a
  // sendToAsh fallthrough. The agent has no output channel on this branch
  // — the v2 welcome-wall regression class is now structurally impossible.
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildVlc3PathDm(state.language),
      {
        traceStage: "dm",
        traceExtras: { kind: "vlc-3-path" },
      },
    ),
  ];
}

function buildDmAuth(
  inbound: Extract<State, { kind: "dm-text-agent" }>["inbound"],
): TelegramSessionAuth | null {
  if (inbound.fromUserId === null) return null;
  return {
    principalId: String(inbound.fromUserId),
    principalType: "user",
    authenticator: "telegram",
    attributes: inbound.fromLanguageCode
      ? { languageCode: inbound.fromLanguageCode }
      : {},
  };
}

function dmTextAgentActions(
  state: Extract<State, { kind: "dm-text-agent" }>,
): Action[] {
  const { inbound } = state;
  return [
    Action.setTriggerAttribute("telegram.text-dm"),
    Action.emitTrace("agent", "start", { trigger: "telegram.text-dm" }),
    Action.sendToAsh(
      inbound.text,
      buildDmAuth(inbound),
      `tg:${inbound.chatId}`,
      {
        chatId: inbound.chatId,
        isGroup: inbound.isGroup,
        fromUserId: inbound.fromUserId,
        fromLanguageCode: inbound.fromLanguageCode,
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// dm-receive-cmd-* — Slice 5 (#136) `/receive` slash command.
// ---------------------------------------------------------------------------

function dmReceiveCmdCreatedActions(
  state: Extract<State, { kind: "dm-receive-cmd-created" }>,
): Action[] {
  return [
    Action.sendDirectMessage(
      state.inbound.chatId,
      buildFlow2AckDm(state.language),
      {
        traceStage: "dm",
        traceExtras: { kind: "flow2-ack" },
      },
    ),
  ];
}

function dmReceiveCmdAgentActions(
  state: Extract<State, { kind: "dm-receive-cmd-agent" }>,
): Action[] {
  const { inbound } = state;
  return [
    Action.setTriggerAttribute("telegram.slash-receive"),
    Action.emitTrace("agent", "start", { trigger: "telegram.slash-receive" }),
    Action.sendToAsh(
      inbound.text,
      buildDmAuth(inbound),
      `tg:${inbound.chatId}`,
      {
        chatId: inbound.chatId,
        isGroup: inbound.isGroup,
        fromUserId: inbound.fromUserId,
        fromLanguageCode: inbound.fromLanguageCode,
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// group-photo-nudge — shipping_label in a group (v2.1 #128)
// ---------------------------------------------------------------------------

function groupPhotoNudgeActions(
  state: Extract<State, { kind: "group-photo-nudge" }>,
): Action[] {
  const language = state.senderLanguageCode
    ? (normaliseLanguageCode(state.senderLanguageCode) ?? "de")
    : "de";
  const nudge = buildGroupLabelPrivacyNudge(language);
  return [
    Action.sendDirectMessage(state.senderUserId, nudge, {
      traceStage: "dm",
      traceExtras: { kind: "flow1-group-label-privacy-nudge" },
    }),
  ];
}

// ---------------------------------------------------------------------------
// group-text-clarification — the only group surface that reaches the agent
// ---------------------------------------------------------------------------

function groupTextClarificationActions(
  state: Extract<State, { kind: "group-text-clarification" }>,
): Action[] {
  const { inbound, synthetic } = state;
  const attributes: Record<string, string> = {};
  if (inbound.fromLanguageCode) attributes["languageCode"] = inbound.fromLanguageCode;
  const auth =
    inbound.fromUserId !== null
      ? {
          principalId: String(inbound.fromUserId),
          principalType: "user" as const,
          authenticator: "telegram" as const,
          attributes,
        }
      : null;
  return [
    Action.setTriggerAttribute("telegram.group"),
    Action.emitTrace("agent", "start", { trigger: "telegram.group" }),
    Action.sendToAsh(synthetic, auth, `tg:${inbound.chatId}`, {
      chatId: inbound.chatId,
      isGroup: inbound.isGroup,
      fromUserId: inbound.fromUserId,
      fromLanguageCode: inbound.fromLanguageCode,
    }),
  ];
}

// ---------------------------------------------------------------------------
// group-text-holder-not-registered — unregistered holder /register nudge
// ---------------------------------------------------------------------------

function groupTextHolderNotRegisteredActions(
  state: Extract<State, { kind: "group-text-holder-not-registered" }>,
): Action[] {
  const language = state.inbound.fromLanguageCode
    ? normaliseLanguageCode(state.inbound.fromLanguageCode)
    : null;
  const nudge = buildHolderNotRegisteredNudge(language);
  return [
    Action.sendDirectMessage(state.holderUserId, nudge, {
      traceStage: "dm",
      traceExtras: { kind: "flow1-holder-not-registered-nudge" },
    }),
  ];
}

// ---------------------------------------------------------------------------
// group-text-registered — iterate per-recipient outcomes
// ---------------------------------------------------------------------------

function groupTextRegisteredActions(
  state: Extract<State, { kind: "group-text-registered" }>,
): Action[] {
  const actions: Action[] = [];
  for (const outcome of state.outcomes) {
    actions.push(...outcomeActions(outcome, state));
  }
  return actions;
}

function outcomeActions(
  outcome: GroupTextOutcome,
  state: Extract<State, { kind: "group-text-registered" }>,
): Action[] {
  switch (outcome.kind) {
    case "register-error":
      // Logged at buildState time; runner does nothing here. Defensive
      // entry in the outcomes array so the dispatch table stays
      // exhaustive on `GroupTextOutcome.kind`.
      return [];
    case "known-telegram":
      // No DM channel to a non-Resident — the Package row is in Redis
      // for the cron sweep. Same shape as the legacy silent branch.
      return [];
    case "unknown":
      return unknownRecipientActions(outcome, state);
    case "resident":
      return residentRecipientActions(outcome, state);
    default: {
      const _exhaustive: never = outcome;
      throw new Error(
        `outcomeActions: unhandled GroupTextOutcome kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function unknownRecipientActions(
  outcome: Extract<GroupTextOutcome, { kind: "unknown" }>,
  state: Extract<State, { kind: "group-text-registered" }>,
): Action[] {
  const language = outcome.result.holder.language ?? state.holderLanguage;
  const question = buildUnknownRecipientGroupQuestion(
    outcome.recipientName,
    language,
  );
  return [
    Action.sendDirectMessage(state.inbound.chatId, question, {
      traceStage: "dm",
      traceExtras: { kind: "flow1-unknown-recipient" },
    }),
  ];
}

function residentRecipientActions(
  outcome: Extract<GroupTextOutcome, { kind: "resident" }>,
  state: Extract<State, { kind: "group-text-registered" }>,
): Action[] {
  const { result } = outcome;
  if (result.recipientResolution.kind !== "resident") {
    // Defensive: the buildState dispatch only emits this outcome on
    // `kind === "resident"`. Keep the narrowing happy without a cast.
    return [];
  }
  const recipient = result.recipientResolution.resident;
  const actions: Action[] = [];

  // v2.1 #116: Flow 2 fulfillment → suppress the group ack, DM the
  // holder a private confirmation instead.
  if (result.receptionRequestFulfilled !== null) {
    const holderChatId = Number(result.holder.platformId);
    if (Number.isFinite(holderChatId)) {
      const text = buildHolderConfirmationDmText({
        recipientName: recipient.name,
        language: result.holder.language,
      });
      actions.push(
        Action.sendDirectMessage(holderChatId, text, {
          traceStage: "dm",
          traceExtras: { kind: "flow1-holder-confirmation" },
        }),
      );
    } else {
      actions.push(
        Action.logError(
          "[flow1] holder.platformId is not a finite number — skipping holder confirmation DM",
          { platformId: result.holder.platformId, source: "text" },
        ),
      );
    }
  } else {
    const groupAck = buildGroupAckText({
      holder: result.holder,
      recipient,
    });
    actions.push(
      Action.sendDirectMessage(state.inbound.chatId, groupAck, {
        traceStage: "dm",
        traceExtras: { kind: "flow1-group-ack" },
      }),
    );
  }

  const recipientChatId = Number(recipient.id);
  if (Number.isFinite(recipientChatId)) {
    const dmText = buildRecipientDmText({
      holder: result.holder,
      recipient,
    });
    actions.push(
      Action.sendDirectMessage(recipientChatId, dmText, {
        traceStage: "dm",
        traceExtras: { kind: "flow1-recipient" },
        keyboard: buildPickupKeyboard(result.package.id),
      }),
    );
  } else {
    actions.push(
      Action.logError(
        "[flow1] recipient.id is not a finite number — skipping DM",
        { recipientId: recipient.id },
      ),
    );
  }

  return actions;
}
