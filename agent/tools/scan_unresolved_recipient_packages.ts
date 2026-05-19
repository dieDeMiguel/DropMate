/**
 * `scan_unresolved_recipient_packages` — find every held package whose
 * recipient was never identified (no registered Resident and no known
 * Telegram user matched at registration time) AND whose 3-day
 * resolution deadline has elapsed.
 *
 * Used by `agent/schedules/expire_unknown_recipient_3d.ts`. The schedule
 * runs hourly, calls this tool, DMs the holder per entry, then calls
 * `delete_package` to wipe the record. Hard delete (not status flip)
 * keeps this clean of `escalate_7d`'s `"expired"` status — that one is
 * reserved for held packages with an identified recipient that nobody
 * picked up in 7d.
 *
 * Match rule: `status === "held"` AND `recipientResidentId === null`
 * AND `recipientResolutionDeadline !== undefined` AND
 * `recipientResolutionDeadline < now`.
 *
 * - The `status === "held"` guard excludes packages already moved on
 *   (`picked_up`, `expired`).
 * - `recipientResidentId === null` is the safety net: if a follow-up
 *   `register_package` call linked the recipient (Resident discovered
 *   them in the window), don't delete — that record now has an
 *   identified recipient and falls back into the normal lifecycle.
 *   This is the "auto-cancellation" path the issue calls out (re-
 *   register OR /register both clear the deadline implicitly: a fresh
 *   registration produces a new package id; a late /register doesn't
 *   re-link old records, but the holder can DM the bot to re-record
 *   the package once the recipient is known).
 * - `recipientResolutionDeadline !== undefined` filters out packages
 *   registered before this field existed (no deadline set, no expiry)
 *   AND packages that were resolved at registration time (deadline
 *   never set).
 *
 * Returns the holder summary per entry so the schedule's agent can
 * DM them without a second tool call. The recipient is by definition
 * unknown, so no recipient summary is returned.
 *
 * No session auth — schedules run from cron.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { getResident, listAllPackages } from "../../lib/redis.js";

export interface UnresolvedRecipientHolderSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly floor: string | null;
  readonly buzzerName: string | null;
  readonly language: string | null;
}

export interface UnresolvedRecipientEntry {
  readonly packageId: string;
  readonly streetId: string;
  readonly carrier: string;
  readonly receivedAt: number;
  readonly recipientResolutionDeadline: number;
  readonly recipientName: string;
  readonly recipientHouseNumber: string;
  readonly holder: UnresolvedRecipientHolderSummary | null;
}

function summarise(
  resident: Awaited<ReturnType<typeof getResident>>,
): UnresolvedRecipientHolderSummary | null {
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
    "List every held package whose recipient is still unknown 3 days " +
    "after registration (held + recipientResidentId is null + " +
    "recipientResolutionDeadline < now). Each entry includes a holder " +
    "resident summary so you can DM them without a second tool call. " +
    "Use only from the `expire_unknown_recipient_3d` schedule. After " +
    "DMing, call `delete_package` per entry to wipe the record.",
  inputSchema: z.object({}),
  async execute() {
    const now = Date.now();
    const all = await listAllPackages();
    const due = all.filter(
      (p) =>
        p.status === "held" &&
        p.recipientResidentId === null &&
        p.recipientResolutionDeadline !== undefined &&
        p.recipientResolutionDeadline < now,
    );

    const entries: UnresolvedRecipientEntry[] = [];
    for (const p of due) {
      const holder = p.holderResidentId
        ? await getResident(p.holderResidentId)
        : null;
      entries.push({
        packageId: p.id,
        streetId: p.streetId,
        carrier: p.carrier,
        receivedAt: p.receivedAt,
        // Non-null assertion is safe — we filtered above.
        recipientResolutionDeadline: p.recipientResolutionDeadline!,
        recipientName: p.recipientName,
        recipientHouseNumber: p.recipientHouseNumber,
        holder: summarise(holder),
      });
    }
    return { entries, now };
  },
});
