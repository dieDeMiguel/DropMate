/**
 * Pure-function core of the reception-request flow (Flow 2 v2 / v2.1).
 *
 * Two operations live here:
 *
 *   - `createReceptionRequest(caller, input)` writes a `ReceptionRequest`,
 *     optionally posts the neutral group card with `[Ich kann helfen]`,
 *     and patches the record with the resulting card location.
 *   - `acceptReceptionRequest(caller, input)` flips an open request to
 *     `"matched"`, records the volunteer + their availability, and
 *     surfaces requester/volunteer summaries the caller needs to compose
 *     the downstream DMs.
 *
 * Why a lib module rather than tools-only:
 *
 *   v2.1 Slice 1 (#86) is the structural fix for the v2 regression
 *   (#85). The card-posting decision must run BEFORE the agent — driven
 *   by the channel layer's deterministic free-text classifier
 *   (`classify_dm_intent`) — so the agent can't accidentally fire
 *   `create_reception_request` from inside a confused multi-turn
 *   reasoning loop. Lifting the logic into a plain function lets the
 *   channel call it directly, without staging an Ash session, while the
 *   existing agent tools (slices 2 & 3 leave them in place as thin
 *   wrappers) continue to work for legacy DM-3 callers.
 *
 *   No `getSession()` / Ash context dependency: every input is supplied
 *   by the caller, so the same functions are trivially testable and
 *   trivially callable from any context (channel handler, agent tool,
 *   schedule).
 *
 * @see agent/tools/create_reception_request.ts — thin wrapper around `createReceptionRequest`
 * @see agent/tools/accept_reception_request.ts — thin wrapper around `acceptReceptionRequest`
 * @see lib/telegram-channel/process-update.ts  — channel-side call site (v2.1 Slice 1)
 */

import { postToGroup } from "./telegram-channel/notify.js";
import {
  getReceptionRequest,
  getResident,
  listReceptionRequestsForStreet,
  newReceptionRequestId,
  setReceptionRequest,
  type PackageCarrier,
  type ReceptionRequest,
  type Resident,
} from "./redis.js";

/**
 * Pre-resolved summary of the request's requester. Surfaced by
 * `acceptReceptionRequest` so the caller can compose the confirmation
 * DM (and, on the channel-side path, the `[VOLUNTEER_ACCEPTED]`
 * synthetic) without re-loading the requester's Resident record.
 */
export interface RequesterSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
  readonly floor: string | null;
  readonly buzzerName: string | null;
}

/**
 * Pre-resolved summary of the accepting volunteer. `platformId` is
 * surfaced so the requester-facing confirmation DM can ping the
 * volunteer via a Telegram `text_mention` MessageEntity.
 */
export interface VolunteerSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly language: string | null;
  readonly floor: string | null;
  readonly buzzerName: string | null;
  readonly platformId: string;
}

/**
 * Inputs for `createReceptionRequest`. Mirrors the agent tool's input
 * schema verbatim so the thin wrapper can pass its parsed input
 * straight through.
 */
export interface CreateReceptionRequestInput {
  readonly expectedDate?: string;
  readonly carrier?: PackageCarrier;
  readonly notes?: string;
  readonly candidateResidentIds?: ReadonlyArray<string>;
  readonly expectedWindowStartAt?: number;
  readonly expectedWindowEndAt?: number;
}

export interface CreateReceptionRequestResult {
  readonly request: ReceptionRequest;
  readonly groupCard?: { readonly chatId: number; readonly messageId?: number };
}

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

/**
 * Write a `ReceptionRequest` for the calling resident.
 *
 * Two modes, switched by `candidateResidentIds`:
 *
 *   1. **One-shot Flow 2 v2 (default)** — omit `candidateResidentIds`
 *      (or pass `[]`). The function writes the record, posts a neutral
 *      group card with `[Ich kann helfen]`, and patches the record
 *      with `groupCardChatId` / `groupCardMessageId` so later edits
 *      (volunteer accept, 4h / 48h timeouts) can target the same
 *      message. The card NEVER names the requester or states their
 *      absence (PRD §9). Missing optional fields just drop their line
 *      from the card.
 *   2. **Soft-deprecated DM-3 flow** — pass non-empty
 *      `candidateResidentIds`. The function stores the snapshot and
 *      skips the group card. v2.1 Slice 5 removes this path entirely;
 *      preserved here so the existing agent-tool wrapper's test suite
 *      passes without behaviour change.
 *
 * Throws when the group-card path needs to post but
 * `TELEGRAM_BOT_TOKEN` / `TELEGRAM_GROUP_CHAT_ID` are missing — the
 * lib intentionally surfaces this rather than silently dropping the
 * card; the orchestrator's catch logs the failure and the agent /
 * channel can decide whether to recover.
 */
