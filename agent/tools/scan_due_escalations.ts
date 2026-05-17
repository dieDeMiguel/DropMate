/**
 * `scan_due_escalations` — find every held package that has sat for
 * more than 7 days. The 7d escalation schedule (`escalate_7d`) calls
 * this to surface neglected packages for a group announcement and a
 * status flip to `"expired"`.
 *
 * Match rule: `status === "held"` AND `receivedAt < now - 7d`. The
 * `reminded` flag does not matter here — escalation runs whether or
 * not the 48h reminder fired. Other statuses are out of scope.
 *
 * Returns enough holder + recipient context per entry so the
 * schedule's agent can craft a single group post mentioning the
 * package without an extra `getResident` round-trip per match.
 *
 * No session auth — schedules run from cron, not a user message.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { getResident, listAllPackages } from "../../lib/redis.js";

const ESCALATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface DueEscalationResidentSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
}

export interface DueEscalationEntry {
  readonly packageId: string;
  readonly streetId: string;
  readonly carrier: string;
  readonly receivedAt: number;
  readonly recipientName: string;
  readonly recipientHouseNumber: string;
  readonly holder: DueEscalationResidentSummary | null;
  readonly recipient: DueEscalationResidentSummary | null;
}

function summarise(
  resident: Awaited<ReturnType<typeof getResident>>,
): DueEscalationResidentSummary | null {
  if (!resident) return null;
  return {
    id: resident.id,
    name: resident.name,
    houseNumber: resident.houseNumber,
    language: resident.language ?? null,
  };
}

export default defineTool({
  description:
    "List every held package whose 7d escalation is due (held + " +
    "receivedAt < now-7d). Each entry includes holder + recipient " +
    "resident summaries. Use only from the `escalate_7d` schedule. " +
    "After posting the group escalation, call `mark_package_expired` " +
    "per package to flip status from `held` to `expired`.",
  inputSchema: z.object({}),
  async execute() {
    const now = Date.now();
    const cutoff = now - ESCALATION_WINDOW_MS;
    const all = await listAllPackages();
    const due = all.filter(
      (p) => p.status === "held" && p.receivedAt < cutoff,
    );

    const entries: DueEscalationEntry[] = [];
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
