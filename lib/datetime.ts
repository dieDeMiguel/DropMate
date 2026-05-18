/**
 * Europe/Berlin formatting primitives for the `/receive` flow group
 * card. Single source of truth for how reception-request ETA windows
 * are rendered to humans.
 *
 * Why Europe/Berlin specifically: DropMate's MVP scope is a single
 * German street. Mixed-locale neighborhoods are a V3+ concern; until
 * then we don't switch the zone or the language per-user — the group
 * card is shared, has one rendering, and that rendering is German.
 *
 * Everything below is pure `Intl.DateTimeFormat("de-DE", { timeZone:
 * "Europe/Berlin", ... })`. No date-fns / no luxon — keeps the runtime
 * footprint flat and the DST edge cases handled by the engine.
 */

const TIMEZONE = "Europe/Berlin";
const LOCALE = "de-DE";

const timeFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIMEZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * `HH:MM` time-of-day in Europe/Berlin. The Bot API has no special
 * rendering for times, so the model passes the formatted string verbatim
 * into the group card text.
 */
export function formatBerlinTime(at: number): string {
  return timeFormatter.format(new Date(at));
}

/**
 * `DD.MM.YYYY` German short date in Europe/Berlin.
 */
export function formatBerlinDate(at: number): string {
  return dateFormatter.format(new Date(at));
}

/**
 * `YYYY-MM-DD` key for comparing two timestamps "are they the same
 * calendar day in Berlin?" without paying for date math at the call site.
 * The `en-CA` locale always renders ISO order, which is what we want for
 * string equality / sort.
 */
export function berlinDayKey(at: number): string {
  return dayKeyFormatter.format(new Date(at));
}

/**
 * Returns the Berlin calendar offset (in days) between `at` and `now`.
 * - 0 = same day as now ("heute")
 * - 1 = the calendar day after now ("morgen")
 * - 2 = the day after that ("übermorgen")
 * - everything else falls through to the absolute date in the caller.
 *
 * The diff is computed on `YYYY-MM-DD` keys derived in the Berlin zone,
 * so DST transitions (when a calendar day is 23 or 25 hours) don't shift
 * the answer.
 */
export function berlinCalendarOffsetDays(at: number, now: number): number {
  const aKey = berlinDayKey(at);
  const nKey = berlinDayKey(now);
  if (aKey === nKey) return 0;
  // Construct UTC midnights from the YYYY-MM-DD keys (which already are
  // Berlin-calendar dates). Subtraction in ms / 86_400_000 gives the
  // signed calendar-day diff regardless of DST inside the range.
  const [ay, am, ad] = aKey.split("-").map((s) => Number(s));
  const [ny, nm, nd] = nKey.split("-").map((s) => Number(s));
  const aUtc = Date.UTC(ay ?? 0, (am ?? 1) - 1, ad ?? 1);
  const nUtc = Date.UTC(ny ?? 0, (nm ?? 1) - 1, nd ?? 1);
  return Math.round((aUtc - nUtc) / 86_400_000);
}

/**
 * Human-readable Berlin-zone day reference: "heute", "morgen",
 * "übermorgen", or the absolute `DD.MM.YYYY` when the date is more
 * than two days out (or before today). Past dates always fall through
 * to the absolute form — the relative shorthand is only useful looking
 * forward.
 */
export function formatBerlinRelativeDay(at: number, now: number): string {
  const offset = berlinCalendarOffsetDays(at, now);
  if (offset === 0) return "heute";
  if (offset === 1) return "morgen";
  if (offset === 2) return "übermorgen";
  return formatBerlinDate(at);
}

/**
 * Render an ETA window in Berlin time.
 *
 * - Single point (`startAt === endAt`): just the time, e.g. `"14:00"`.
 * - Same calendar day in Berlin: `"<day> <HH:MM>–<HH:MM>"`, e.g.
 *   `"heute 14:00–16:00"`.
 * - Spanning two or more calendar days: `"<startDay> <HH:MM> – <endDay>
 *   <HH:MM>"`, e.g. `"morgen 18:00 – übermorgen 10:00"`.
 *
 * `now` is taken as a parameter so tests (and the dominantly-relative
 * paths) can pin the reference moment without monkey-patching `Date`.
 */
export function formatBerlinWindow(
  startAt: number,
  endAt: number,
  now: number,
): string {
  const startTime = formatBerlinTime(startAt);
  if (startAt === endAt) {
    const day = formatBerlinRelativeDay(startAt, now);
    return `${day} ${startTime}`;
  }
  const endTime = formatBerlinTime(endAt);
  const sameDay = berlinDayKey(startAt) === berlinDayKey(endAt);
  if (sameDay) {
    const day = formatBerlinRelativeDay(startAt, now);
    return `${day} ${startTime}–${endTime}`;
  }
  const startDay = formatBerlinRelativeDay(startAt, now);
  const endDay = formatBerlinRelativeDay(endAt, now);
  return `${startDay} ${startTime} – ${endDay} ${endTime}`;
}
