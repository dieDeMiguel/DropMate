/**
 * `create_reception_request` — record that the calling resident is
 * expecting a package while they won't be home.
 *
 * v2.1 (#86): this file is now a thin wrapper around
 * `lib/reception-request.ts::createReceptionRequest`. The business
 * logic (write request + post group card + patch with card ids) lives
 * in the lib so the channel layer can call it directly without
 * staging an Ash session. This file resolves the Telegram-authenticated
 * caller from session context and delegates to the lib.
 *
 * Two modes (driven by `candidateResidentIds`):
 *
 *   1. **One-shot Flow 2 v2 (default)**: omit `candidateResidentIds`
 *      (or pass `[]`). The lib writes a `ReceptionRequest`, posts a
 *      neutral group card with `[Ich kann helfen]`, and patches the
 *      record with the resulting card location. The card NEVER names
 *      the requester or states their absence — PRD §9 privacy.
 *      Sample card text:
 *
 *          📦 DHL-Paket erwartet morgen 14:00–16:00. Kann jemand
 *          annehmen?
 *
 *      Missing optional fields just drop their line from the card.
 *
 *   2. **Soft-deprecated DM-3 flow**: pass `candidateResidentIds`. The
 *      lib stores the snapshot and skips the group card. v2.1 Slice 5
 *      removes this path entirely; preserved here so any legacy
 *      caller still wins.
 *
 * The carrier / window / notes fields are all optional. The Flow 2 v2
 * acceptance bar is "post the card with whatever we have" — don't
 * withhold the ask just because the model couldn't extract a carrier.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import { createReceptionRequest } from "../../lib/reception-request.js";
import { packageCarrierSchema } from "../../lib/redis.js";

const inputSchema = z
  .object({
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
      .max(3)
      .optional()
      .describe(
        "Soft-deprecated DM-3 flow only. Snapshot of candidate resident " +
          "ids the bot DM'd individually before calling this tool. Omit " +
          "for the one-shot Flow 2 v2 path — that path posts a neutral " +
          "group card and lets any registered resident on the street tap " +
          "`[Ich kann helfen]` to claim. When supplied, max 3 entries.",
      ),
    expectedWindowStartAt: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Optional expected-delivery window start in Unix ms. Both " +
          "`expectedWindowStartAt` and `expectedWindowEndAt` must be " +
          "supplied together or both omitted. When the resident gave " +
          "only a single time point (e.g. 'morgen 14 Uhr'), pass the " +
          "same value for both.",
      ),
    expectedWindowEndAt: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Optional expected-delivery window end in Unix ms. Paired with " +
          "`expectedWindowStartAt`. Must be >= start.",
      ),
  })
  .refine(
    (v) =>
      (v.expectedWindowStartAt === undefined &&
        v.expectedWindowEndAt === undefined) ||
      (v.expectedWindowStartAt !== undefined &&
        v.expectedWindowEndAt !== undefined),
    {
      message:
        "expectedWindowStartAt and expectedWindowEndAt must be supplied together or both omitted",
      path: ["expectedWindowStartAt"],
    },
  )
  .refine(
    (v) =>
      v.expectedWindowStartAt === undefined ||
      v.expectedWindowEndAt === undefined ||
      v.expectedWindowEndAt >= v.expectedWindowStartAt,
    {
      message: "expectedWindowEndAt must be >= expectedWindowStartAt",
      path: ["expectedWindowEndAt"],
    },
  );

export default defineTool({
  description:
    "Record a reception request (the caller expects a package but " +
    "won't be home). Defaults to the Flow 2 v2 one-shot path: posts a " +
    "neutral group card with `[Ich kann helfen]` and stores the " +
    "card's chat/message id for later edits. The card NEVER names the " +
    "requester or states their absence. To use the soft-deprecated " +
    "DM-3 path instead, pass `candidateResidentIds` — the tool then " +
    "skips the group card. Returns the stored ReceptionRequest plus, " +
    "for the one-shot path, the posted card's location.",
  inputSchema,
  async execute({
    expectedDate,
    carrier,
    notes,
    candidateResidentIds,
    expectedWindowStartAt,
    expectedWindowEndAt,
  }) {
    const caller = await requireRegisteredTelegramCaller(
      "create_reception_request",
    );

    return createReceptionRequest(caller, {
      expectedDate,
      carrier,
      notes,
      candidateResidentIds,
      expectedWindowStartAt,
      expectedWindowEndAt,
    });
  },
});

// Re-export `buildGroupCardText` so any external caller still pointed
// at this module's old export keeps working. The implementation moved
// to `lib/reception-request.ts`.
export { buildGroupCardText } from "../../lib/reception-request.js";
