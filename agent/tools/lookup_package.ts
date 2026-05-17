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
  getResident,
  listHeldPackagesForStreet,
  packageCarrierSchema,
  type Package,
  type Resident,
} from "../../lib/redis.js";

/**
 * Holder summary returned alongside each match so the model can compose a
 * Flow 3 reply ("Wo ist mein Paket?") without a follow-up tool call. Only
 * the fields the recipient needs to find the package are exposed —
 * `platformId`, `availabilityPatterns`, `language` etc. stay private to
 * the Resident record. `null` when the holder Resident is missing from
 * Redis (shouldn't happen post-`register_package`, but we degrade
 * gracefully rather than crashing the lookup).
 */
export interface HolderSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly floor: string | null;
  readonly buzzerName: string | null;
  readonly availabilityPatterns: readonly string[];
}

export interface LookupMatch {
  readonly package: Package;
  readonly holder: HolderSummary | null;
}

function summariseHolder(holder: Resident): HolderSummary {
  return {
    id: holder.id,
    name: holder.name,
    houseNumber: holder.houseNumber,
    floor: holder.floor ?? null,
    buzzerName: holder.buzzerName ?? null,
    availabilityPatterns: holder.availabilityPatterns,
  };
}

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
    "Returns `{ matches, count }` where each match is " +
    "`{ package, holder }` — `package` is the Package record (pass " +
    "`package.id` to `confirm_pickup`), `holder` is a summary of the " +
    "neighbor holding it (name, house number, floor, buzzer, " +
    "availability patterns) or `null` if the holder's Resident is " +
    "missing. Lets you compose pickup directions in one turn. The " +
    "model is responsible for handling the empty / single / ambiguous " +
    "cases.",
  inputSchema,
  async execute({ recipientName, recipientHouseNumber, carrier }) {
    const caller = await requireRegisteredTelegramCaller("lookup_package");

    const needle = recipientName.trim().toLowerCase();
    const held = await listHeldPackagesForStreet(caller.street);
    const packages = held.filter((pkg) => {
      if (pkg.recipientHouseNumber !== recipientHouseNumber) return false;
      const hay = pkg.recipientName.toLowerCase();
      if (!hay.includes(needle) && !needle.includes(hay)) return false;
      if (carrier !== undefined && pkg.carrier !== carrier) return false;
      return true;
    });

    const matches: LookupMatch[] = await Promise.all(
      packages.map(async (pkg) => {
        if (pkg.holderResidentId === null) {
          return { package: pkg, holder: null };
        }
        const holder = await getResident(pkg.holderResidentId);
        return {
          package: pkg,
          holder: holder ? summariseHolder(holder) : null,
        };
      }),
    );

    return {
      matches: matches as readonly LookupMatch[],
      count: matches.length,
    };
  },
});
