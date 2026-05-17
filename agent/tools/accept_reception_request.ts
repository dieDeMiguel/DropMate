/**
 * `accept_reception_request` — a candidate neighbor agrees to receive
 * a package for someone who pre-announced they wouldn't be home.
 *
 * Triggered when the volunteer DMs the bot something like
 * "ja, ich bin bis 15 Uhr da" / "yes, I'll be in until 6pm". The model
 * extracts the free-text availability window and calls this tool.
 *
 * Default selection: pick the most recent OPEN ReceptionRequest on the
 * volunteer's street where the volunteer's id is in
 * `candidateResidentIds`. This is the spike-scale convenience case —
 * volunteers are realistically responding to the most recent ask. If
 * the volunteer references a specific request id (rare today, but the
 * door is open for inline-keyboard payloads later), the model can pass
 * `requestId` explicitly; the candidate-list check still applies.
 *
 * On success, the tool flips `status: "open"` → `"matched"`, records
 * the volunteer + their availability + `respondedAt`, and returns the
 * updated record plus a `requester` summary the model uses to compose
 * the confirmation DM (via `notify_recipient`). The actual DM is the
 * model's responsibility — this tool only updates state.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import {
  getReceptionRequest,
  getResident,
  listReceptionRequestsForStreet,
  setReceptionRequest,
  type ReceptionRequest,
} from "../../lib/redis.js";

export interface RequesterSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
}

const inputSchema = z.object({
  availability: z
    .string()
    .min(1)
    .describe(
      "The volunteer's own free-text window, e.g. 'bis 15 Uhr', 'until " +
        "6pm', 'all afternoon'. Pass through verbatim — the requester " +
        "reads this in the confirmation DM.",
    ),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional explicit reception-request id. Omit to let the tool " +
        "pick the most recent open request on the volunteer's street " +
        "where the volunteer is a candidate.",
    ),
});

export default defineTool({
  description:
    "Claim an open reception request for the calling resident. Use " +
    "when a volunteer DMs 'ja, ich kann das Paket annehmen' (or any " +
    "language equivalent) and stated an availability window. The " +
    "caller is identified by session auth and must be one of the " +
    "ReceptionRequest's `candidateResidentIds`. Returns the updated " +
    "`request` plus a `requester` summary (id, name, houseNumber, " +
    "language) so the model can compose the confirmation DM via " +
    "`notify_recipient`.",
  inputSchema,
  async execute({ availability, requestId }) {
    const caller = await requireRegisteredTelegramCaller(
      "accept_reception_request",
    );

    let target: ReceptionRequest | null;
    if (requestId) {
      target = await getReceptionRequest(requestId);
      if (!target) {
        throw new Error(
          `accept_reception_request: no reception request found for id=${requestId}.`,
        );
      }
      if (target.status !== "open") {
        throw new Error(
          `accept_reception_request: reception request ${requestId} is already ${target.status}, cannot accept.`,
        );
      }
      if (!target.candidateResidentIds.includes(caller.id)) {
        throw new Error(
          `accept_reception_request: caller ${caller.id} is not in the candidate list for reception request ${requestId}.`,
        );
      }
    } else {
      const all = await listReceptionRequestsForStreet(caller.street);
      const eligible = all
        .filter((r) => r.status === "open")
        .filter((r) => r.candidateResidentIds.includes(caller.id))
        .sort((a, b) => b.createdAt - a.createdAt);
      if (eligible.length === 0) {
        throw new Error(
          "accept_reception_request: no open reception request on your street where you are a candidate.",
        );
      }
      target = eligible[0]!;
    }

    const updated: ReceptionRequest = {
      ...target,
      status: "matched",
      volunteerResidentId: caller.id,
      volunteerAvailability: availability,
      respondedAt: Date.now(),
    };
    await setReceptionRequest(updated);

    const requester = await getResident(updated.requesterResidentId);
    const requesterSummary: RequesterSummary = {
      id: updated.requesterResidentId,
      name: updated.requesterName,
      houseNumber: updated.requesterHouseNumber,
      language: requester?.language ?? null,
    };

    return {
      request: updated,
      requester: requesterSummary,
    };
  },
});
