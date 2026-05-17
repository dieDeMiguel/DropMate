/**
 * `register_package` — record that the calling resident has received a
 * package on behalf of a neighbor.
 *
 * Use one call per detected package: "Pakete für Ritter und Meyer" →
 * two calls. The model parses the free-text (or label-photo output in
 * a later slice) into the structured fields below.
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
  findResidentByNameAndHouse,
  getResident,
  setPackage,
  type Package,
  type PackageCarrier,
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

const inputSchema = z.object({
  recipientName: z
    .string()
    .min(1)
    .describe(
      "Name on the label / in the message, as the holder wrote it. " +
        "E.g. 'Ritter', 'Anna-Sophie Meyer'.",
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
    "neighbor. Call this ONCE PER PACKAGE — e.g. 'Pakete für Ritter und " +
    "Meyer' is two calls. The holder is identified by session auth, so " +
    "do not ask for an id. The holder must be registered (via " +
    "`register_resident`) before calling this. Returns the stored " +
    "Package record plus whether the recipient could be linked to an " +
    "existing Resident.",
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
    };

    await setPackage(pkg);

    return {
      package: pkg,
      recipientLinked: recipient !== null,
    };
  },
});

/**
 * Random id. Not cryptographic; just unique per package. Format
 * `pkg_<timestamp>_<rand>` so logs are scannable.
 */
function newPackageId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `pkg_${ts}_${rand}`;
}
