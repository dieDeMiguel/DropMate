/**
 * `scan_due_reminders` — find every held package whose 48h reminder
 * window has elapsed but which hasn't been reminded yet.
 *
 * Used by `agent/schedules/reminder_48h.ts`. The schedule runs hourly,
 * calls this tool, and for each returned entry DMs the holder + the
 * recipient (when registered), then calls `mark_package_reminded` to
 * flip `reminded: true` so the next tick doesn't re-fire.
 *
 * The match rule: `status === "held"` AND `reminded === false` AND
 * `receivedAt < now - 48h`. Other statuses (`expected`, `picked_up`,
 * `expired`) are out of scope — `expected` hasn't arrived yet,
 * `picked_up` is done, `expired` is already past the reminder phase
 * and is handled by `escalate_7d` instead.
 *
 * Returns enough resident context per entry so the schedule's agent
 * can compose DMs without an extra `getResident` round-trip per
 * package: holder + recipient summaries (id, name, houseNumber,
 * floor, buzzerName, language). `recipient` is `null` when the
 * package's `recipientResidentId` is null (the recipient never
 * registered) — the agent then has to skip the recipient DM and
 * still send the holder one as a courtesy.
 *
 * No session auth — schedules run from cron, not from a user
 * message. The tool is harmless to call (read-only) and the writes
 * happen in a separate tool (`mark_package_reminded`).
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { getResident, listAllPackages } from "../../lib/redis.js";

const REMINDER_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface DueReminderResidentSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly floor: string | null;
  readonly buzzerName: string | null;
  readonly language: string | null;
}

export interface DueReminderEntry {
  readonly packageId: string;
  readonly streetId: string;
  readonly carrier: string;
  readonly receivedAt: number;
  readonly recipientName: string;
  readonly recipientHouseNumber: string;
  readonly holder: DueReminderResidentSummary | null;
  readonly recipient: DueReminderResidentSummary | null;
}

function summarise(
  resident: Awaited<ReturnType<typeof getResident>>,
): DueReminderResidentSummary | null {
  if (!resident) return null;
  return {
    id: resident.id,
    name: resident.name,
    houseNumber: resident.houseNumber,
    floor: resident.floor ?? null,
    buzzerName: resident.buzzerName ?? null,
    language: resident.language ?? null,
  };
}

export default defineTool({
  description:
    "List every held package whose 48h reminder is due (held + not " +
    "reminded + receivedAt < now-48h). Each entry includes holder + " +
    "recipient resident summaries so you can DM them without a second " +
    "tool call. Use only from the `reminder_48h` schedule. After DMing, " +
    "call `mark_package_reminded` per package to prevent re-firing.",
  inputSchema: z.object({}),
  async execute() {
    const now = Date.now();
    const cutoff = now - REMINDER_WINDOW_MS;
    const all = await listAllPackages();
    const due = all.filter(
      (p) =>
        p.status === "held" &&
        p.reminded === false &&
        p.receivedAt < cutoff,
    );

    const entries: DueReminderEntry[] = [];
    for (const p of due) {
      const holder = p.holderResidentId
        ? await getResident(p.holderResidentId)
        : null;
      const recipient = p.recipientResidentId
        ? await getResident(p.recipientResidentId)
        : null;
      entries.push({
        packageId: p.id,
        streetId: p.streetId,
        carrier: p.carrier,
        receivedAt: p.receivedAt,
        recipientName: p.recipientName,
        recipientHouseNumber: p.recipientHouseNumber,
        holder: summarise(holder),
        recipient: summarise(recipient),
      });
    }
    return { entries, now };
  },
});
