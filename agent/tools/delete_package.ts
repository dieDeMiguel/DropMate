/**
 * `delete_package` — hard-delete a Package record from Redis AND
 * de-index it from `street:<streetId>:packages`. Idempotent: calling
 * on an id that's already gone is a no-op (no throw, the result
 * reports `deleted: false`).
 *
 * Used by `agent/schedules/expire_unknown_recipient_3d.ts`. The
 * schedule runs hourly, scans for held packages whose 3-day recipient-
 * resolution deadline has elapsed (`scan_unresolved_recipient_packages`),
 * DMs the holder per entry, then calls this tool to wipe the record.
 *
 * Hard delete (not `status: "expired"`) keeps this flow from stepping
 * on `escalate_7d`'s `"expired"` status — that one is reserved for
 * held packages with an identified recipient that nobody picked up in
 * 7 days. The two flows operate on disjoint sets:
 *
 *   - 7d escalation: `status === "held"` AND
 *     `recipientResidentId !== null` (or no resolution deadline set).
 *   - 3d unknown-recipient expiry: `status === "held"` AND
 *     `recipientResidentId === null` AND
 *     `recipientResolutionDeadline < now`.
 *
 * No session auth — schedules run from cron, not from a user
 * message. Refuses to operate on packages whose status is not
 * `"held"` because deleting a `"picked_up"` or `"expired"` record
 * would lose history; only the unresolved-recipient flow needs hard
 * delete.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { deletePackage, getPackage } from "../../lib/redis.js";

export default defineTool({
  description:
    "Hard-delete a Package record from Redis and de-index it from " +
    "its street index. Idempotent (calling on a missing id reports " +
    "`deleted: false`). Refuses to operate on packages whose status " +
    "is not `held` — deleting a `picked_up` or `expired` record would " +
    "lose history. Use only from the " +
    "`expire_unknown_recipient_3d` schedule after DMing the holder.",
  inputSchema: z.object({
    packageId: z
      .string()
      .min(1)
      .describe(
        "Id of the Package to delete — the `packageId` field returned " +
          "by `scan_unresolved_recipient_packages`.",
      ),
  }),
  async execute({ packageId }) {
    const existing = await getPackage(packageId);
    if (!existing) {
      return { deleted: false, alreadyGone: true };
    }
    if (existing.status !== "held") {
      throw new Error(
        `delete_package: refusing to delete package with status=${existing.status}; ` +
          "only `held` packages with an unresolved recipient are eligible " +
          "for hard delete.",
      );
    }
    await deletePackage(packageId, existing.streetId);
    return { deleted: true, alreadyGone: false };
  },
});
