/**
 * Pure-function core of the Flow 1 register-package operation.
 *
 * v2.1 #106 (Flow 1 channel-deterministic refactor, Slice 1): the
 * channel now decides whether a group message is a package
 * registration via `classify_group_message` and, on a high-confidence
 * verdict with a resolved registered recipient, calls
 * `registerPackage` directly — no agent invocation. Same shape as
 * `lib/reception-request.ts::createReceptionRequest` (Slice 1 of the
 * Flow 2 v2.1 refactor / #86).
 *
 * Why a lib module rather than tools-only:
 *
 *   Live trace 2026-05-22 (Flow 1 group photo): the agent emitted 20+
 *   free-form German messages on a single inbound, including references
 *   to deleted tools and v1 form-fill prose. Pulling the register
 *   decision OUT of the model — same fix as Flow 2 (#86, #87, #88,
 *   #89, #96, #97, #100) — closes the text-leak surface structurally:
 *   no model output channel on the happy path means no welcome wall,
 *   no field-name placeholders, no Abgehott typos.
 *
 *   No `getSession()` / Ash context dependency: every input is supplied
 *   by the caller, so the same function is trivially testable and
 *   trivially callable from any context (channel handler, future cron
 *   schedule).
 *
 * @see lib/telegram-channel/process-update.ts  — channel-side call site
 * @see lib/telegram-channel/flow-1-dms.ts      — group ack + DM builders
 */

import {
  findKnownTelegramUserByName,
  findOpenReceptionRequestForRecipient,
  findResidentByNameAndHouse,
  newPackageId,
  setPackage,
  setReceptionRequest,
  type KnownTelegramUser,
  type Package,
  type PackageCarrier,
  type ReceptionRequest,
  type Resident,
} from "./redis.js";

/**
 * Summary of the registered recipient when the parsed name + house
 * number resolves to a Resident. Same shape `register_package` (the
 * deleted tool) returned so downstream consumers (the channel's DM
 * builder) reuse the same fields.
 */
export interface ResidentRecipientSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
  readonly floor: string | null;
  readonly buzzerName: string | null;
}

/**
 * Summary of a known Telegram user (someone who has posted in the
 * group but hasn't `/register`'d). Bot-initiated DMs are blocked for
 * this case; the channel can render their name as a `text_mention` in
 * a group post.
 */
export interface KnownTelegramRecipientSummary {
  readonly userId: number;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly username: string | null;
}

/**
 * Discriminated outcome of the recipient-resolution step inside
 * `registerPackage`. The channel branches on `kind`:
 *
 *   - `"resident"` → channel DMs the recipient via `sendDirectMessage`
 *     using `flow-1-dms.ts::buildRecipientDm`.
 *   - `"known_telegram"` → channel falls through to a clarification
 *     synthetic in Slice 3 (#109). Slice 1 leaves the channel silent
 *     when the recipient is a known TG user but not a resident.
 *   - `"unknown"` → channel falls through to a clarification synthetic
 *     in Slice 3 (#109). Slice 1 leaves the channel silent on this
 *     branch.
 */
export type RecipientResolution =
  | { readonly kind: "resident"; readonly resident: ResidentRecipientSummary }
  | {
      readonly kind: "known_telegram";
      readonly telegram: KnownTelegramRecipientSummary;
    }
  | { readonly kind: "unknown" };

/**
 * Summary of the registered holder. Same shape the deleted
 * `register_package` tool returned; the channel's DM + group-ack
 * builders read fields off this struct.
 */
export interface HolderSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly floor: string | null;
  readonly buzzerName: string | null;
  readonly language: string | null;
}

/**
 * If this Package closes out a pending Flow 2 reception request, the
 * caller (channel) can route a richer fulfillment DM to the original
 * requester. Slice 1 of #106 doesn't act on this directly — the
 * existing Flow 2 fulfillment surface is handled by the agent on the
 * fallthrough — but the field stays here for parity with the deleted
 * tool's return shape.
 */
export interface ReceptionRequestFulfillmentSummary {
  readonly requestId: string;
  readonly requesterResidentId: string;
}

/**
 * Inputs for `registerPackage`. Mirrors the deleted tool's `inputSchema`.
 * `holderPlatformId` is the Telegram `user_id` of the holder; the
 * function loads the full Resident record itself to derive
 * `streetId`, `holder` summary, and the fulfillment lookup. Mirror of
 * `lib/registration.ts::registerResident` and
 * `lib/reception-request.ts::createReceptionRequest` shape.
 */
export interface RegisterPackageInput {
  readonly recipientName: string;
  readonly recipientHouseNumber: string;
  readonly carrier?: PackageCarrier;
  readonly trackingNumber?: string;
}

export interface RegisterPackageResult {
  readonly package: Package;
  readonly holder: HolderSummary;
  readonly recipientResolution: RecipientResolution;
  readonly receptionRequestFulfilled: ReceptionRequestFulfillmentSummary | null;
}

