/**
 * `accept_reception_request` — a candidate neighbor agrees to receive
 * a package for someone who pre-announced they wouldn't be home.
 *
 * Two acceptance paths share this tool:
 *
 *   1. **Legacy DM-3 flow** (`candidateResidentIds` non-empty on the
 *      request). The caller must be in the snapshot — the bot DM'd
 *      them individually. Triggered by a free-text reply
 *      ("ja, ich bin bis 15 Uhr da" / "yes, I'll be in until 6pm") in
 *      DM, or by a `[Ja, ich kann]` button tap.
 *   2. **Flow 2 v2 group-card path** (`candidateResidentIds === []`).
 *      Any registered resident on the request's street can claim —
 *      the neutral group card posted by `create_reception_request`
 *      asked the whole group, not three pre-selected neighbours.
 *      Triggered by a `[Ich kann helfen]` button tap on the card,
 *      which the orchestrator turns into a synthetic intent message.
 *
 * Default selection (when `requestId` is omitted): pick the most
 * recent OPEN ReceptionRequest on the volunteer's street that the
 * caller is eligible to claim under the active path's rule. For
 * group-card requests, any open request on the street is eligible;
 * for DM-3, the volunteer must appear in the snapshot.
 *
 * On success, the tool flips `status: "open"` → `"matched"`, records
 * the volunteer + their availability + `respondedAt`, and returns the
 * updated record plus pre-resolved summaries the model uses to compose
 * the two downstream DMs (volunteer + requester) and the card edit:
 *
 *   - `requester` — id, name, houseNumber, language, floor, buzzerName.
 *   - `volunteer` — id, name, houseNumber, language, floor, buzzerName,
 *     platformId. Surfaced so the requester-facing confirmation DM can
 *     ping the volunteer via a Telegram `text_mention` entity.
 *   - `groupCardChatId` / `groupCardMessageId` — the in-place edit
 *     target (absent on legacy DM-3 records).
 *
 * The street guard ALWAYS fires, including on the group-card path
 * (the orchestrator already scope-checks the tapper, but a defensive
 * backstop here means a cross-street accept can't slip through if the
 * model is ever pointed at a stale request id).
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
  type Resident,
} from "../../lib/redis.js";

export interface RequesterSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
  readonly floor: string | null;
  readonly buzzerName: string | null;
}

export interface VolunteerSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
  readonly floor: string | null;
  readonly buzzerName: string | null;
  readonly platformId: string;
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
        "where the volunteer is eligible. REQUIRED when the caller " +
        "tapped `[Ich kann helfen]` on a group card — the orchestrator " +
        "extracts the id from the callback data (`accept_reception_group:<id>`) " +
        "and threads it into the synthesized intent message.",
    ),
});

function summariseResident(resident: Resident): {
  id: string;
  name: string;
  houseNumber: string;
  language: string | null;
  floor: string | null;
  buzzerName: string | null;
} {
  return {
    id: resident.platformId,
    name: resident.name,
    houseNumber: resident.houseNumber,
    language: resident.language ?? null,
    floor: resident.floor ?? null,
    buzzerName: resident.buzzerName ?? null,
  };
}

export default defineTool({
  description:
    "Claim an open reception request for the calling resident. Use " +
    "when a volunteer agrees to receive a package on behalf of a " +
    "requester who won't be home — either by free-text reply on the " +
    "legacy DM-3 path, or by tapping `[Ich kann helfen]` on a Flow 2 " +
    "v2 group card (in which case the orchestrator synthesizes the " +
    "intent message with the explicit `requestId`). Two acceptance " +
    "rules: (a) DM-3 records require the caller to be in " +
    "`candidateResidentIds`; (b) group-card records (with " +
    "`candidateResidentIds === []`) admit any registered resident on " +
    "the request's street. Returns the updated `request` plus " +
    "`requester` and `volunteer` summaries (id, name, houseNumber, " +
    "floor, buzzerName, language, platformId) so the model can compose " +
    "the operational handoff DM to the volunteer and the named " +
    "confirmation DM to the requester. When the request was created " +
    "via the group-card path, the response also surfaces the card's " +
    "`groupCardChatId` + `groupCardMessageId` so the card can be " +
    "edited in place to '✅ angenommen von <volunteer>'.",
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
          `accept_reception_request: reception request ${requestId} is on a different street — only residents on the same street can claim.`,
        );
      }
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
        .filter(
          (r) =>
            r.candidateResidentIds.length === 0 ||
            r.candidateResidentIds.includes(caller.id),
        )
        .sort((a, b) => b.createdAt - a.createdAt);
      if (eligible.length === 0) {
        throw new Error(
          "accept_reception_request: no open reception request on your street that you can claim.",
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
    const requesterSummary: RequesterSummary = requester
      ? summariseResident(requester)
      : {
          id: updated.requesterResidentId,
          name: updated.requesterName,
          houseNumber: updated.requesterHouseNumber,
          language: null,
          floor: null,
          buzzerName: null,
        };

    const volunteerSummary: VolunteerSummary = {
      ...summariseResident(caller),
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
