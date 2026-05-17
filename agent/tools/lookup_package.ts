/**
 * `lookup_package` — find held packages addressed to a given recipient
 * on the caller's street.
 *
 * Used in two situations:
 *  1. Flow 1 closing: the recipient DMs "Picked up, thanks!" and the
 *     model needs the Package id to pass to `confirm_pickup`.
 *  2. Flow 3 (#26): "Wo ist mein Paket?" — the model uses the same
 *     lookup before deciding whether to fall back to a group question.
 *
 * The caller's street is read from the session-authenticated holder's
 * own Resident record (same pattern as `register_package`). Cross-
 * street lookups are deliberately not supported in the spike — a
 * resident asking about a package can only find packages on their
 * own street, which matches PRD §9 privacy (data minimisation).
 *
 * Returns every `status: "held"` Package whose `recipientName`
 * case-insensitively matches `recipientName` (either direction —
 * "Meyer" matches "Anna-Sophie Meyer" and vice versa) AND whose
 * `recipientHouseNumber` matches exactly. When `carrier` is provided
 * it further narrows the result. The model is expected to:
 *   - 0 matches → ask whether to query the group (Flow 3) or treat
 *     as "no package to pick up" (Flow 1).
 *   - 1 match → call `confirm_pickup` with the id.
 *   - >1 matches → ask the user to disambiguate (carrier, holder,
 *     or tracking number).
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import {
  listHeldPackagesForStreet,
  packageCarrierSchema,
  type Package,
} from "../../lib/redis.js";

const inputSchema = z.object({
  recipientName: z
    .string()
    .min(1)
    .describe(
      "Recipient name to search for. Case-insensitive substring match " +
        "in either direction, so 'Meyer' finds 'Anna-Sophie Meyer'.",
    ),
  recipientHouseNumber: z
    .string()
    .min(1)
    .describe(
      "Recipient's house number. If the caller didn't say, default to " +
        "the caller's own house number from their Resident record.",
    ),
  carrier: packageCarrierSchema
    .optional()
    .describe(
      "Narrow the search to one carrier when the user mentions it " +
        "(e.g. 'mein DHL Paket').",
    ),
});

export default defineTool({
  description:
    "Find held packages on the caller's street addressed to a given " +
    "recipient. Use before `confirm_pickup` so you know the package id, " +
    "and use as the first step of a 'Wo ist mein Paket?' query. " +
    "Returns 0..N matches — the model is responsible for handling " +
    "the empty / single / ambiguous cases.",
  inputSchema,
  async execute({ recipientName, recipientHouseNumber, carrier }) {
    const caller = await requireRegisteredTelegramCaller("lookup_package");

    const needle = recipientName.trim().toLowerCase();
    const held = await listHeldPackagesForStreet(caller.street);
    const matches = held.filter((pkg) => {
      if (pkg.recipientHouseNumber !== recipientHouseNumber) return false;
      const hay = pkg.recipientName.toLowerCase();
      if (!hay.includes(needle) && !needle.includes(hay)) return false;
      if (carrier !== undefined && pkg.carrier !== carrier) return false;
      return true;
    });

    return {
      matches: matches as readonly Package[],
      count: matches.length,
    };
  },
});
