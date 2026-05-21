/**
 * `/receive` slash-command parser (v2.1 Slice 2 / #87).
 *
 * `/receive` is the channel-deterministic, classifier-bypassing entry
 * into Flow 2 v2. The user explicitly invoked the flow by typing the
 * slash, so the channel skips `classify_dm_intent` entirely and goes
 * straight to `createReceptionRequest`. Whatever the args parse to
 * goes into the request; missing fields just drop their part of the
 * group card.
 *
 * Acceptance rules (per #87):
 *
 *   - bare `/receive` → `{}` → sparse card "📦 Paket erwartet. Kann
 *     jemand annehmen?"
 *   - `/receive DHL morgen 14-16` → `{ carrier, expectedDate,
 *     expectedWindowStartAt, expectedWindowEndAt }` → populated card.
 *
 * Recognised fields (all independent, all best-effort):
 *
 *   - carrier: case-insensitive match against the seven `PackageCarrier`
 *     values minus "unknown". A bare /receive with no carrier produces
 *     no `carrier` field, which `buildGroupCardText` then renders as
 *     the generic "📦 Paket erwartet …" subject.
 *   - date word: `heute` / `morgen` / `übermorgen` (German) and
 *     `today` / `tomorrow` (English aliases for the multilingual
 *     product surface). Unknown future-day phrases fall through.
 *   - hour window: `14-16`, `14–16` (en-dash), `14-16 Uhr`, `9-11h`.
 *     Hours only (no minute precision); reject out-of-range or
 *     decreasing pairs.
 *
 * Times anchor to Europe/Berlin local time of the resolved date
 * (today / tomorrow / +2). A window without a date word anchors to
 * today.
 *
 * @see lib/reception-request.ts — consumer (`createReceptionRequest`)
 * @see lib/telegram-channel/process-update.ts — channel call site
 */

import {
  berlinClockToUnixMs,
  berlinDayParts,
  formatBerlinDate,
} from "./berlin-time.js";
import type { PackageCarrier } from "./redis.js";

export interface ParsedReceiveCommand {
  readonly carrier?: PackageCarrier;
  readonly expectedDate?: string;
  readonly expectedWindowStartAt?: number;
  readonly expectedWindowEndAt?: number;
}

/**
 * True iff `text` is a `/receive` slash command (with or without args,
 * optionally followed by a bot @-mention like `/receive@DropMate_bot`).
 * Tolerant of leading/trailing whitespace.
 */
export function isReceiveCommand(text: string): boolean {
  return /^\/receive(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text.trim());
}

/**
 * Parse `/receive ...` args. Never throws, never returns `null`:
 * unparseable inputs become an empty object so the caller still posts
 * the sparse card.
 *
 * @param text - the full inbound text including the leading `/receive`
 * @param now  - Unix ms anchor for date-word resolution; defaults to
 *               `Date.now()`. Injected by tests so the resolved
 *               window timestamps are deterministic.
 */
export function parseReceiveCommand(
  text: string,
  now: number = Date.now(),
): ParsedReceiveCommand {
  const stripped = text
    .trim()
    .replace(/^\/receive(?:@[A-Za-z0-9_]+)?\s*/i, "");
  if (stripped.length === 0) return {};

  const result: {
    carrier?: PackageCarrier;
    expectedDate?: string;
    expectedWindowStartAt?: number;
    expectedWindowEndAt?: number;
  } = {};

  const carrierMatch = stripped.match(
    /\b(DHL|Hermes|DPD|GLS|UPS|Amazon)\b/i,
  );
  if (carrierMatch) {
    result.carrier = canonicaliseCarrier(carrierMatch[1]!);
  }

  const dateOffset = matchDateOffset(stripped);
  const dayDate = berlinDayParts(now, dateOffset ?? 0);
  if (dateOffset !== null) {
    result.expectedDate = formatBerlinDate(dayDate);
  }

  const windowMatch = stripped.match(
    /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:Uhr|h|am|pm)?\b/i,
  );
  if (windowMatch) {
    const startH = Number(windowMatch[1]);
    const endH = Number(windowMatch[2]);
    if (isValidHour(startH) && isValidHour(endH) && endH > startH) {
      result.expectedWindowStartAt = berlinClockToUnixMs(dayDate, startH, 0);
      result.expectedWindowEndAt = berlinClockToUnixMs(dayDate, endH, 0);
      if (result.expectedDate === undefined) {
        // Window without a date word anchors to today.
        result.expectedDate = formatBerlinDate(dayDate);
      }
    }
  }

  return result;
}

function isValidHour(h: number): boolean {
  return Number.isInteger(h) && h >= 0 && h <= 23;
}

function canonicaliseCarrier(raw: string): PackageCarrier {
  const lower = raw.toLowerCase();
  switch (lower) {
    case "dhl":
      return "DHL";
    case "hermes":
      return "Hermes";
    case "dpd":
      return "DPD";
    case "gls":
      return "GLS";
    case "ups":
      return "UPS";
    case "amazon":
      return "Amazon";
    default:
      return "unknown";
  }
}

function matchDateOffset(text: string): number | null {
  // Check `übermorgen` BEFORE `morgen` — the latter is a substring of
  // the former. `\b` is ASCII-only in JS regex (`ü` is non-word), so
  // use an explicit boundary group instead of relying on `\b`.
  if (/(?:^|[^\p{L}])übermorgen(?![\p{L}])/iu.test(text)) return 2;
  if (/\b(heute|today)\b/i.test(text)) return 0;
  if (/\b(morgen|tomorrow)\b/i.test(text)) return 1;
  return null;
}

