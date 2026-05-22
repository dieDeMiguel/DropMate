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
 *   (`classify_dm_intent`) — so the agent cannot accidentally fire
 *   the request from inside a confused multi-turn reasoning loop.
 *   Slice 5 (#90) hard-deleted the legacy agent-tool wrappers so the
 *   channel layer is the only call site.
 *
 *   No `getSession()` / Ash context dependency: every input is supplied
 *   by the caller, so the same functions are trivially testable and
 *   trivially callable from any context (channel handler, schedule).
 *
 * @see lib/telegram-channel/process-update.ts  — channel-side call site
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
 * `acceptReceptionRequest` so the caller (the channel's
 * `handleAcceptReceptionGroup`) can render the requester-facing
 * confirmation DM without re-loading the requester's Resident record.
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
 * Inputs for `createReceptionRequest`. Consumed by the channel-side
 * Flow 2 path in `lib/telegram-channel/process-update.ts` for free-text
 * DMs, `/receive` slash commands, and tracking-page screenshots.
 */
export interface CreateReceptionRequestInput {
  readonly expectedDate?: string;
  readonly carrier?: PackageCarrier;
  readonly notes?: string;
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
 * Write a `ReceptionRequest` for the calling resident and post the
 * neutral group card with `[Ich kann helfen]`.
 *
 * The function writes the record, posts the card, and patches the
 * record with `groupCardChatId` / `groupCardMessageId` so later edits
 * (volunteer accept, 4h / 48h timeouts) can target the same message.
 * The card NEVER names the requester or states their absence (PRD §9).
 * Missing optional fields just drop their line from the card.
 *
 * Throws when the group-card post needs `TELEGRAM_BOT_TOKEN` /
 * `TELEGRAM_GROUP_CHAT_ID` and they are missing — the lib intentionally
 * surfaces this rather than silently dropping the card; the
 * orchestrator's catch logs the failure and the channel can decide
 * whether to recover.
 */
export async function createReceptionRequest(
  caller: Resident,
  input: CreateReceptionRequestInput,
): Promise<CreateReceptionRequestResult> {
  const base: ReceptionRequest = {
    id: newReceptionRequestId(),
    streetId: caller.street,
    requesterResidentId: caller.id,
    requesterName: caller.name,
    requesterHouseNumber: caller.houseNumber,
    carrier: input.carrier ?? "unknown",
    expectedAt: input.expectedDate ? Date.parse(input.expectedDate) : null,
    notes: input.notes,
    volunteerResidentId: null,
    volunteerAvailability: null,
    status: "open",
    createdAt: Date.now(),
    respondedAt: null,
    expectedWindowStartAt: input.expectedWindowStartAt,
    expectedWindowEndAt: input.expectedWindowEndAt,
  };

  await setReceptionRequest(base);

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
 * Inputs for `acceptReceptionRequest`. Both fields are optional:
 *
 *   - `requestId` — the channel-side Flow 2 v2 group-card path (v2.1
 *     Slice 4 / #89) always passes the explicit id from the callback
 *     data. Omit to let the function pick the most recent open request
 *     on the caller's street.
 *   - `availability` — the channel path accepts on the tap alone (the
 *     `[Ich kann helfen]` tap is itself the "I can help" signal — no
 *     additional follow-up question), so this field is currently
 *     unused in practice. Kept on the type so a future schedule or
 *     external caller can pass a stated window if needed.
 */
export interface AcceptReceptionRequestInput {
  readonly availability?: string;
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
 * Discriminator on errors thrown by `acceptReceptionRequest` so the
 * channel handler can render the right toast and decide whether to strip
 * the keyboard.
 *
 * v2.1 #96 Part B: a cross-street accept is a permanent rejection — the
 * tapper's stored `Resident.street` differs from the request's `streetId`
 * and that does not change without the user re-registering. The button
 * SHOULD disappear (no retry possible), and the toast SHOULD spell out
 * the constraint rather than the generic "try again". Every other failure
 * class (Redis hiccup, request gone, already matched, lookup race) is
 * recoverable from the user's perspective, so those keep the keyboard
 * live and the generic toast.
 *
 * The error class carries the discriminator on `.code` so the handler
 * can `instanceof`-or-`code`-check without parsing the message string.
 */
export const ACCEPT_DIFFERENT_STREET_ERROR_CODE =
  "ACCEPT_DIFFERENT_STREET" as const;

/**
 * v2.1 #98: a self-accept attempt — the caller is the request's own
 * requester, which is a permanent rejection (the request's
 * `requesterResidentId` doesn't change). Surfaced as a typed code so the
 * channel handler can render a dedicated toast and strip the keyboard
 * (the same shape as the cross-street rejection — a permanent reject
 * shouldn't leave a live retry button under the volunteer's finger).
 *
 * Live trace 2026-05-22 (prod `dpl_8A1T6ECT4ttiWRnBHot7Sa3vEUC9`): a
 * requester accidentally typed `Si` in the group, the channel routed it
 * as an accept tap targeting their own card, the lib happily flipped
 * the request to `matched` with `volunteerResidentId === requesterResidentId`,
 * and the downstream DM-pair fired (the requester DM'd themselves the
 * "thanks for helping" template). The data path then contradicted itself
 * and surfaced the v1-style 12-message cascade.
 */
export const ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE =
  "ACCEPT_RECEPTION_SELF_NOT_ALLOWED" as const;

export type AcceptReceptionRequestErrorCode =
  | typeof ACCEPT_DIFFERENT_STREET_ERROR_CODE
  | typeof ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE;

export class AcceptReceptionRequestError extends Error {
  readonly code: AcceptReceptionRequestErrorCode;
  constructor(code: AcceptReceptionRequestErrorCode, message: string) {
    super(message);
    this.name = "AcceptReceptionRequestError";
    this.code = code;
  }
}

/**
 * Flip an open `ReceptionRequest` to `"matched"`, recording the
 * caller as the volunteer.
 *
 * Acceptance rule: any registered resident on the request's street can
 * claim. A `streetId` mismatch is rejected (defensive backstop — the
 * channel-side scope check already gates the tapper, but a lib-level
 * guard prevents a cross-street accept if the caller is ever pointed
 * at a stale request id from a different street).
 *
 * v2.1 Bug 3 (#95): each step logs `[acceptReceptionRequest] <step>`
 * before its await so a thrown error (or downstream rejection) gives
 * an unambiguous trail in Vercel logs about which subroutine failed.
 * The live trace at #92 surfaced this function throwing under conditions
 * the truncated log made impossible to root-cause; per-step labels
 * close that gap so the next failure shows exactly which call hiccupped
 * (e.g. `getReceptionRequest` vs `setReceptionRequest` vs
 * `getResident`) without needing to bisect the function.
 */
export async function acceptReceptionRequest(
  caller: Resident,
  input: AcceptReceptionRequestInput,
): Promise<AcceptReceptionRequestResult> {
  const logCtx = {
    callerPlatformId: caller.platformId,
    callerStreet: caller.street,
    requestId: input.requestId ?? "(none — picking most-recent open)",
  };

  let target: ReceptionRequest | null;
  if (input.requestId) {
    try {
      console.info(
        "[acceptReceptionRequest] step=getReceptionRequest",
        logCtx,
      );
      target = await getReceptionRequest(input.requestId);
    } catch (err) {
      throw wrapStepError("getReceptionRequest", logCtx, err);
    }
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
    // Cross-street guard moved below the self-accept guard so #98's
    // permanent-reject toast surfaces first when both conditions hold.
    // (In practice they don't co-occur: a request's `streetId` is the
    // requester's street at creation, so a self-accept never has a
    // cross-street mismatch. Order matters anyway as a contract — see
    // #98 acceptance criteria.)
  } else {
    let all: readonly ReceptionRequest[];
    try {
      console.info(
        "[acceptReceptionRequest] step=listReceptionRequestsForStreet",
        logCtx,
      );
      all = await listReceptionRequestsForStreet(caller.street);
    } catch (err) {
      throw wrapStepError("listReceptionRequestsForStreet", logCtx, err);
    }
    const eligible = all
      .filter((r) => r.status === "open")
      .sort((a, b) => b.createdAt - a.createdAt);
    if (eligible.length === 0) {
      throw new Error(
        "acceptReceptionRequest: no open reception request on your street that you can claim.",
      );
    }
    target = eligible[0]!;
  }

  // #98: self-accept guard. The requester cannot volunteer for their own
  // card — there is no "I'll receive my own package while I'm not home"
  // semantic. The check runs after `target` is fully resolved (both the
  // explicit `requestId` branch and the implicit "most-recent open on my
  // street" branch funnel through here) and BEFORE the canonical state
  // flip, so a self-accept never lands `volunteerResidentId === requesterResidentId`
  // in Redis. Surfaced as a typed code so the channel handler can render
  // a dedicated toast and strip the keyboard (a permanent rejection
  // shouldn't leave a retry button live).
  //
  // Acceptance-criteria order (#98): self FIRST, then cross-street, then
  // Redis-fetch errors (which are surfaced earlier in the function).
  // Self-accept is the most clear-cut rejection — surface it directly
  // without leaking that streetIds also matter.
  if (target.requesterResidentId === caller.id) {
    throw new AcceptReceptionRequestError(
      ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE,
      `acceptReceptionRequest: caller ${caller.id} is the requester of ${target.id} — cannot volunteer for your own request.`,
    );
  }

  // #96 Part B: cross-street guard. Only triggers on the explicit
  // `requestId` branch in practice — the else-branch already filtered to
  // `caller.street` — but kept here so a future caller that resolves
  // `target` in some other way can't bypass the constraint.
  if (target.streetId !== caller.street) {
    throw new AcceptReceptionRequestError(
      ACCEPT_DIFFERENT_STREET_ERROR_CODE,
      `acceptReceptionRequest: reception request ${target.id} is on a different street — only residents on the same street can claim.`,
    );
  }

  const updated: ReceptionRequest = {
    ...target,
    status: "matched",
    volunteerResidentId: caller.id,
    volunteerAvailability: input.availability ?? null,
    respondedAt: Date.now(),
  };
  try {
    console.info(
      "[acceptReceptionRequest] step=setReceptionRequest",
      { ...logCtx, targetId: updated.id },
    );
    await setReceptionRequest(updated);
  } catch (err) {
    throw wrapStepError("setReceptionRequest", { ...logCtx, targetId: updated.id }, err);
  }

  let requester: Resident | null;
  try {
    console.info(
      "[acceptReceptionRequest] step=getResident(requester)",
      { ...logCtx, requesterResidentId: updated.requesterResidentId },
    );
    requester = await getResident(updated.requesterResidentId);
  } catch (err) {
    // Non-fatal: we already have a fallback synthesised from the
    // request's frozen requesterName/requesterHouseNumber. Log + treat
    // as "requester record missing".
    console.error(
      "[acceptReceptionRequest] getResident(requester) failed, falling back to frozen request fields",
      { ...logCtx, requesterResidentId: updated.requesterResidentId, err: serialiseError(err) },
    );
    requester = null;
  }
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

  console.info(
    "[acceptReceptionRequest] done",
    {
      ...logCtx,
      targetId: updated.id,
      carrier: updated.carrier,
      hasWindow:
        updated.expectedWindowStartAt !== undefined &&
        updated.expectedWindowEndAt !== undefined,
      hasGroupCard:
        updated.groupCardChatId !== undefined &&
        updated.groupCardMessageId !== undefined,
    },
  );

  return {
    request: updated,
    requester: requesterSummary,
    volunteer: volunteerSummary,
    groupCardChatId: updated.groupCardChatId ?? null,
    groupCardMessageId: updated.groupCardMessageId ?? null,
  };
}

function wrapStepError(
  step: string,
  logCtx: Readonly<Record<string, unknown>>,
  err: unknown,
): Error {
  console.error(
    `[acceptReceptionRequest] step=${step} threw`,
    { ...logCtx, err: serialiseError(err) },
  );
  const cause = err instanceof Error ? err : new Error(String(err));
  const wrapped = new Error(
    `acceptReceptionRequest: ${step} failed: ${cause.message}`,
    { cause },
  );
  return wrapped;
}

function serialiseError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
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
