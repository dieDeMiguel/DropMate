import type {
  AcceptReceptionRequestInput,
  AcceptReceptionRequestResult,
  CreateReceptionRequestInput,
  CreateReceptionRequestResult,
} from "../../reception-request.js";
import type { RegisterPackageInput, RegisterPackageResult } from "../../package.js";
import type { RegisterResidentInput, RegisterResidentResult } from "../../registration.js";
import type { ConfirmPickupResult } from "../../pickup.js";
import type { Resident } from "../../redis.js";
import type { InlineKeyboardMarkup, TelegramMessageEntity } from "../send.js";
import type {
  TelegramChannelState,
  TelegramSessionAuth,
  TelegramTriggerKind,
} from "../process-update.js";

/**
 * Discriminated union of all effects the orchestrator can emit (ADR D4).
 *
 * Two flavours:
 *  - **Side-effect actions** carry a `traceStage` string. The runner
 *    emits `<traceStage>.start` before execution and `<traceStage>.end`
 *    or `<traceStage>.error` based on outcome.
 *  - **Decision-only actions** (`emit-trace`, `log-error`) carry no
 *    traceStage; the runner emits or logs them directly.
 *  - `parallel` wraps a set of actions that the runner executes
 *    concurrently (ADR D5).
 */
export type Action =
  | {
      readonly kind: "send-direct-message";
      readonly chatId: number;
      readonly text: string;
      readonly entities?: ReadonlyArray<TelegramMessageEntity>;
      readonly keyboard?: InlineKeyboardMarkup;
      readonly traceStage: string;
      readonly traceExtras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "register-package";
      readonly holder: Resident | null;
      readonly input: RegisterPackageInput;
      readonly traceStage: string;
      readonly traceExtras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "register-resident";
      readonly input: RegisterResidentInput;
      readonly traceStage: string;
      readonly traceExtras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "create-reception-request";
      readonly caller: Resident;
      readonly input: CreateReceptionRequestInput;
      readonly traceStage: string;
      readonly traceExtras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "accept-reception-request";
      readonly caller: Resident;
      readonly input: AcceptReceptionRequestInput;
      readonly traceStage: string;
      readonly traceExtras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "confirm-pickup";
      readonly caller: Resident;
      readonly packageId: string;
      readonly traceStage: string;
      readonly traceExtras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "edit-group-card";
      readonly chatId: number;
      readonly messageId: number;
      readonly text: string;
      readonly traceStage: string;
      readonly traceExtras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "answer-callback";
      readonly callbackId: string;
      readonly text?: string;
    }
  | {
      readonly kind: "strip-keyboard";
      readonly chatId: number;
      readonly messageId: number;
    }
  | {
      readonly kind: "send-to-ash";
      readonly message: string;
      readonly auth: TelegramSessionAuth | null;
      readonly continuationToken: string;
      readonly state: TelegramChannelState;
    }
  | {
      readonly kind: "set-trigger-attribute";
      readonly trigger: TelegramTriggerKind;
    }
  | {
      readonly kind: "emit-trace";
      readonly stage: string;
      readonly phase: string;
      readonly extras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "log-error";
      readonly message: string;
      readonly meta?: unknown;
    }
  | {
      readonly kind: "parallel";
      readonly actions: ReadonlyArray<Action>;
    };

/**
 * Helper constructor namespace (ADR D1).
 *
 * Usage:
 *   Action.sendDirectMessage(chatId, text, { traceStage: "dm" })
 *   Action.emitTrace("flow1", "register.start")
 *   Action.parallel([...])
 */
export namespace Action {
  export function sendDirectMessage(
    chatId: number,
    text: string,
    opts: {
      traceStage: string;
      traceExtras?: Readonly<Record<string, unknown>>;
      entities?: ReadonlyArray<TelegramMessageEntity>;
      keyboard?: InlineKeyboardMarkup;
    },
  ): Action {
    return {
      kind: "send-direct-message",
      chatId,
      text,
      traceStage: opts.traceStage,
      ...(opts.traceExtras ? { traceExtras: opts.traceExtras } : {}),
      ...(opts.entities ? { entities: opts.entities } : {}),
      ...(opts.keyboard ? { keyboard: opts.keyboard } : {}),
    };
  }

