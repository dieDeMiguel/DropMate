/**
 * Pure-function core of the Flow 1 pickup-confirmation operation.
 *
 * v2.1 #108 (Slice 4 of #105): when the recipient taps `[Abgeholt]`
 * on the group ack posted by Slice 1 (#106) or on the recipient DM,
 * the channel calls `confirmPickup` directly — no agent invocation.
 * Mirrors `lib/reception-request.ts::acceptReceptionRequest`: typed
 * error codes on `.code` so the channel can render dedicated toasts
 * + decide whether to strip the keyboard, no Ash-context dependency
 * so the same function is trivially testable from a unit context
 * and trivially callable from any channel.
 *
 * Why a lib module rather than tools-only:
 *
 *   The pre-#108 surface invoked `confirm_pickup` via the agent (the
 *   channel handed it a `[button-tap] …` synthetic and the agent
 *   ran the tool). That worked, but it left the model with an output
 *   channel on a structurally-mechanical button tap — same regression
 *   surface #100 closed for Flow 2 reception acks. Pulling the
 *   decision OUT of the model is the structural fix.
 *
 * @see lib/telegram-channel/process-update.ts  — channel-side caller
 * @see lib/telegram-channel/pickup-dms.ts      — group-edit + DM builders
 * @see lib/package.ts                           — registerPackage core
 */

import {
  getPackage,
  setPackage,
  type Package,
  type Resident,
} from "./redis.js";

/**
 * Summary of the holder surfaced by `confirmPickup` so the channel
 * can render the holder thanks DM (Slice 4 DMs the holder in their
 * stored language). Mirrors `HolderSummary` from `lib/package.ts`
 * but kept local rather than imported so the two libs don't grow a
 * dependency cycle.
 */
export interface PickupHolderSummary {
  readonly id: string;
  readonly platformId: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
}

/**
 * Summary of the recipient surfaced by `confirmPickup` so the
 * channel can name them in the holder thanks DM. Mirrors
 * `PickupHolderSummary` above.
 */
export interface PickupRecipientSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
}

export interface ConfirmPickupResult {
  readonly package: Package;
  readonly holder: PickupHolderSummary | null;
  readonly recipient: PickupRecipientSummary | null;
}

/**
 * Discriminator on errors thrown by `confirmPickup`. The channel
 * branches on `.code`:
 *
 *   - `PICKUP_NOT_RECIPIENT` — caller is not the package's recipient.
 *     Permanent rejection (a non-recipient will never become the
 *     recipient by re-tapping). Channel renders the dedicated toast
 *     AND strips the keyboard.
 *   - `PICKUP_ALREADY_DONE` — package is already in status
 *     `picked_up`. The keyboard should already be stripped from the
 *     previous success; surface the typed code so the channel can
 *     show a clear "already picked up" toast rather than the generic
 *     retry toast.
 *
 * Same shape as `AcceptReceptionRequestError` in
 * `lib/reception-request.ts` — typed codes on `.code` so the channel
 * handler can `instanceof`-or-`code`-check without parsing the
 * message string.
 */
export const PICKUP_NOT_RECIPIENT_ERROR_CODE =
  "PICKUP_NOT_RECIPIENT" as const;
export const PICKUP_ALREADY_DONE_ERROR_CODE =
  "PICKUP_ALREADY_DONE" as const;

export type ConfirmPickupErrorCode =
  | typeof PICKUP_NOT_RECIPIENT_ERROR_CODE
  | typeof PICKUP_ALREADY_DONE_ERROR_CODE;

export class ConfirmPickupError extends Error {
  readonly code: ConfirmPickupErrorCode;
  constructor(code: ConfirmPickupErrorCode, message: string) {
    super(message);
    this.name = "ConfirmPickupError";
    this.code = code;
  }
}

/**
 * Optional dependency-inject seam for the holder/recipient lookups
 * the lib uses to surface summaries on the result. The channel's
 * factory wires these to `getResident(String(id))` so the test
 * surface can stub them without hauling in Redis. Both lookups
 * return `null` rather than throwing when the resident is unknown
 * (e.g. holder de-registered between the Package being written and
 * the recipient tapping `[Abgeholt]`) — the channel falls back to
 * the names frozen on the Package record in that case.
 */
export interface ConfirmPickupDeps {
  readonly getResidentById: (id: string) => Promise<Resident | null>;
}

function summariseHolder(resident: Resident): PickupHolderSummary {
  return {
    id: resident.id,
    platformId: resident.platformId,
    name: resident.name,
    houseNumber: resident.houseNumber,
    language: resident.language ?? null,
  };
}

function summariseRecipient(resident: Resident): PickupRecipientSummary {
  return {
    id: resident.id,
    name: resident.name,
    houseNumber: resident.houseNumber,
    language: resident.language ?? null,
  };
}

/**
 * Flip a held Package to `picked_up`, recording `pickedUpAt`.
 *
 * Scope rule: only the package's recipient may close it. Throws
 * `ConfirmPickupError` with code `PICKUP_NOT_RECIPIENT` otherwise —
 * the channel renders the dedicated toast and strips the keyboard.
 *
 * Idempotency: a second tap on an already-picked-up package throws
 * `ConfirmPickupError` with code `PICKUP_ALREADY_DONE` rather than
 * silently succeeding, so the channel can show the user a clear
 * "already done" toast.
 *
 * Other Redis hiccups (package not found, lookup throws) propagate
 * as plain `Error`s; the channel logs them and renders the generic
 * retry toast.
 */
export async function confirmPickup(
  caller: Resident,
  packageId: string,
  deps: ConfirmPickupDeps = {
    async getResidentById(id) {
      const { getResident } = await import("./redis.js");
      return getResident(id);
    },
  },
): Promise<ConfirmPickupResult> {
  const existing = await getPackage(packageId);
  if (!existing) {
    throw new Error(
      `confirmPickup: no package with id=${packageId}.`,
    );
  }

  if (existing.recipientResidentId !== caller.id) {
    throw new ConfirmPickupError(
      PICKUP_NOT_RECIPIENT_ERROR_CODE,
      `confirmPickup: caller ${caller.id} is not the recipient of ${packageId} (recipient is ${existing.recipientResidentId ?? "(unset)"})`,
    );
  }

  if (existing.status === "picked_up") {
    throw new ConfirmPickupError(
      PICKUP_ALREADY_DONE_ERROR_CODE,
      `confirmPickup: package ${packageId} is already picked up.`,
    );
  }

  const updated: Package = {
    ...existing,
    status: "picked_up",
    pickedUpAt: Date.now(),
  };
  await setPackage(updated);

  const holderResident = updated.holderResidentId
    ? await deps.getResidentById(updated.holderResidentId).catch(() => null)
    : null;
  const recipientResident = updated.recipientResidentId
    ? await deps.getResidentById(updated.recipientResidentId).catch(() => null)
    : null;

  return {
    package: updated,
    holder: holderResident ? summariseHolder(holderResident) : null,
    recipient: recipientResident ? summariseRecipient(recipientResident) : null,
  };
}
