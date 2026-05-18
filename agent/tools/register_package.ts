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
 * `recipientResidentId` on the Package record is populated when a
 * Resident matches `recipientName` + `recipientHouseNumber`; otherwise
 * it is `null` so the registry stays usable before everyone has signed
 * up. The richer `recipientResolution` return field tells the model
 * how to route the notification: registered Resident (DM), known
 * Telegram user (group `text_mention`), or unknown (ask the group).
 */

import { defineTool } from "experimental-ash/tools";
import { getSession } from "experimental-ash/context";
import { z } from "zod";

import {
  findKnownTelegramUserByName,
  findOpenReceptionRequestForRecipient,
  findResidentByNameAndHouse,
  getResident,
  newPackageId,
  setPackage,
  setReceptionRequest,
  type KnownTelegramUser,
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
  "FedEx",
  "Amazon",
  "unknown",
];

/**
 * Summary of the resident who already exists in the directory and whom
 * the recipient label resolved to. Mirrors the shape used elsewhere
 * when the model needs to DM a recipient — id + name + house number,
 * which is enough to call `notify_recipient`.
 */
export interface ResidentRecipientSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
}

/**
 * Summary of a known Telegram user (someone who has posted in the
 * group or DM'd the bot but hasn't completed `/register`). The bot
 * cannot DM them — Telegram blocks bot-initiated DMs to users who
 * haven't started a private chat — but it CAN render their name as a
 * `text_mention` in a group post via `post_to_group`'s `mentions` arg.
 */
export interface KnownTelegramRecipientSummary {
  readonly userId: number;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly username: string | null;
}

/**
 * Discriminated outcome of the recipient-resolution step inside
 * `register_package`. The model branches on `kind`:
 *
 *   - `"resident"` → DM the recipient via `notify_recipient` with
 *     `resident.id`. Plain text group post is fine (DM already pings).
 *   - `"known_telegram"` → DM is NOT possible. Group post should
 *     `text_mention` the recipient by passing `mentions: [{ name,
 *     telegramUserId }]` to `post_to_group`. Optionally append a brief
 *     "they haven't registered yet — /register to receive DMs" note.
 *   - `"unknown"` → no DM, no mention. The group post asks the group
 *     who the recipient is. The auto-expiry follow-up (#46) cleans up
 *     records that stay unresolved.
 */
export type RecipientResolution =
  | { readonly kind: "resident"; readonly resident: ResidentRecipientSummary }
  | {
      readonly kind: "known_telegram";
      readonly telegram: KnownTelegramRecipientSummary;
    }
  | { readonly kind: "unknown" };

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

function summariseResidentRecipient(
  resident: Resident,
): ResidentRecipientSummary {
  return {
    id: resident.id,
    name: resident.name,
    houseNumber: resident.houseNumber,
    language: resident.language ?? null,
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
    "invent or templatise them), a `recipientResolution` discriminator " +
    "describing how the recipient was identified (`kind` is one of " +
    "`'resident'` → a registered neighbour, DM them via " +
    "`notify_recipient`; `'known_telegram'` → a Telegram user the bot " +
    "has seen in the group but who hasn't registered, render their name " +
    "as a `text_mention` in the group post via `post_to_group`'s " +
    "`mentions` arg; `'unknown'` → nobody matched, ask the group), and " +
    "— if this package fulfils a pending 'I won't be home' reception " +
    "request — a `receptionRequestFulfilled` block with the requester + " +
    "holder summary so you can DM the requester their pickup directions.",
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

    let resolution: RecipientResolution;
    if (recipient) {
      resolution = {
        kind: "resident",
        resident: summariseResidentRecipient(recipient),
      };
    } else {
      const knownUser = await findKnownTelegramUserByName(recipientName);
      if (knownUser) {
        resolution = {
          kind: "known_telegram",
          telegram: summariseKnownTelegramRecipient(knownUser),
        };
      } else {
        resolution = { kind: "unknown" };
      }
    }

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
      recipientResolution: resolution,
      receptionRequestFulfilled: fulfillment,
    };
  },
});
