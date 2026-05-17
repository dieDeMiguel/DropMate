/**
 * Single source of truth for language-code parsing.
 *
 * Telegram's `language_code` attribute (and any future channel's
 * equivalent) follows IETF BCP 47 — e.g. "de", "de-AT", "EN-us",
 * "tr". The Resident schema in PRD §7 says the persisted form is the
 * ISO 639-1 prefix, lower-cased. Both `register_resident` (when
 * seeding `Resident.language` from the caller's first DM attributes)
 * and the `language_detection` hook (when backfilling later) feed
 * through this helper so the same input always produces the same
 * stored form, and a typo like "de-AT" can never sneak in.
 *
 * Returns `null` for unparseable input — callers fall back rather than
 * persisting garbage.
 */
export function normaliseLanguageCode(raw: unknown): string | null {
  if (typeof raw !== "string") {
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
      return normaliseLanguageCode(raw[0]);
    }
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;
  const prefix = trimmed.split("-")[0];
  if (!/^[a-z]{2,3}$/.test(prefix)) return null;
  return prefix;
}
