/**
 * `register_expected_delivery` — pre-announce a package the caller is
 * expecting (PRD §3 planner persona).
 *
 * Records an `"expected"` Package keyed to the caller as the recipient.
 * No holder yet: `holderResidentId` is `null` until a neighbor receives
 * the actual delivery (a later slice will link the arrival back to the
 * matching expectation; the seam exists once this tool lands).
 *
 * Strictly private: the model must NOT post the registration to the
 * group (see PRD §9 privacy — expected deliveries are private until
 * they arrive). The instructions stanza spells this out; the tool
 * itself only writes Redis.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import {
  newPackageId,
  packageCarrierSchema,
  setPackage,
  type Package,
} from "../../lib/redis.js";

const inputSchema = z.object({
  expectedDate: z
    .string()
    .date()
    .optional()
    .describe(
      "Expected delivery date in 'YYYY-MM-DD' (e.g. '2026-05-19'). " +
        "Omit if the resident didn't pin a date — the bot still records " +
        "the expectation, just without a target day.",
    ),
  carrier: packageCarrierSchema
    .optional()
    .describe(
      "Carrier if the resident mentioned one (DHL, Hermes, DPD, GLS, " +
        "UPS, Amazon). Omit to default to 'unknown'.",
    ),
  trackingNumber: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Tracking number if the resident provided one. Omit if not given.",
    ),
  notes: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Free-form note from the resident, e.g. 'birthday gift from " +
        "Zalando' or 'fragile — vase'. Omit if no extra context.",
    ),
});

export default defineTool({
  description:
    "Record an expected delivery the calling resident has pre-announced " +
    "(e.g. 'I have a DHL package coming Monday'). Stores a Package with " +
    "status: 'expected' and no holder yet — the recipient is the caller. " +
    "Strictly private: never post the registration to the group. Returns " +
    "the stored Package record.",
  inputSchema,
  async execute({ expectedDate, carrier, trackingNumber, notes }) {
    const caller = await requireRegisteredTelegramCaller(
      "register_expected_delivery",
    );

    const pkg: Package = {
      id: newPackageId(),
      streetId: caller.street,
      recipientResidentId: caller.id,
      recipientName: caller.name,
      recipientHouseNumber: caller.houseNumber,
      holderResidentId: null,
      carrier: carrier ?? "unknown",
      trackingNumber,
      status: "expected",
      receivedAt: Date.now(),
      pickedUpAt: null,
      reminded: false,
      expectedAt: expectedDate ? Date.parse(expectedDate) : null,
      notes,
    };

    await setPackage(pkg);

    return { package: pkg };
  },
});
