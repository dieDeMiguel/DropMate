/**
 * `mark_package_reminded` — flip `reminded: true` on a held Package so
 * the 48h reminder schedule doesn't re-fire on the next tick.
 *
 * Used by `agent/schedules/reminder_48h.ts` immediately after the
 * schedule's agent has DM'd the holder + recipient for a package
 * returned by `scan_due_reminders`. Idempotent — calling it on a
 * package already marked `reminded: true` is a no-op that still
 * reports success.
 *
 * No session auth — schedules run from cron, not a user message.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { getPackage, setPackage, type Package } from "../../lib/redis.js";

export default defineTool({
  description:
    "Set `reminded: true` on a held Package so the 48h reminder cron " +
    "doesn't re-fire. Idempotent — safe to retry. Call once per package " +
    "after DMing the holder + recipient from the `scan_due_reminders` " +
    "result.",
  inputSchema: z.object({
    packageId: z
      .string()
      .min(1)
      .describe(
        "Id of the Package to mark reminded — the `packageId` field " +
          "returned by `scan_due_reminders`.",
      ),
  }),
  async execute({ packageId }) {
    const existing = await getPackage(packageId);
    if (!existing) {
      throw new Error(
        `mark_package_reminded: no package with id=${packageId}.`,
      );
    }
    if (existing.reminded) {
      return { package: existing, alreadyReminded: true };
    }
    const updated: Package = { ...existing, reminded: true };
    await setPackage(updated);
    return { package: updated, alreadyReminded: false };
  },
});
