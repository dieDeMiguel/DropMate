/**
 * Europe/Berlin timezone helpers shared by the channel layer.
 *
 * Consumed by:
 *   - `lib/slash-command.ts`           — `/receive` args parser
 *   - `agent/tools/classify_dm_intent.ts` — classifier date anchoring +
 *     local-clock → Unix ms conversion
 *
 * Uses `Intl.DateTimeFormat`'s tzdb-backed conversion so DST transitions
 * are handled automatically. Verified across the 2026 spring-forward
 * boundary by `lib/slash-command.test.ts`.
 */

export interface BerlinDayParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const BERLIN_DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const BERLIN_CLOCK_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const BERLIN_WEEKDAY_FORMAT = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  weekday: "long",
});

/**
 * `Date.now()` (or any Unix ms instant), expressed as Berlin calendar
 * day-parts, optionally shifted by `dayOffset` whole days forward.
 */
export function berlinDayParts(now: number, dayOffset = 0): BerlinDayParts {
  const parts = BERLIN_DAY_FORMAT.formatToParts(new Date(now));
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  const day = Number(parts.find((p) => p.type === "day")!.value);
  if (dayOffset === 0) return { year, month, day };
  const oneDayMs = 24 * 60 * 60 * 1000;
  const shifted = new Date(
    Date.UTC(year, month - 1, day) + dayOffset * oneDayMs,
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Format day-parts as `YYYY-MM-DD`. */
export function formatBerlinDate(d: BerlinDayParts): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/**
 * Parse a strict `YYYY-MM-DD` string back into Berlin day-parts.
 * Throws on malformed input; the caller (classifier post-processing)
 * has already validated against the Zod schema by this point, so a
 * throw here is a programmer error rather than a user-facing one.
 */
export function berlinDayPartsFromYmd(ymd: string): BerlinDayParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) {
    throw new Error(`berlinDayPartsFromYmd: not a YYYY-MM-DD string: ${ymd}`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/**
 * Convert a Berlin-local clock instant (date + hour:minute) to Unix ms.
 *
 * Uses the standard "format-and-correct" offset trick: assume the
 * clock-fields name a UTC instant, ask `Intl.DateTimeFormat` what
 * Berlin would show for that instant, compute the discrepancy, and
 * subtract it. Robust across DST transitions because the formatter
 * itself owns the tzdb rules.
 */
export function berlinClockToUnixMs(
  date: BerlinDayParts,
  hour: number,
  minute: number,
): number {
  const naiveUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    0,
  );
  const parts = BERLIN_CLOCK_FORMAT.formatToParts(new Date(naiveUtc));
  const bY = Number(parts.find((p) => p.type === "year")!.value);
  const bM = Number(parts.find((p) => p.type === "month")!.value);
  const bD = Number(parts.find((p) => p.type === "day")!.value);
  const bH = Number(parts.find((p) => p.type === "hour")!.value);
  const bMin = Number(parts.find((p) => p.type === "minute")!.value);
  const berlinAsUtc = Date.UTC(bY, bM - 1, bD, bH, bMin, 0);
  const offsetMs = berlinAsUtc - naiveUtc;
  return naiveUtc - offsetMs;
}

/**
 * Lowercased German weekday name (`montag`, `dienstag`, …, `sonntag`)
 * for the Berlin day containing `now`. Used by the classifier prompt
 * to give the model both the date *and* the weekday name, so the
 * model can resolve user phrases like "Montag" without re-doing the
 * date arithmetic itself.
 */
export function berlinWeekday(now: number): string {
  return BERLIN_WEEKDAY_FORMAT.format(new Date(now)).toLowerCase();
}
