/**
 * `create_reception_request` — record that the calling resident is
 * expecting a package while they won't be home.
 *
 * Two modes:
 *
 *   1. **One-shot Flow 2 v2 (#66, default)**: omit `candidateResidentIds`.
 *      The tool writes the `ReceptionRequest`, posts a neutral group
 *      card with an `[Ich kann helfen]` button, and patches the
 *      record with the resulting `groupCardChatId` / `groupCardMessageId`
 *      so later edits (volunteer accept, 4h / 48h timeouts) can target
 *      the same message. The card NEVER names the requester or states
 *      their absence — PRD §9 privacy. Sample card text:
 *
 *          📦 DHL-Paket erwartet morgen 14:00–16:00. Kann jemand
 *          annehmen?
 *
 *      Missing optional fields just drop their line from the card.
 *
 *   2. **Soft-deprecated DM-3 flow**: pass `candidateResidentIds`. The
 *      tool stores the snapshot and skips the group card. Preserved so
 *      the `expecting_package` skill's older requester path still
 *      works for any caller that still produces it; new code should
 *      prefer mode 1.
 *
 * The carrier / window / notes fields are all optional. The Flow 2 v2
 * acceptance bar is "post the card with whatever we have" — don't
 * withhold the ask just because the model couldn't extract a carrier.
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
import { postToGroup } from "../../lib/telegram-channel/notify.js";

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

    const useGroupCard =
      candidateResidentIds === undefined ||
      candidateResidentIds.length === 0;

    const base: ReceptionRequest = {
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
      createdAt: Date.now(),
      respondedAt: null,
      expectedWindowStartAt,
      expectedWindowEndAt,
    };

    await setReceptionRequest(base);

    if (!useGroupCard) {
      return { request: base };
    }

    const cardText = buildGroupCardText({
      carrier: base.carrier,
      expectedWindowStartAt,
      expectedWindowEndAt,
      expectedAt: base.expectedAt,
    });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "create_reception_request: TELEGRAM_BOT_TOKEN is not set; cannot post the group card.",
      );
    }
    const groupId = process.env.TELEGRAM_GROUP_CHAT_ID;
    if (!groupId) {
      throw new Error(
        "create_reception_request: TELEGRAM_GROUP_CHAT_ID is not set; cannot resolve the group chat id.",
      );
    }
    const groupChatId = Number(groupId);
    if (!Number.isFinite(groupChatId)) {
      throw new Error(
        `create_reception_request: TELEGRAM_GROUP_CHAT_ID=${groupId} is not a valid number.`,
      );
    }

    const sendResult = await postToGroup(token, groupChatId, cardText, {
      inline_keyboard: [
        [
          {
            text: "Ich kann helfen",
            callback_data: `accept_reception_group:${base.id}`,
          },
        ],
      ],
    });

    if (sendResult.messageId === undefined) {
      return { request: base, groupCard: { chatId: groupChatId } };
    }

    const patched: ReceptionRequest = {
      ...base,
      groupCardChatId: groupChatId,
      groupCardMessageId: sendResult.messageId,
    };
    await setReceptionRequest(patched);

    return {
      request: patched,
      groupCard: { chatId: groupChatId, messageId: sendResult.messageId },
    };
  },
});

/**
 * Compose the neutral group-card body. Privacy rule (PRD §9): never
 * name the requester, never say "ich bin nicht zu Hause". The card
 * advertises the package and asks for help; the absence is implicit.
 *
 * Card lines are appended only when their underlying field is set, so
 * the model can pass a sparse record (e.g. carrier without window)
 * and still get a coherent card.
 *
 * Format target (German, since the MVP street is German-speaking; a
 * future per-street localisation slice can swap this for a
 * group-language template lookup):
 *
 *     📦 DHL-Paket erwartet morgen 14:00–16:00. Kann jemand annehmen?
 *
 * Falls back to a fully generic line when no fields are available
 * ("📦 Paket erwartet. Kann jemand annehmen?").
 */
export function buildGroupCardText(input: {
  readonly carrier: ReceptionRequest["carrier"];
  readonly expectedWindowStartAt?: number;
  readonly expectedWindowEndAt?: number;
  readonly expectedAt: ReceptionRequest["expectedAt"];
}): string {
  const subject =
    input.carrier && input.carrier !== "unknown"
      ? `${input.carrier}-Paket`
      : "Paket";

  const windowText = formatExpectedWindow({
    start: input.expectedWindowStartAt,
    end: input.expectedWindowEndAt,
    date: input.expectedAt,
  });

  const head = windowText
    ? `📦 ${subject} erwartet ${windowText}.`
    : `📦 ${subject} erwartet.`;
  return `${head} Kann jemand annehmen?`;
}

function formatExpectedWindow(input: {
  readonly start?: number;
  readonly end?: number;
  readonly date: ReceptionRequest["expectedAt"];
}): string | null {
  if (input.start !== undefined && input.end !== undefined) {
    const startDay = berlinDayKey(input.start);
    const endDay = berlinDayKey(input.end);
    const startTime = formatBerlinTime(input.start);
    const endTime = formatBerlinTime(input.end);
    if (startDay === endDay) {
      const relative = formatRelativeBerlinDay(input.start);
      const dayLabel = relative ?? formatBerlinDate(input.start);
      if (startTime === endTime) {
        return `${dayLabel} um ${startTime}`;
      }
      return `${dayLabel} ${startTime}–${endTime}`;
    }
    return `${formatBerlinDate(input.start)} ${startTime} – ${formatBerlinDate(input.end)} ${endTime}`;
  }
  if (input.date !== null && input.date !== undefined) {
    const relative = formatRelativeBerlinDay(input.date);
    return relative ?? formatBerlinDate(input.date);
  }
  return null;
}

const BERLIN_DAY_FORMATTER = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const BERLIN_DATE_FORMATTER = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "numeric",
  month: "long",
});

const BERLIN_TIME_FORMATTER = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function berlinDayKey(unixMs: number): string {
  return BERLIN_DAY_FORMATTER.format(unixMs);
}

function formatBerlinDate(unixMs: number): string {
  return BERLIN_DATE_FORMATTER.format(unixMs);
}

function formatBerlinTime(unixMs: number): string {
  return BERLIN_TIME_FORMATTER.format(unixMs);
}

function formatRelativeBerlinDay(unixMs: number): string | null {
  const target = berlinDayKey(unixMs);
  const today = berlinDayKey(Date.now());
  if (target === today) return "heute";
  const oneDay = 24 * 60 * 60 * 1000;
  if (target === berlinDayKey(Date.now() + oneDay)) return "morgen";
  if (target === berlinDayKey(Date.now() + 2 * oneDay)) return "übermorgen";
  return null;
}

