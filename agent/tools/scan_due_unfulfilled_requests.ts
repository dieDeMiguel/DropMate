/**
 * `scan_due_unfulfilled_requests` — find every matched ReceptionRequest
 * whose volunteer accepted more than 48 hours ago but for which no
 * Package has been registered against it yet.
 *
 * Used by `agent/schedules/reception_request_48h_timeout.ts`. The
 * schedule runs every 6 hours (same cadence as `escalate_7d`), calls
 * this tool, DMs the requester that the matched delivery never
 * materialised, then calls `mark_reception_request_expired` per entry.
 *
 * Match rule: `status === "matched"` AND `respondedAt < now - 48h`. A
 * matched request flips to `"fulfilled"` when `register_package`
 * detects a recipient that matches the request (slice #23 wiring); if
 * 48h after the volunteer's accept no Package has arrived against it,
 * the assumption is the delivery never showed.
 *
 * Returns requester + volunteer summaries pre-resolved so the schedule
 * agent can DM the requester (and optionally mention the volunteer's
 * name) without extra `getResident` round-trips. Volunteer is always
 * non-null in `"matched"` status (a request can't reach that state
 * without a volunteer), but resolution still tolerates a missing
 * resident record so a deleted volunteer can't poison the scan.
 *
 * No session auth — schedules run from cron, not a user message.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import {
  getResident,
  listAllReceptionRequests,
  type PackageCarrier,
} from "../../lib/redis.js";

const UNFULFILLED_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface DueUnfulfilledResidentSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
}

export interface DueUnfulfilledEntry {
  readonly requestId: string;
  readonly streetId: string;
  readonly carrier: PackageCarrier;
  readonly createdAt: number;
  readonly respondedAt: number;
  readonly expectedAt: number | null;
  readonly notes: string | null;
  readonly requester: DueUnfulfilledResidentSummary | null;
  readonly volunteer: DueUnfulfilledResidentSummary | null;
}

function summarise(
  resident: Awaited<ReturnType<typeof getResident>>,
): DueUnfulfilledResidentSummary | null {
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
    "List every matched ReceptionRequest whose 48h fulfilment window " +
    "has elapsed (status=`matched` + respondedAt < now-48h). Each " +
    "entry includes requester + volunteer summaries so you can DM the " +
    "requester without a second tool call. Use only from the " +
    "`reception_request_48h_timeout` schedule. After DMing, call " +
    "`mark_reception_request_expired` per entry.",
  inputSchema: z.object({}),
  async execute() {
    const now = Date.now();
    const cutoff = now - UNFULFILLED_WINDOW_MS;
    const all = await listAllReceptionRequests();
    const due = all.filter(
      (r) =>
        r.status === "matched" &&
        r.respondedAt !== null &&
        r.respondedAt < cutoff,
    );

    const entries: DueUnfulfilledEntry[] = [];
    for (const r of due) {
      const requester = await getResident(r.requesterResidentId);
      const volunteer = r.volunteerResidentId
        ? await getResident(r.volunteerResidentId)
        : null;
      entries.push({
        requestId: r.id,
        streetId: r.streetId,
        carrier: r.carrier,
        createdAt: r.createdAt,
        respondedAt: r.respondedAt as number,
        expectedAt: r.expectedAt,
        notes: r.notes ?? null,
        requester: summarise(requester),
        volunteer: summarise(volunteer),
      });
    }
    return { entries, now };
  },
});
