/**
 * `mark_reception_request_expired` — flip a `ReceptionRequest` to
 * `status: "expired"` after either timeout schedule has DM'd the
 * requester that the request fell through.
 *
 * Shared by both timeout schedules:
 *   - `reception_request_4h_timeout` — open requests that never found
 *     a volunteer.
 *   - `reception_request_48h_timeout` — matched requests where the
 *     volunteer accepted but the package never arrived.
 *
 * Idempotent — calling on a request already in `"expired"` is a no-op
 * that still reports success. Refuses to operate on a `"fulfilled"`
 * request because that's the happy-path terminal state and flipping
 * it to `"expired"` would erase a successful match. `"open"` and
 * `"matched"` are the only pre-terminal states this tool ever sees in
 * practice (the schedule's scan tools only return those).
 *
 * No session auth — schedules run from cron.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import {
  getReceptionRequest,
  setReceptionRequest,
  type ReceptionRequest,
} from "../../lib/redis.js";

export default defineTool({
  description:
    "Set `status: \"expired\"` on a pre-terminal ReceptionRequest after " +
    "either timeout schedule has DM'd the requester. Idempotent for " +
    "requests already expired; throws for `fulfilled` requests (that's " +
    "the happy-path terminal state and must not be overwritten).",
  inputSchema: z.object({
    requestId: z
      .string()
      .min(1)
      .describe(
        "Id of the ReceptionRequest to mark expired — the `requestId` " +
          "field returned by `scan_due_unanswered_requests` or " +
          "`scan_due_unfulfilled_requests`.",
      ),
  }),
  async execute({ requestId }) {
    const existing = await getReceptionRequest(requestId);
    if (!existing) {
      throw new Error(
        `mark_reception_request_expired: no request with id=${requestId}.`,
      );
    }
    if (existing.status === "expired") {
      return { request: existing, alreadyExpired: true };
    }
    if (existing.status === "fulfilled") {
      throw new Error(
        "mark_reception_request_expired: refusing to expire a fulfilled " +
          `request (id=${requestId}); the happy-path terminal state must ` +
          "not be overwritten.",
      );
    }
    const updated: ReceptionRequest = { ...existing, status: "expired" };
    await setReceptionRequest(updated);
    return { request: updated, alreadyExpired: false };
  },
});
