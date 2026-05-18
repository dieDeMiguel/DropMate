/**
 * `create_reception_request` — record that the calling resident is
 * expecting a package while they won't be home.
 *
 * Two entry shapes coexist in this slice (per issue #50):
 *
 *  1. **Group-card path (default)** — the resident invokes `/receive`
 *     (slash command) or types a natural-language reception request.
 *     This tool posts a neutral group card with a single
 *     `[Ich kann helfen]` button (callback `accept_reception_group:
 *     <requestId>`) and patches the resulting `message_id` back onto
 *     the stored ReceptionRequest. The card NEVER names the requester
 *     or states their absence (privacy framing per PRD §9 — "I'm not
 *     home" messages are never group-posted; the framing here is
 *     implicit absence, explicit delivery: "📦 <carrier>-Paket
 *     erwartet <when>. Kann jemand annehmen?"). `candidateResidentIds`
 *     is left empty on this path — the volunteer self-selects from
 *     the group.
 *
 *  2. **DM-3-candidates path (soft-deprecated)** — the historic Flow 2
 *     shape: `find_available_neighbors` resolves up to 3 candidates,
 *     the bot DMs each, then calls this tool with the snapshot list.
 *     Triggered when `candidateResidentIds` is supplied AND
 *     `postGroupCard !== true`. Kept working for backwards-
 *     compatibility — existing schedules + tests rely on the
 *     `candidateResidentIds` shape. New conversational paths route to
 *     the group-card flow.
 *
 * The group post fires AFTER the initial Redis write, so a partial
 * failure (Bot API rejects, network blip) still leaves a coherent
 * `"open"` record on disk for a retry to find. The patch-write that
 * adds `groupCardMessageId` is a second `setReceptionRequest` call —
 * idempotent overwrite. Strict atomicity is out of scope at spike
 * scale.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import { formatBerlinWindow, formatBerlinRelativeDay } from "../../lib/datetime.js";
import {
  newReceptionRequestId,
  packageCarrierSchema,
  setReceptionRequest,
  type ReceptionRequest,
} from "../../lib/redis.js";
import { postToGroup } from "../../lib/telegram-channel/notify.js";
import type { InlineKeyboardMarkup } from "../../lib/telegram-channel/send.js";

const parseConfidenceSchema = z.enum(["high", "medium", "low"]);

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
      "Carrier if mentioned (DHL, Hermes, DPD, GLS, UPS, FedEx, Amazon). " +
        "Omit to default to 'unknown'.",
    ),
  trackingNumber: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Carrier tracking number if the resident shared one. Surfaces on " +
        "the public group card verbatim so a volunteer can match the " +
        "request to a later label scan or tracking page.",
    ),
  screenshotFileId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Telegram file_id of the tracking-page screenshot when the request " +
        "was entered via the screenshot path. Stored on the record for " +
        "the downstream accept flow (a volunteer on a low-confidence " +
        "parse is shown the original screenshot). Omit on the slash- " +
        "command and natural-language paths.",
    ),
  expectedWindowStart: z
    .number()
    .int()
    .optional()
    .describe(
      "ETA window start as a Unix-ms timestamp. For a single-point ETA " +
        "(e.g. '14:00'), set both `expectedWindowStart` and " +
        "`expectedWindowEnd` to the same value.",
    ),
  expectedWindowEnd: z
    .number()
    .int()
    .optional()
    .describe(
      "ETA window end as a Unix-ms timestamp. Must be supplied together " +
        "with `expectedWindowStart`; the tool refuses one without the " +
        "other so the stored record stays well-formed.",
    ),
  parseConfidence: parseConfidenceSchema
    .optional()
    .describe(
      "Vision-tool confidence when the request was extracted from a " +
        "tracking-page screenshot. Drives the downstream accept flow's " +
        "rich-DM behaviour (a low-confidence parse shows the source " +
        "image to the volunteer). Omit on non-screenshot paths.",
    ),
  notes: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Free-form context the resident gave, e.g. 'signature required' " +
        "or 'small box'. Omit if not provided.",
    ),
  candidateResidentIds: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .optional()
    .describe(
      "Soft-deprecated DM-3-candidates path. Pass the snapshot of " +
        "resident ids the bot just DM'd via `notify_recipient` (1–3). " +
        "When present, the tool skips posting a group card unless " +
        "`postGroupCard: true` is also supplied. New conversational " +
        "paths should omit this and let the group-card flow handle " +
        "volunteer recruitment.",
    ),
  postGroupCard: z
    .boolean()
    .optional()
    .describe(
      "When `true` (the default if `candidateResidentIds` is absent), " +
        "post the neutral [Ich kann helfen] group card and patch the " +
        "resulting message id back onto the record. Set to `false` " +
        "explicitly on the soft-deprecated DM-3-candidates path. The " +
        "card NEVER names the requester or mentions their absence.",
    ),
});

function buildGroupCardText(input: {
  readonly carrier: string;
  readonly trackingNumber?: string;
  readonly expectedWindowStartAt?: number;
  readonly expectedWindowEndAt?: number;
  readonly expectedAt: number | null;
  readonly now: number;
}): string {
  const carrierLabel = input.carrier === "unknown" ? "Paket" : `${input.carrier}-Paket`;
  let when = "";
  if (input.expectedWindowStartAt !== undefined && input.expectedWindowEndAt !== undefined) {
    when = formatBerlinWindow(
      input.expectedWindowStartAt,
      input.expectedWindowEndAt,
      input.now,
    );
  } else if (input.expectedAt !== null) {
    when = formatBerlinRelativeDay(input.expectedAt, input.now);
  }
  const head = when ? `📦 ${carrierLabel} erwartet ${when}.` : `📦 ${carrierLabel} erwartet.`;
  const trackingLine = input.trackingNumber
    ? ` Tracking ${input.trackingNumber}.`
    : "";
  return `${head}${trackingLine} Kann jemand annehmen?`;
}

function buildGroupCardKeyboard(requestId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Ich kann helfen",
          callback_data: `accept_reception_group:${requestId}`,
        },
      ],
    ],
  };
}

export default defineTool({
  description:
    "Record a reception request (the caller expects a package but " +
    "won't be home). Default behaviour: post a neutral public group " +
    "card with an [Ich kann helfen] button; the card never names the " +
    "requester or mentions their absence (PRD §9 privacy framing). The " +
    "soft-deprecated DM-3-candidates path is still available — pass " +
    "`candidateResidentIds` and `postGroupCard: false` if you've " +
    "already DM'd specific candidates via `notify_recipient`. The " +
    "caller is identified by session auth. Returns the stored " +
    "ReceptionRequest plus a `groupCardPosted` flag.",
  inputSchema,
  async execute({
    expectedDate,
    carrier,
    trackingNumber,
    screenshotFileId,
    expectedWindowStart,
    expectedWindowEnd,
    parseConfidence,
    notes,
    candidateResidentIds,
    postGroupCard,
  }) {
    if (
      (expectedWindowStart === undefined) !== (expectedWindowEnd === undefined)
    ) {
      throw new Error(
        "create_reception_request: expectedWindowStart and expectedWindowEnd " +
          "must be supplied together.",
      );
    }
    if (
      expectedWindowStart !== undefined &&
      expectedWindowEnd !== undefined &&
      expectedWindowStart > expectedWindowEnd
    ) {
      throw new Error(
        "create_reception_request: expectedWindowStart must be <= expectedWindowEnd.",
      );
    }

    const caller = await requireRegisteredTelegramCaller(
      "create_reception_request",
    );

    const now = Date.now();
    const baseReq: ReceptionRequest = {
      id: newReceptionRequestId(),
      streetId: caller.street,
      requesterResidentId: caller.id,
      requesterName: caller.name,
      requesterHouseNumber: caller.houseNumber,
      carrier: carrier ?? "unknown",
      expectedAt: expectedDate ? Date.parse(expectedDate) : null,
      notes,
      candidateResidentIds: candidateResidentIds ?? [],
      volunteerResidentId: null,
      volunteerAvailability: null,
      status: "open",
      createdAt: now,
      respondedAt: null,
      trackingNumber,
      screenshotFileId,
      expectedWindowStartAt: expectedWindowStart,
      expectedWindowEndAt: expectedWindowEnd,
      parseConfidence,
    };

    await setReceptionRequest(baseReq);

    // Group-card path is the default. Only the explicit
    // `candidateResidentIds` + `postGroupCard: false` shape opts out.
    const shouldPost = postGroupCard ?? candidateResidentIds === undefined;
    if (!shouldPost) {
      return { request: baseReq, groupCardPosted: false as const };
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "create_reception_request: TELEGRAM_BOT_TOKEN is not set; cannot post the group card.",
      );
    }
    const rawGroupId = process.env.TELEGRAM_GROUP_CHAT_ID;
    if (!rawGroupId) {
      throw new Error(
        "create_reception_request: TELEGRAM_GROUP_CHAT_ID is not set; cannot resolve the group chat id.",
      );
    }
    const groupChatId = Number(rawGroupId);
    if (!Number.isFinite(groupChatId)) {
      throw new Error(
        `create_reception_request: TELEGRAM_GROUP_CHAT_ID=${rawGroupId} is not a valid number.`,
      );
    }

    const cardText = buildGroupCardText({
      carrier: baseReq.carrier,
      trackingNumber: baseReq.trackingNumber,
      expectedWindowStartAt: baseReq.expectedWindowStartAt,
      expectedWindowEndAt: baseReq.expectedWindowEndAt,
      expectedAt: baseReq.expectedAt,
      now,
    });
    const replyMarkup = buildGroupCardKeyboard(baseReq.id);

    const result = await postToGroup(token, groupChatId, cardText, replyMarkup);

    if (typeof result.messageId !== "number") {
      // The card went out but we couldn't capture the message id (mock
      // response in tests, or an unexpected Bot API shape). Leave the
      // record without `groupCardMessageId` — downstream edit slices
      // already noop in that case.
      return { request: baseReq, groupCardPosted: true as const };
    }

    const patched: ReceptionRequest = {
      ...baseReq,
      groupCardChatId: groupChatId,
      groupCardMessageId: result.messageId,
    };
    await setReceptionRequest(patched);

    return { request: patched, groupCardPosted: true as const };
  },
});
