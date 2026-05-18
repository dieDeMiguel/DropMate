/**
 * `register_package` — record that the calling resident has received a
 * package on behalf of a neighbor.
 *
 * Use one call per detected package: a message naming two recipients
 * (e.g. "Pakete für <recipient-a> und <recipient-b>") → two calls. The
 * model parses the free-text (or label-photo output in a later slice)
 * into the structured fields below.
 *
 * The holder (caller) is identified from session auth — same pattern
 * as `register_resident`. The holder MUST already be a registered
 * Resident, because the package's `streetId` is derived from the
 * holder's `street`. If the model is asked to register a package on
 * behalf of someone who hasn't done `/register` yet, this tool throws
 * and the orchestrating model should ask the holder to register first.
 *
 * `recipientResidentId` is populated when a Resident exists matching
 * `recipientName` + `recipientHouseNumber`; otherwise it is `null`.
 * That keeps the registry usable even before everyone has signed up.
 */

import { defineTool } from "experimental-ash/tools";
import { getSession } from "experimental-ash/context";
import { z } from "zod";

import {
  findOpenReceptionRequestForRecipient,
  findResidentByNameAndHouse,
  getResident,
  newPackageId,
  setPackage,
  setReceptionRequest,
  type Package,
  type PackageCarrier,
  type ReceptionRequest,
  type Resident,
} from "../../lib/redis.js";

const CARRIERS: readonly PackageCarrier[] = [
  "DHL",
  "Hermes",
  "DPD",
  "GLS",
  "UPS",
  "Amazon",
  "unknown",
];

/**
 * Summary of the resident who pre-announced the package (Flow 2a). Only
 * the fields the model needs to DM them are exposed — the language is
 * load-bearing so the follow-up `notify_recipient` text lands in the
 * right language.
 */
export interface FulfillmentRequesterSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
}

/**
 * Summary of the resident now holding the package. Same shape as
 * `lookup_package`'s `HolderSummary` minus `availabilityPatterns` — the
 * requester needs the address + buzzer to come pick the package up,
 * not the holder's general schedule.
 */
export interface FulfillmentHolderSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly floor: string | null;
  readonly buzzerName: string | null;
}

export interface ReceptionRequestFulfillment {
  readonly requestId: string;
  readonly requester: FulfillmentRequesterSummary;
  readonly holder: FulfillmentHolderSummary;
}

function summariseHolder(holder: Resident): FulfillmentHolderSummary {
  return {
    id: holder.id,
    name: holder.name,
    houseNumber: holder.houseNumber,
    floor: holder.floor ?? null,
    buzzerName: holder.buzzerName ?? null,
  };
}

const inputSchema = z.object({
  recipientName: z
    .string()
    .min(1)
    .describe(
      "Name on the label / in the message, as the holder wrote it " +
        "(family name alone, or full given + family name).",
    ),
  recipientHouseNumber: z
    .string()
    .min(1)
    .describe(
      "Recipient's house number. If the holder didn't say, default to " +
        "the holder's own house number (most common case).",
    ),
  carrier: z
    .enum(CARRIERS as unknown as [PackageCarrier, ...PackageCarrier[]])
    .optional()
    .describe(
      "Carrier if extractable from the message or label (DHL, Hermes, " +
        "DPD, GLS, UPS, Amazon). Use 'unknown' when unclear; omit to " +
        "default to 'unknown'.",
    ),
  trackingNumber: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Tracking number if visible on the label. Omit if not provided.",
    ),
});

export default defineTool({
  description:
    "Record that the calling resident has received a package for a " +
    "neighbor. Call this ONCE PER PACKAGE — a message naming two " +
    "recipients is two calls. The holder is identified by session auth, so " +
    "do not ask for an id. The holder must be registered (via " +
    "`register_resident`) before calling this. Returns the stored " +
    "Package record, a `holder` summary (the actual name, house number, " +
    "floor, and buzzer name of the registered holder — use these strings " +
    "verbatim when composing the group post and recipient DM, do NOT " +
    "invent or templatise them), whether the recipient could be linked " +
    "to an existing Resident, and — if this package fulfils a pending " +
    "'I won't be home' reception request — a `receptionRequestFulfilled` " +
    "block with the requester + holder summary so you can DM the " +
    "requester their pickup directions.",
  inputSchema,
  async execute({ recipientName, recipientHouseNumber, carrier, trackingNumber }) {
    const session = getSession();
    const principal = session.auth.current ?? session.auth.initiator;
    if (!principal || principal.authenticator !== "telegram") {
      throw new Error(
        "register_package requires a Telegram-authenticated caller; " +
          "got authenticator=" +
          (principal?.authenticator ?? "<none>"),
      );
    }
    const holder = await getResident(principal.principalId);
    if (!holder) {
      throw new Error(
        "register_package: caller is not a registered resident yet — " +
          "ask them to /register before you record a package they are holding.",
      );
    }

    const recipient = await findResidentByNameAndHouse(
      recipientName,
      recipientHouseNumber,
    );

    const openRequest = await findOpenReceptionRequestForRecipient(
      holder.street,
      recipientName,
      recipientHouseNumber,
    );

    const pkg: Package = {
      id: newPackageId(),
      streetId: holder.street,
      recipientResidentId: recipient?.id ?? null,
      recipientName,
      recipientHouseNumber,
      holderResidentId: holder.id,
      carrier: carrier ?? "unknown",
      trackingNumber,
      status: "held",
      receivedAt: Date.now(),
      pickedUpAt: null,
      reminded: false,
      receptionRequestId: openRequest?.id,
    };

    await setPackage(pkg);

    let fulfillment: ReceptionRequestFulfillment | null = null;
    if (openRequest) {
      const fulfilledRequest: ReceptionRequest = {
        ...openRequest,
        status: "fulfilled",
      };
      await setReceptionRequest(fulfilledRequest);
      const requesterResident = await getResident(
        openRequest.requesterResidentId,
      );
      fulfillment = {
        requestId: openRequest.id,
        requester: {
          id: openRequest.requesterResidentId,
          name: openRequest.requesterName,
          houseNumber: openRequest.requesterHouseNumber,
          language: requesterResident?.language ?? null,
        },
        holder: summariseHolder(holder),
      };
    }

    return {
      package: pkg,
      // Always include the holder summary — the conversational model
      // needs the *actual* name + house number + buzzer to compose the
      // group post and the recipient DM. Without this, the model
      // hallucinates a German-style placeholder name or copies
      // template-looking field-path tokens from the instructions
      // verbatim. See issue #43 item 2b round 3.
      holder: summariseHolder(holder),
      recipientLinked: recipient !== null,
      receptionRequestFulfilled: fulfillment,
    };
  },
});
