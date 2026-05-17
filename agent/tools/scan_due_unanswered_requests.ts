/**
 * `scan_due_unanswered_requests` — find every open `ReceptionRequest`
 * that has sat without a volunteer acceptance for more than 4 hours.
 *
 * Used by `agent/schedules/reception_request_4h_timeout.ts`. The
 * schedule runs every 15 minutes (the 4h SLA needs fine granularity),
 * calls this tool, DMs the requester that no match was found, then
 * calls `mark_reception_request_expired` per entry.
 *
 * Match rule: `status === "open"` AND `createdAt < now - 4h`. The other
 * statuses are out of scope — `matched` is handled by the 48h
 * unfulfilled schedule, `fulfilled` is the happy path that already
 * closed, `expired` is already past.
 *
 * Returns enough requester context per entry so the schedule's agent
 * can DM without an extra `getResident` round-trip per request:
 * requester summary (id, name, houseNumber, language). The requester
 * resident is guaranteed to exist because `create_reception_request`
 * uses the session caller as the requester — but resolution still
 * tolerates a missing record (returns `requester: null`) so a deleted
 * resident can't poison the entire scan.
 *
 * No session auth — schedules run from cron, not a user message. The
 * tool is harmless to call (read-only).
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import {
  getResident,
  listAllReceptionRequests,
  type PackageCarrier,
} from "../../lib/redis.js";

const UNANSWERED_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface DueUnansweredRequesterSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
}

export interface DueUnansweredEntry {
  readonly requestId: string;
  readonly streetId: string;
  readonly carrier: PackageCarrier;
  readonly createdAt: number;
  readonly expectedAt: number | null;
  readonly notes: string | null;
  readonly candidateResidentIds: readonly string[];
  readonly requester: DueUnansweredRequesterSummary | null;
}

function summariseRequester(
  resident: Awaited<ReturnType<typeof getResident>>,
): DueUnansweredRequesterSummary | null {
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
    "List every open ReceptionRequest whose 4h candidate-response " +
    "window has elapsed (status=`open` + createdAt < now-4h). Each " +
    "entry includes a requester summary so you can DM them without a " +
    "second tool call. Use only from the `reception_request_4h_timeout` " +
    "schedule. After DMing, call `mark_reception_request_expired` per " +
    "entry to flip status to `expired`.",
  inputSchema: z.object({}),
  async execute() {
    const now = Date.now();
    const cutoff = now - UNANSWERED_WINDOW_MS;
    const all = await listAllReceptionRequests();
    const due = all.filter(
      (r) => r.status === "open" && r.createdAt < cutoff,
    );

    const entries: DueUnansweredEntry[] = [];
    for (const r of due) {
      const requester = await getResident(r.requesterResidentId);
      entries.push({
        requestId: r.id,
        streetId: r.streetId,
        carrier: r.carrier,
        createdAt: r.createdAt,
        expectedAt: r.expectedAt,
        notes: r.notes ?? null,
        candidateResidentIds: r.candidateResidentIds,
        requester: summariseRequester(requester),
      });
    }
    return { entries, now };
  },
});
