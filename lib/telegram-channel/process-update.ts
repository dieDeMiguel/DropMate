/**
 * Telegram channel — inbound update orchestration shim.
 *
 * Verifies the secret header, parses the JSON, classifies the inbound
 * shape, and drives the `buildState → match → runActions` engine
 * (ADR 0001 / `orchestrator/*`). The state machine owns every routing
 * decision — this module is intentionally a thin shim.
 *
 * Pre-Slice-7 this file carried a ~3700-line dispatcher with per-route
 * helpers (`routeDmPhoto`, `routeDmTextThroughClassifier`, etc.). Each
 * route had its own discriminated-union return type, its own error
 * handling, and its own trace emission. Slices 3–6 migrated every route
 * family into the orchestrator engine; Slice 7 (#138) deletes the
 * dispatcher entirely and folds the inbound-kind decoding into a single
 * `toInbound` helper.
 *
 * @see lib/telegram-channel/verify.ts            — header check
 * @see lib/telegram-channel/inbound.ts           — payload → canonical message
 * @see lib/telegram-channel/orchestrator/build-state.ts — I/O orchestrator
 * @see lib/telegram-channel/orchestrator/match.ts       — pure dispatcher
 * @see lib/telegram-channel/orchestrator/run-actions.ts — action runner
 * @see docs/adr/0001-state-machine-engine.md
 */

import type { Session } from "experimental-ash/channels";

