/**
 * `mark_package_expired` — flip a held Package to `status: "expired"`
 * after the 7d escalation schedule has posted its group announcement.
 *
 * Used by `agent/schedules/escalate_7d.ts`. Idempotent — calling on a
 * package already in `"expired"` is a no-op that still reports
 * success. Refuses to operate on packages in non-terminal non-`held`
 * states (`expected`, `pickup_scheduled`, `picked_up`) because a flip
 * from those to `expired` would be a semantic mistake — the
 * escalation schedule only ever targets `held` packages, so this is
 * a defensive guard against being called with a stale id.
 *
 * No session auth — schedules run from cron.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { getPackage, setPackage, type Package } from "../../lib/redis.js";

export default defineTool({
  description:
    "Set `status: \"expired\"` on a held Package after the 7d group " +
    "escalation has been posted. Idempotent for packages already " +
    "expired; throws for packages in any other non-`held` state.",
  inputSchema: z.object({
    packageId: z
      .string()
      .min(1)
      .describe(
        "Id of the Package to mark expired — the `packageId` field " +
          "returned by `scan_due_escalations`.",
      ),
  }),
  async execute({ packageId }) {
    const existing = await getPackage(packageId);
    if (!existing) {
      throw new Error(
        `mark_package_expired: no package with id=${packageId}.`,
      );
    }
    if (existing.status === "expired") {
      return { package: existing, alreadyExpired: true };
    }
    if (existing.status !== "held") {
      throw new Error(
        `mark_package_expired: refusing to expire package with status=${existing.status}; ` +
          "only `held` packages are eligible for 7d escalation.",
      );
    }
    const updated: Package = { ...existing, status: "expired" };
    await setPackage(updated);
    return { package: updated, alreadyExpired: false };
  },
});
