import type { Session } from "experimental-ash/channels";

import type {
  AcceptReceptionRequestInput,
  AcceptReceptionRequestResult,
  CreateReceptionRequestInput,
  CreateReceptionRequestResult,
} from "../../reception-request.js";
import type { RegisterPackageInput, RegisterPackageResult } from "../../package.js";
import { buildRegistrationConfirmationDm } from "../../registration.js";
import type { RegisterResidentInput, RegisterResidentResult } from "../../registration.js";
import type { ConfirmPickupResult } from "../../pickup.js";
import type { Resident } from "../../redis.js";
import { emitTrace } from "../../trace.js";
import type {
  TelegramChannelState,
  TelegramSessionAuth,
  TelegramTriggerKind,
} from "../types.js";
import type { InlineKeyboardMarkup, TelegramMessageEntity } from "../send.js";
import type { Action } from "./action.js";

/**
 * Dependencies the action runner needs to execute side-effect actions.
 * Mirrors the relevant subset of `ProcessUpdateDeps` so the factory
 * can wire the same dep handles without importing from the runner.
 */
export interface RunActionsDeps {
  readonly sendDirectMessage: (
    chatId: number,
    text: string,
    entities?: ReadonlyArray<TelegramMessageEntity>,
    replyMarkup?: InlineKeyboardMarkup,
  ) => Promise<void>;
  readonly registerPackage: (
    holder: Resident | null,
    input: RegisterPackageInput,
  ) => Promise<RegisterPackageResult>;
  readonly registerResident: (
    input: RegisterResidentInput,
  ) => Promise<RegisterResidentResult>;
  readonly createReceptionRequest: (
    caller: Resident,
    input: CreateReceptionRequestInput,
  ) => Promise<CreateReceptionRequestResult>;
  readonly acceptReceptionRequest: (
    caller: Resident,
    input: AcceptReceptionRequestInput,
  ) => Promise<AcceptReceptionRequestResult>;
  readonly confirmPickup: (
    caller: Resident,
    packageId: string,
  ) => Promise<ConfirmPickupResult>;
  readonly editGroupCard: (
    chatId: number,
    messageId: number,
    text: string,
  ) => Promise<void>;
  readonly answerCallback: (callbackId: string, text?: string) => Promise<void>;
  readonly stripKeyboard: (chatId: number, messageId: number) => Promise<void>;
  readonly sendToAsh: (
    message: string,
    options: {
      readonly auth: TelegramSessionAuth | null;
      readonly continuationToken: string;
      readonly state: TelegramChannelState;
    },
  ) => Promise<Session>;
  readonly drainSession: (session: Session, chatId: number) => Promise<void>;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly setTriggerAttribute: (trigger: TelegramTriggerKind) => void;
}

/**
 * Execute a single action, emitting trace events per ADR D4.
 * Side-effect actions emit `<traceStage>.start` → `<traceStage>.end`
 * or `<traceStage>.error`. `emit-trace` and `log-error` fire directly.
 *
 * Tolerance contract (matches the legacy dispatcher semantics):
 *
 *   - **Communication side effects** (`send-direct-message`,
 *     `edit-group-card`, `answer-callback`, `strip-keyboard`) catch
 *     thrown errors, log them, emit the `.error` trace, and CONTINUE.
 *     A failed DM never bails a multi-DM flow; a failed callback ack
 *     never blocks the canonical state flip; etc. This mirrors the
 *     legacy callback handlers exactly.
 *   - **Canonical-state writes** (`register-package`, `register-resident`,
 *     `create-reception-request`, `accept-reception-request`,
 *     `confirm-pickup`) RETHROW on failure. Callers either pre-handle
 *     the side effect in `buildState` (the v2.1 #135 callback path) or
 *     wrap `runActions` in a try/catch where the error class matters.
 */
