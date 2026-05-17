/**
 * `create_reception_request` — record that the calling resident is
 * expecting a package while they won't be home, and snapshot the
 * neighbors the bot is about to DM with the ask.
 *
 * Flow 2a (per PRD §5): the resident DMs "Ich erwarte morgen ein
 * DHL-Paket und bin nicht da". The model:
 *   1. calls `find_available_neighbors` to get up to 3 candidates,
 *   2. calls `notify_recipient` for each candidate (DM with the ask),
 *   3. calls THIS tool with the candidate ids + expected date so the
 *      record exists for a volunteer's later "ja, ich kann" reply to
 *      attach to (via `accept_reception_request`).
 *
 * Order matters: the candidate DMs go out before this tool writes,
 * because a candidate's "yes" reply needs an open request to claim.
 * The model is responsible for the ordering — tool surface stays
 * orthogonal so each step is auditable.
 *
 * Strictly private: never post the request to the group (PRD §9 —
 * "I'm not home" messages are never group-posted). The instructions
 * stanza spells this out.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import {
  newReceptionRequestId,
  packageCarrierSchema,
  setReceptionRequest,
  type ReceptionRequest,
} from "../../lib/redis.js";

const inputSchema = z.object({
  expectedDate: z
    .string()
    .date()
    .optional()
    .describe(
      "Expected delivery date in 'YYYY-MM-DD' (e.g. '2026-05-19'). " +
        "Omit if the resident didn't pin a day.",
    ),
  carrier: packageCarrierSchema
    .optional()
    .describe(
      "Carrier if mentioned (DHL, Hermes, DPD, GLS, UPS, Amazon). " +
        "Omit to default to 'unknown'.",
    ),
  notes: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Free-form context the resident gave, e.g. 'signature required' " +
        "or 'small box from Zalando'. Omit if not provided.",
    ),
  candidateResidentIds: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .describe(
      "Snapshot of the candidate resident ids the bot just DM'd with the " +
        "ask (1–3). Take this directly from the `find_available_neighbors` " +
        "result so a volunteer's reply can later match against an open " +
        "request without re-running the candidate scan.",
    ),
});

export default defineTool({
  description:
    "Record a reception request (the caller expects a package but " +
    "won't be home). Strictly private — never post to the group. Call " +
    "AFTER `find_available_neighbors` and AFTER you've DM'd each " +
    "candidate via `notify_recipient`. The caller is identified by " +
    "session auth; pass the candidate ids you DM'd as " +
    "`candidateResidentIds`. Returns the stored ReceptionRequest.",
  inputSchema,
  async execute({ expectedDate, carrier, notes, candidateResidentIds }) {
    const caller = await requireRegisteredTelegramCaller(
      "create_reception_request",
    );

    const req: ReceptionRequest = {
      id: newReceptionRequestId(),
      streetId: caller.street,
      requesterResidentId: caller.id,
      requesterName: caller.name,
      requesterHouseNumber: caller.houseNumber,
      carrier: carrier ?? "unknown",
      expectedAt: expectedDate ? Date.parse(expectedDate) : null,
      notes,
      candidateResidentIds,
      volunteerResidentId: null,
      volunteerAvailability: null,
      status: "open",
      createdAt: Date.now(),
      respondedAt: null,
    };

    await setReceptionRequest(req);

    return { request: req };
  },
});