import type {
  AcceptReceptionRequestInput,
  AcceptReceptionRequestResult,
  CreateReceptionRequestInput,
  CreateReceptionRequestResult,
} from "../reception-request.js";
import type {
  RecipientResolution,
  RegisterPackageInput,
  RegisterPackageResult,
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
import type { Inbound } from "./orchestrator/event.js";
import { match } from "./orchestrator/match.js";
import { runActions } from "./orchestrator/run-actions.js";
import {
  extractInboundCallback,
  extractInboundMessage,
  type TelegramUpdatePayload,
} from "./inbound.js";
import type { InlineKeyboardMarkup, TelegramMessageEntity } from "./send.js";
import { verifyTelegramSecretHeader } from "./verify.js";

export type { TelegramChannelState, TelegramSessionAuth, TelegramTriggerKind } from "./types.js";
import type { TelegramChannelState, TelegramSessionAuth, TelegramTriggerKind } from "./types.js";

/**
 * Caller-supplied dependencies. Mirrors the lib-level handles the
 * orchestrator's `buildState` + `runActions` need, plus the channel-level
 * primitives (secret, file-URL resolution, Bot API ack/strip, etc.).
 *
 * The factory wires production implementations; tests pass spies.
 */
export interface ProcessUpdateDeps {
  /** Expected `X-Telegram-Bot-Api-Secret-Token` value. */
  readonly expectedSecret: string | undefined;
  readonly sendToAsh: (
    message: string,
    options: {
      readonly auth: TelegramSessionAuth | null;
      readonly continuationToken: string;
      readonly state: TelegramChannelState;
    },
  ) => Promise<Session>;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly drainSession: (session: Session, chatId: number) => Promise<void>;
  readonly getFileUrl: (fileId: string) => Promise<string>;
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
  readonly answerCallback: (
    callbackId: string,
    text?: string,
  ) => Promise<void>;
  readonly stripKeyboard: (chatId: number, messageId: number) => Promise<void>;
  readonly recordTelegramObservation: (input: {
    readonly userId: number;
    readonly firstName: string;
    readonly lastName?: string;
    readonly username?: string;
    readonly languageCode?: string;
    readonly chatId: number;
  }) => Promise<void>;
  readonly isRegisteredResident: (userId: number) => Promise<boolean>;
  readonly classifyDmIntent: (input: {
    text: string;
    languageHint?: string;
  }) => Promise<DmIntentClassificationResult>;
  readonly classifyGroupMessage: (input: {
    text: string;
    languageHint?: string;
  }) => Promise<ClassifyGroupMessageResult>;
  readonly registerPackage: (
    holder: Resident | null,
    input: RegisterPackageInput,
  ) => Promise<RegisterPackageResult>;
  readonly resolveRecipient: (
    recipientName: string,
    recipientHouseNumber: string,
  ) => Promise<RecipientResolution>;
  readonly confirmPickup: (
    caller: Resident,
    packageId: string,
  ) => Promise<ConfirmPickupResult>;
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
  readonly getRegisteredResident: (userId: number) => Promise<Resident | null>;
  readonly createReceptionRequest: (
    caller: Resident,
    input: CreateReceptionRequestInput,
  ) => Promise<CreateReceptionRequestResult>;
  readonly acceptReceptionRequest: (
    caller: Resident,
    input: AcceptReceptionRequestInput,
  ) => Promise<AcceptReceptionRequestResult>;
  readonly editGroupCard: (
    chatId: number,
    messageId: number,
    text: string,
  ) => Promise<void>;
  readonly sendDirectMessage: (
    chatId: number,
    text: string,
    entities?: ReadonlyArray<TelegramMessageEntity>,
    replyMarkup?: InlineKeyboardMarkup,
  ) => Promise<void>;
  readonly streetGroupChatId: (street: string) => number | null;
  readonly registerResident: (
    input: RegisterResidentInput,
  ) => Promise<RegisterResidentResult>;
  readonly setTriggerAttribute: (trigger: TelegramTriggerKind) => void;
}

/**
 * Subset of the `classify_dm_intent` tool output the orchestrator
 * consumes. Defined as a structural type so process-update.ts stays
 * decoupled from the tool implementation (factory wires the real
 * tool's `execute` into the dep).
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
 * Decode an inbound Telegram webhook payload into the orchestrator's
 * `Inbound` shape. Returns `null` for updates the channel ignores
 * (edits, reactions, photoless messages without text).
 */
function toInbound(update: TelegramUpdatePayload): Inbound | null {
  const cb = extractInboundCallback(update);
  if (cb) return { kind: "callback", callback: cb };
  const msg = extractInboundMessage(update);
  if (!msg) return null;
  return msg.isGroup
    ? { kind: "group", message: msg }
    : { kind: "dm", message: msg };
}

/**
 * Best-effort passive recording of an inbound Telegram identity.
 * Swallows errors — we never want a Redis hiccup to crash a turn that
 * would otherwise have proceeded — but logs them so silent data loss
 * is visible in the Vercel logs.
 */
async function recordInboundObservation(
  inbound: Inbound,
  deps: ProcessUpdateDeps,
): Promise<void> {
  const meta =
    inbound.kind === "callback"
      ? {
          userId: inbound.callback.fromUserId,
          firstName: inbound.callback.fromFirstName,
          lastName: inbound.callback.fromLastName,
          username: inbound.callback.fromUsername,
          languageCode: inbound.callback.fromLanguageCode,
          chatId: inbound.callback.chatId,
        }
      : {
          userId: inbound.message.fromUserId,
          firstName: inbound.message.fromFirstName,
          lastName: inbound.message.fromLastName,
          username: inbound.message.fromUsername,
          languageCode: inbound.message.fromLanguageCode,
          chatId: inbound.message.chatId,
        };
  if (meta.userId === null || meta.firstName === null) return;
  try {
    await deps.recordTelegramObservation({
      userId: meta.userId,
      firstName: meta.firstName,
      lastName: meta.lastName ?? undefined,
      username: meta.username ?? undefined,
      languageCode: meta.languageCode ?? undefined,
      chatId: meta.chatId,
    });
  } catch (err) {
    console.warn(
      "[process-update] recordTelegramObservation failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Tier 2 mutation rethrow recovery: only reachable via the
 * `register-and-confirm-resident` compound action's `registerResident`
 * call (every other Tier 2 mutation is pre-called by `buildState` per
 * ADR D3 amendment, so its failure is encoded as a State variant rather
 * than a thrown error reaching here).
 *
 * Mirrors the deleted `handleRegistrationDm` fallback: log the error,
 * stamp the trigger attribute, hand the raw text to the agent.
 */
async function fallbackToAgent(
  err: unknown,
  inbound: Inbound,
  deps: ProcessUpdateDeps,
): Promise<void> {
  if (inbound.kind !== "dm") {
    console.error(
      "[process-update] runActions failed for non-DM inbound (unexpected — buildState owns Tier 2 for these surfaces):",
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : err,
    );
    return;
  }
  const msg = inbound.message;
  console.error(
    "[process-update] registration runActions failed for chatId",
    msg.chatId,
    "userId",
    msg.fromUserId,
    "error:",
    err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack }
      : err,
  );
  deps.setTriggerAttribute("telegram.text-dm");
  emitTrace("agent", "start", { trigger: "telegram.text-dm" });
  const auth: TelegramSessionAuth | null =
    msg.fromUserId === null
      ? null
      : {
          principalId: String(msg.fromUserId),
          principalType: "user",
          authenticator: "telegram",
          attributes: msg.fromLanguageCode
            ? { languageCode: msg.fromLanguageCode }
            : {},
        };
  const session = await deps.sendToAsh(msg.text, {
    auth,
    continuationToken: `tg:${msg.chatId}`,
    state: {
      chatId: msg.chatId,
      isGroup: msg.isGroup,
      fromUserId: msg.fromUserId,
      fromLanguageCode: msg.fromLanguageCode,
    },
  });
  deps.waitUntil(deps.drainSession(session, msg.chatId));
}

/**
 * Runs one inbound Telegram webhook delivery through the orchestrator.
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
  // CHANNEL box, regardless of inbound shape.
  emitTrace("channel", "start");

  const inbound = toInbound(update);
  if (!inbound) return new Response(null, { status: 204 });

  await recordInboundObservation(inbound, deps);

  try {
    const state = await buildState(inbound, deps);
    const { actions } = match(state);
    await runActions(actions, deps);
  } catch (err) {
    // Tier 2 mutation rethrow from runActions (only `registerResident`
    // inside `register-and-confirm-resident` rethrows after Slices 3–6;
    // every other Tier 2 mutation is owned by buildState per ADR D3
    // amendment). Fall through to the agent with raw text.
    await fallbackToAgent(err, inbound, deps);
  }
  return new Response(null, { status: 204 });
}