async function executeOne(action: Action, deps: RunActionsDeps): Promise<void> {
  switch (action.kind) {
    case "send-direct-message": {
      emitTrace(action.traceStage, "start", action.traceExtras);
      try {
        await deps.sendDirectMessage(
          action.chatId,
          action.text,
          action.entities,
          action.keyboard,
        );
        emitTrace(action.traceStage, "end", action.traceExtras);
      } catch (err) {
        emitTrace(action.traceStage, "error", {
          ...action.traceExtras,
          error: String(err),
        });
        console.error(
          "[orchestrator] send-direct-message failed",
          { chatId: action.chatId, traceStage: action.traceStage, err: String(err) },
        );
      }
      return;
    }

    case "register-package": {
      emitTrace(action.traceStage, "start", action.traceExtras);
      try {
        await deps.registerPackage(action.holder, action.input);
        emitTrace(action.traceStage, "end", action.traceExtras);
      } catch (err) {
        emitTrace(action.traceStage, "error", {
          ...action.traceExtras,
          error: String(err),
        });
        throw err;
      }
      return;
    }

    case "create-reception-request": {
      emitTrace(action.traceStage, "start", action.traceExtras);
      try {
        await deps.createReceptionRequest(action.caller, action.input);
        emitTrace(action.traceStage, "end", action.traceExtras);
      } catch (err) {
        emitTrace(action.traceStage, "error", {
          ...action.traceExtras,
          error: String(err),
        });
        throw err;
      }
      return;
    }

    case "accept-reception-request": {
      emitTrace(action.traceStage, "start", action.traceExtras);
      try {
        await deps.acceptReceptionRequest(action.caller, action.input);
        emitTrace(action.traceStage, "end", action.traceExtras);
      } catch (err) {
        emitTrace(action.traceStage, "error", {
          ...action.traceExtras,
          error: String(err),
        });
        throw err;
      }
      return;
    }

    case "confirm-pickup": {
      emitTrace(action.traceStage, "start", action.traceExtras);
      try {
        await deps.confirmPickup(action.caller, action.packageId);
        emitTrace(action.traceStage, "end", action.traceExtras);
      } catch (err) {
        emitTrace(action.traceStage, "error", {
          ...action.traceExtras,
          error: String(err),
        });
        throw err;
      }
      return;
    }

    case "edit-group-card": {
      emitTrace(action.traceStage, "start", action.traceExtras);
      try {
        await deps.editGroupCard(action.chatId, action.messageId, action.text);
        emitTrace(action.traceStage, "end", action.traceExtras);
      } catch (err) {
        emitTrace(action.traceStage, "error", {
          ...action.traceExtras,
          error: String(err),
        });
        console.error(
          "[orchestrator] edit-group-card failed",
          { chatId: action.chatId, messageId: action.messageId, err: String(err) },
        );
      }
      return;
    }

    case "answer-callback":
      try {
        // Forward only the args the dep actually got — the legacy
        // call sites used the single-arg form for silent acks and the
        // two-arg form for toasts. Forwarding `undefined` would
        // surface as a second arg in test spies and break the
        // existing `toHaveBeenCalledWith("cb_id")` assertions.
        if (action.text !== undefined) {
          await deps.answerCallback(action.callbackId, action.text);
        } else {
          await deps.answerCallback(action.callbackId);
        }
      } catch (err) {
        console.error(
          "[orchestrator] answer-callback failed",
          { callbackId: action.callbackId, err: String(err) },
        );
      }
      return;

    case "strip-keyboard":
      try {
        await deps.stripKeyboard(action.chatId, action.messageId);
      } catch (err) {
        console.error(
          "[orchestrator] strip-keyboard failed",
          { chatId: action.chatId, messageId: action.messageId, err: String(err) },
        );
      }
      return;

    case "send-to-ash": {
      const session = await deps.sendToAsh(action.message, {
        auth: action.auth,
        continuationToken: action.continuationToken,
        state: action.state,
      });
      deps.waitUntil(deps.drainSession(session, action.state.chatId));
      return;
    }

    case "set-trigger-attribute":
      deps.setTriggerAttribute(action.trigger);
      return;

    case "emit-trace":
      emitTrace(action.stage, action.phase, action.extras);
      return;

    case "log-error":
      console.error("[orchestrator]", action.message, action.meta ?? "");
      return;

    case "register-and-confirm-resident": {
      emitTrace("registration", "start");
      let result: RegisterResidentResult;
      try {
        result = await deps.registerResident(action.input);
      } catch (err) {
        // Don't emit registration.end — matches legacy behavior where it only
        // fires on success. Rethrow so the caller can fall through to the agent.
        throw err;
      }
      const confirmation = buildRegistrationConfirmationDm({
        resident: result.resident,
        fallbackLanguageCode: action.fallbackLanguageCode,
      });
      emitTrace("dm", "start");
      try {
        await deps.sendDirectMessage(action.chatId, confirmation);
        emitTrace("dm", "end");
      } catch (err) {
        // Resident row already landed; DM failure is non-fatal. Log and continue.
        console.error(
          "[registration] confirmation DM failed for chatId",
          action.chatId,
          "error:",
          err instanceof Error ? err.message : err,
        );
      }
      emitTrace("registration", "end");
      return;
    }

    case "parallel":
      await Promise.all(action.actions.map((a) => executeOne(a, deps)));
      return;

    default: {
      const _exhaustive: never = action;
      throw new Error(
        `runActions: unhandled action kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Execute an ordered list of actions sequentially (ADR D5).
 *
 * Actions execute one-at-a-time in array order. Concurrency is
 * opt-in via `Action.parallel([...])` wrappers — only the inner
 * actions of a `parallel` node run concurrently.
 *
 * Errors from canonical-state writes propagate to the caller. Errors
 * from communication side effects are logged and swallowed (see the
 * tolerance contract above `executeOne`).
 */
export async function runActions(
  actions: ReadonlyArray<Action>,
  deps: RunActionsDeps,
): Promise<void> {
  for (const action of actions) {
    await executeOne(action, deps);
  }
}
