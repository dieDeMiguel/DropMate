/**
 * `accept_reception_request` — a neighbor agrees to receive a package
 * for someone who pre-announced they wouldn't be home.
 *
 * Two entry shapes coexist (per issue #52):
 *
 *  1. **Group-card path (default for `/receive` flows)** — a registered
 *     resident tapped `[Ich kann helfen]` on the public group card.
 *     The orchestrator synthesizes a message like
 *     `[button-tap] I'm accepting the reception request <id>…` which
 *     the agent maps to this tool with the explicit `requestId`. The
 *     request's `candidateResidentIds` is empty in this shape (the
 *     volunteer self-selected from the group), so the candidate-list
 *     gate is skipped — any registered resident on the same street can
 *     accept.
 *
 *  2. **DM-3-candidates path (soft-deprecated)** — the historic Flow 2
 *     shape: `find_available_neighbors` resolves up to 3 candidates,
 *     each is DM'd, and a candidate replies with their availability
 *     window. The agent calls this tool without `requestId`; the tool
 *     auto-picks the most recent open request on the caller's street
 *     where the caller is in `candidateResidentIds`. The candidate-list
 *     check is enforced because the request was created with explicit
 *     pre-selection.
 *
 * The street guard always applies — even on the group-card path, the
 * tapper must be a registered resident on the same street as the
 * request, otherwise the channel-layer scope check should have
 * rejected the tap upstream (it's defensive at the tool layer).
 *
 * On success, the tool flips `status: "open"` → `"matched"`, records
 * the volunteer + availability + `respondedAt`, and returns:
 *   - the updated `request`
 *   - a `requester` summary (id, name, houseNumber, language) for the
 *     confirmation DM to the original requester
 *   - a `volunteer` summary (id, name, houseNumber, floor, buzzerName,
 *     language) for the rich "operational handoff" DM the volunteer
 *     needs in the group-card path (carrier + tracking + window + the
 *     requester's location)
 *   - the optional `groupCardChatId`/`groupCardMessageId` so the model
 *     can drive the card edit via the channel-layer `editGroupCard`
 *     primitive (slice #53 reuses these for timeout edits)
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

export interface VolunteerSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly floor: string | null;
  readonly buzzerName: string | null;
  readonly language: string | null;
  readonly platformId: string;
}

const inputSchema = z.object({
  availability: z
    .string()
    .min(1)
    .describe(
      "The volunteer's own free-text window, e.g. 'bis 15 Uhr', 'until " +
        "6pm', 'all afternoon'. Pass through verbatim — the requester " +
        "reads this in the confirmation DM. For group-card taps where " +
        "the volunteer hasn't stated a window yet, ask one short " +
        "follow-up question before calling this tool.",
    ),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Explicit reception-request id. Always present on the group-card " +
        "path (the orchestrator's synthesized [button-tap] message " +
        "names it). Omit on the soft-deprecated DM-3-candidates path " +
        "to let the tool pick the most recent open request on the " +
        "caller's street where they're a candidate.",
    ),
});

export default defineTool({
  description:
    "Claim an open reception request for the calling resident. Two " +
    "entry shapes: the group-card path (volunteer tapped " +
    "[Ich kann helfen] on a public card; `requestId` is supplied and " +
    "the candidate-list check is skipped), and the soft-deprecated " +
    "DM-3-candidates path (volunteer DMs back to a pre-selection; " +
    "`requestId` omitted, the tool auto-picks and enforces the " +
    "candidate list). The caller is identified by session auth and " +
    "must be a registered resident on the same street as the request. " +
    "Returns the updated `request`, a `requester` summary, a " +
    "`volunteer` summary (with floor + buzzer for the operational " +
    "handoff DM), and the optional `groupCardChatId`/`groupCardMessageId` " +
    "for the model to drive the public card edit.",
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
      if (target.streetId !== caller.street) {
        throw new Error(
          `accept_reception_request: caller is on ${caller.street}, request ${requestId} is on ${target.streetId}.`,
        );
      }
      // Candidate-list gate only applies to the soft-deprecated DM-3
      // path (records with a non-empty candidate snapshot). Group-card
      // requests have `candidateResidentIds: []` — the volunteer
      // self-selected from the group, so any registered resident on
      // the same street can accept.
      if (
        target.candidateResidentIds.length > 0 &&
        !target.candidateResidentIds.includes(caller.id)
      ) {
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

    const volunteerSummary: VolunteerSummary = {
      id: caller.id,
      name: caller.name,
      houseNumber: caller.houseNumber,
      floor: caller.floor ?? null,
      buzzerName: caller.buzzerName ?? null,
      language: caller.language ?? null,
      platformId: caller.platformId,
    };

    return {
      request: updated,
      requester: requesterSummary,
      volunteer: volunteerSummary,
      groupCardChatId: updated.groupCardChatId ?? null,
      groupCardMessageId: updated.groupCardMessageId ?? null,
    };
  },
});