  export function registerPackage(
    holder: Resident | null,
    input: RegisterPackageInput,
    opts: { traceStage: string; traceExtras?: Readonly<Record<string, unknown>> },
  ): Action {
    return {
      kind: "register-package",
      holder,
      input,
      traceStage: opts.traceStage,
      ...(opts.traceExtras ? { traceExtras: opts.traceExtras } : {}),
    };
  }

  export function registerResident(
    input: RegisterResidentInput,
    opts: { traceStage: string; traceExtras?: Readonly<Record<string, unknown>> },
  ): Action {
    return {
      kind: "register-resident",
      input,
      traceStage: opts.traceStage,
      ...(opts.traceExtras ? { traceExtras: opts.traceExtras } : {}),
    };
  }

  export function createReceptionRequest(
    caller: Resident,
    input: CreateReceptionRequestInput,
    opts: { traceStage: string; traceExtras?: Readonly<Record<string, unknown>> },
  ): Action {
    return {
      kind: "create-reception-request",
      caller,
      input,
      traceStage: opts.traceStage,
      ...(opts.traceExtras ? { traceExtras: opts.traceExtras } : {}),
    };
  }

  export function acceptReceptionRequest(
    caller: Resident,
    input: AcceptReceptionRequestInput,
    opts: { traceStage: string; traceExtras?: Readonly<Record<string, unknown>> },
  ): Action {
    return {
      kind: "accept-reception-request",
      caller,
      input,
      traceStage: opts.traceStage,
      ...(opts.traceExtras ? { traceExtras: opts.traceExtras } : {}),
    };
  }

  export function confirmPickup(
    caller: Resident,
    packageId: string,
    opts: { traceStage: string; traceExtras?: Readonly<Record<string, unknown>> },
  ): Action {
    return {
      kind: "confirm-pickup",
      caller,
      packageId,
      traceStage: opts.traceStage,
      ...(opts.traceExtras ? { traceExtras: opts.traceExtras } : {}),
    };
  }

  export function editGroupCard(
    chatId: number,
    messageId: number,
    text: string,
    opts: { traceStage: string; traceExtras?: Readonly<Record<string, unknown>> },
  ): Action {
    return {
      kind: "edit-group-card",
      chatId,
      messageId,
      text,
      traceStage: opts.traceStage,
      ...(opts.traceExtras ? { traceExtras: opts.traceExtras } : {}),
    };
  }

  export function answerCallback(callbackId: string, text?: string): Action {
    return { kind: "answer-callback", callbackId, ...(text ? { text } : {}) };
  }

  export function stripKeyboard(chatId: number, messageId: number): Action {
    return { kind: "strip-keyboard", chatId, messageId };
  }

  export function sendToAsh(
    message: string,
    auth: TelegramSessionAuth | null,
    continuationToken: string,
    state: TelegramChannelState,
  ): Action {
    return { kind: "send-to-ash", message, auth, continuationToken, state };
  }

  export function setTriggerAttribute(trigger: TelegramTriggerKind): Action {
    return { kind: "set-trigger-attribute", trigger };
  }

  export function emitTrace(
    stage: string,
    phase: string,
    extras?: Readonly<Record<string, unknown>>,
  ): Action {
    return {
      kind: "emit-trace",
      stage,
      phase,
      ...(extras ? { extras } : {}),
    };
  }

  export function logError(message: string, meta?: unknown): Action {
    return { kind: "log-error", message, ...(meta !== undefined ? { meta } : {}) };
  }

  export function parallel(actions: ReadonlyArray<Action>): Action {
    return { kind: "parallel", actions };
  }
}