/**
 * Discriminator on errors thrown by `registerPackage`. The channel
 * branches on `.code`:
 *
 *   - `REGISTER_PACKAGE_HOLDER_NOT_REGISTERED` — the caller is not a
 *     registered Resident yet. The channel sends ONE best-effort DM
 *     pointing at `/register` (per #106 acceptance criteria) and
 *     stays silent in the group.
 *
 * Same shape as `AcceptReceptionRequestError` in
 * `lib/reception-request.ts` — typed codes on `.code` so the channel
 * handler can `instanceof`-or-`code`-check without parsing the message
 * string.
 */
export const REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE =
  "REGISTER_PACKAGE_HOLDER_NOT_REGISTERED" as const;

export type RegisterPackageErrorCode =
  typeof REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE;

export class RegisterPackageError extends Error {
  readonly code: RegisterPackageErrorCode;
  constructor(code: RegisterPackageErrorCode, message: string) {
    super(message);
    this.name = "RegisterPackageError";
    this.code = code;
  }
}

function summariseHolder(holder: Resident): HolderSummary {
  return {
    id: holder.id,
    name: holder.name,
    houseNumber: holder.houseNumber,
    floor: holder.floor ?? null,
    buzzerName: holder.buzzerName ?? null,
    language: holder.language ?? null,
  };
}

function summariseResidentRecipient(
  resident: Resident,
): ResidentRecipientSummary {
  return {
    id: resident.id,
    name: resident.name,
    houseNumber: resident.houseNumber,
    language: resident.language ?? null,
    floor: resident.floor ?? null,
    buzzerName: resident.buzzerName ?? null,
  };
}

function summariseKnownTelegramRecipient(
  user: KnownTelegramUser,
): KnownTelegramRecipientSummary {
  return {
    userId: user.userId,
    firstName: user.firstName,
    lastName: user.lastName ?? null,
    username: user.username ?? null,
  };
}

/**
 * Pure recipient-resolution lookup. v2.1 #109 (Slice 3 of #105) uses
 * this when the classifier/vision returns medium confidence so the
 * channel can decide whether to register a Package — at medium-conf
 * we only register when the recipient resolves to a registered
 * Resident; non-resident matches fall through to the agent with the
 * `[FLOW_1 CLARIFICATION]` synthetic so the holder can disambiguate.
 *
 * `registerPackage` calls this internally on the high-conf path, so
 * there's no duplicate Redis traffic — the high-conf flow keeps doing
 * the resolution + Package write atomically.
 */
export async function resolveRecipient(
  recipientName: string,
  recipientHouseNumber: string,
): Promise<RecipientResolution> {
  const recipient = await findResidentByNameAndHouse(
    recipientName,
    recipientHouseNumber,
  );
  if (recipient) {
    return {
      kind: "resident",
      resident: summariseResidentRecipient(recipient),
    };
  }
  const knownUser = await findKnownTelegramUserByName(recipientName);
  if (knownUser) {
    return {
      kind: "known_telegram",
      telegram: summariseKnownTelegramRecipient(knownUser),
    };
  }
  return { kind: "unknown" };
}

/**
 * Register a held Package for the calling holder.
 *
 * The holder MUST be a registered Resident — throws
 * `RegisterPackageError` with code
 * `REGISTER_PACKAGE_HOLDER_NOT_REGISTERED` otherwise. The recipient
 * resolution is informational: a Package row is written even when the
 * recipient isn't a registered resident (the channel may decide to
 * stay silent on that branch — see `recipientResolution.kind`).
 *
 * Resolves a pending Flow 2 `ReceptionRequest` for the same recipient
 * name + house number to `"fulfilled"`. Same behaviour the deleted
 * tool had — the lookup is done here so the channel doesn't have to
 * re-implement it.
 */
export async function registerPackage(
  holder: Resident | null,
  input: RegisterPackageInput,
): Promise<RegisterPackageResult> {
  if (!holder) {
    throw new RegisterPackageError(
      REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE,
      "registerPackage: caller is not a registered resident — they must /register before recording a package they are holding.",
    );
  }

  const resolution = await resolveRecipient(
    input.recipientName,
    input.recipientHouseNumber,
  );

  const openRequest = await findOpenReceptionRequestForRecipient(
    holder.street,
    input.recipientName,
    input.recipientHouseNumber,
  );

  const pkg: Package = {
    id: newPackageId(),
    streetId: holder.street,
    recipientResidentId:
      resolution.kind === "resident" ? resolution.resident.id : null,
    recipientName: input.recipientName,
    recipientHouseNumber: input.recipientHouseNumber,
    holderResidentId: holder.id,
    carrier: input.carrier ?? "unknown",
    trackingNumber: input.trackingNumber,
    status: "held",
    receivedAt: Date.now(),
    pickedUpAt: null,
    reminded: false,
    receptionRequestId: openRequest?.id,
  };

  await setPackage(pkg);

  let fulfillment: ReceptionRequestFulfillmentSummary | null = null;
  if (openRequest) {
    const fulfilledRequest: ReceptionRequest = {
      ...openRequest,
      status: "fulfilled",
    };
    await setReceptionRequest(fulfilledRequest);
    fulfillment = {
      requestId: openRequest.id,
      requesterResidentId: openRequest.requesterResidentId,
    };
  }

  return {
    package: pkg,
    holder: summariseHolder(holder),
    recipientResolution: resolution,
    receptionRequestFulfilled: fulfillment,
  };
}
