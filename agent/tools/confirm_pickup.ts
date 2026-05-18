/**
 * `confirm_pickup` — close out a held package once the recipient has
 * collected it (Flow 1 final step).
 *
 * Flips the Package state to `status: "picked_up"` and records
 * `pickedUpAt`. Idempotent: calling it again on an already-picked-up
 * package returns the existing record with `alreadyPickedUp: true`
 * and does NOT bump `pickedUpAt`. The model uses that flag to avoid
 * double-announcing in the group.
 *
 * The caller's identity is taken from session auth, same pattern as
 * the other tools. The caller must be a registered Resident — both
 * so we know which street to compute the remaining-held tally for,
 * and so confirmations from unregistered randoms don't close out
 * packages.
 *
 * Returns the updated Package plus `remainingHeldOnStreet` — the
 * number of packages on the same street still in `status: "held"`
 * after this confirmation. The model uses that count to phrase the
 * group announcement ("1 remaining at <holder-name>", or "all packages
 * picked up") per PRD §5 Flow 1.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import {
  getPackage,
  listHeldPackagesForStreet,
  setPackage,
  type Package,
} from "../../lib/redis.js";

const inputSchema = z.object({
  packageId: z
    .string()
    .min(1)
    .describe(
      "Id of the Package to mark picked up. Obtain via `lookup_package` " +
        "first — never invent an id.",
    ),
});

export default defineTool({
  description:
    "Mark a held Package as picked up. Idempotent — safe to retry. " +
    "Returns the updated record plus the remaining held-package count " +
    "on the same street so you can phrase the group announcement.",
  inputSchema,
  async execute({ packageId }) {
    await requireRegisteredTelegramCaller("confirm_pickup");

    const existing = await getPackage(packageId);
    if (!existing) {
      throw new Error(
        `confirm_pickup: no package with id=${packageId}. Run lookup_package first.`,
      );
    }

    if (existing.status === "picked_up") {
      const remaining = (await listHeldPackagesForStreet(existing.streetId)).length;
      return {
        package: existing,
        alreadyPickedUp: true,
        remainingHeldOnStreet: remaining,
      };
    }

    const updated: Package = {
      ...existing,
      status: "picked_up",
      pickedUpAt: Date.now(),
    };
    await setPackage(updated);
    const remaining = (await listHeldPackagesForStreet(updated.streetId)).length;
    return {
      package: updated,
      alreadyPickedUp: false,
      remainingHeldOnStreet: remaining,
    };
  },
});