export async function createReceptionRequest(
  caller: Resident,
  input: CreateReceptionRequestInput,
): Promise<CreateReceptionRequestResult> {
  const candidates = input.candidateResidentIds ?? [];
  const useGroupCard = candidates.length === 0;

  const base: ReceptionRequest = {
    id: newReceptionRequestId(),
    streetId: caller.street,
    requesterResidentId: caller.id,
    requesterName: caller.name,
    requesterHouseNumber: caller.houseNumber,
    carrier: input.carrier ?? "unknown",
    expectedAt: input.expectedDate ? Date.parse(input.expectedDate) : null,
    notes: input.notes,
    candidateResidentIds: candidates,
    volunteerResidentId: null,
    volunteerAvailability: null,
    status: "open",
    createdAt: Date.now(),
    respondedAt: null,
    expectedWindowStartAt: input.expectedWindowStartAt,
    expectedWindowEndAt: input.expectedWindowEndAt,
  };

  await setReceptionRequest(base);

  if (!useGroupCard) {
    return { request: base };
  }

  const cardText = buildGroupCardText({
    carrier: base.carrier,
    expectedWindowStartAt: input.expectedWindowStartAt,
    expectedWindowEndAt: input.expectedWindowEndAt,
    expectedAt: base.expectedAt,
  });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "createReceptionRequest: TELEGRAM_BOT_TOKEN is not set; cannot post the group card.",
    );
  }
  const groupId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!groupId) {
    throw new Error(
      "createReceptionRequest: TELEGRAM_GROUP_CHAT_ID is not set; cannot resolve the group chat id.",
    );
  }
  const groupChatId = Number(groupId);
  if (!Number.isFinite(groupChatId)) {
    throw new Error(
      `createReceptionRequest: TELEGRAM_GROUP_CHAT_ID=${groupId} is not a valid number.`,
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
}

/**
 * Inputs for `acceptReceptionRequest`. `requestId` is optional: when
 * omitted, the function picks the most recent open request on the
 * caller's street that the caller is eligible to claim.
 */
export interface AcceptReceptionRequestInput {
  readonly availability: string;
  readonly requestId?: string;
}

export interface AcceptReceptionRequestResult {
  readonly request: ReceptionRequest;
  readonly requester: RequesterSummary;
  readonly volunteer: VolunteerSummary;
  readonly groupCardChatId: number | null;
  readonly groupCardMessageId: number | null;
}

/**
 * Flip an open `ReceptionRequest` to `"matched"`, recording the
 * caller as the volunteer with the supplied availability string.
 *
 * Two acceptance rules apply to the request being claimed:
 *
 *   1. **Legacy DM-3 records** (`candidateResidentIds` non-empty):
 *      the caller MUST be in the snapshot list — the bot DM'd them
 *      individually.
 *   2. **Flow 2 v2 group-card records** (`candidateResidentIds === []`):
 *      any registered resident on the request's street can claim.
 *
 * A `streetId` mismatch is always rejected (defensive backstop — the
 * channel-side scope check already gates the tapper, but a lib-level
 * guard prevents a cross-street accept if the caller is ever pointed
 * at a stale request id from a different street).
 */
export async function acceptReceptionRequest(
  caller: Resident,
  input: AcceptReceptionRequestInput,
): Promise<AcceptReceptionRequestResult> {
  let target: ReceptionRequest | null;
  if (input.requestId) {
    target = await getReceptionRequest(input.requestId);
    if (!target) {
      throw new Error(
        `acceptReceptionRequest: no reception request found for id=${input.requestId}.`,
      );
    }
    if (target.status !== "open") {
      throw new Error(
        `acceptReceptionRequest: reception request ${input.requestId} is already ${target.status}, cannot accept.`,
      );
    }
    if (target.streetId !== caller.street) {
      throw new Error(
        `acceptReceptionRequest: reception request ${input.requestId} is on a different street — only residents on the same street can claim.`,
      );
    }
    if (
      target.candidateResidentIds.length > 0 &&
      !target.candidateResidentIds.includes(caller.id)
    ) {
      throw new Error(
        `acceptReceptionRequest: caller ${caller.id} is not in the candidate list for reception request ${input.requestId}.`,
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
        "acceptReceptionRequest: no open reception request on your street that you can claim.",
      );
    }
    target = eligible[0]!;
  }

  const updated: ReceptionRequest = {
    ...target,
    status: "matched",
    volunteerResidentId: caller.id,
    volunteerAvailability: input.availability,
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
}

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
