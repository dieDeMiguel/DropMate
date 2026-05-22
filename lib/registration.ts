/**
 * Channel-deterministic registration (v2.1 #97).
 *
 * Live trace 2026-05-22 (prod `dpl_8A1T6ECT4ttiWRnBHot7Sa3vEUC9`): a new
 * user DM'd `/register Diego de Miguel Lutterothstrasse 69 Erdgeschoss
 * Links` and received TEN bot messages — a freely-generated English +
 * German welcome wall, a trilingual `/language` brochure, a confirmation,
 * two duplicate `Habe in der Gruppe gefragt …` Flow-2 misfires, and more
 * duplicates. The classifier returned `isFlow2: false` correctly, so the
 * channel handed raw text to the agent, and the agent reasoned its way
 * into both a welcome wall AND a Flow 2 post against the registration
 * message that never asked for a reception request.
 *
 * Fix shape (mirrors v2.1 Slice 1 / #86): pull the registration decision
 * OUT of the model entirely. Two entry points covered:
 *
 *   1. `/register …` slash command — deterministic regex parse, no
 *      classifier call (the user typing the slash is already a
 *      high-confidence signal, identical to how `/receive` skips the
 *      Flow-2 classifier in Slice 2 / #87).
 *   2. Free-text registration (e.g. `Diego de Miguel, Lutterothstrasse
 *      69 Erdgeschoss Links`) — same regex (without the slash prefix
 *      requirement). Free-text is more conservative than the slash:
 *      we require both a comma between name + address AND a
 *      strasse/straße/str ending on the street word so we don't
 *      accidentally consume a `Patricia (Hs.90)` directory hint.
 *
 * The channel calls `registerResident(caller, input)` from
 * `process-update.ts` BEFORE the Flow 2 classifier path. On success it
 * sends ONE deterministic confirmation DM (`buildConfirmationDm`) and
 * SKIPS `sendToAsh` entirely so the welcome wall cannot fire.
 *
 * Existing-record preservation matches `agent/tools/register_resident.ts`:
 * `id`, `registeredAt`, `language`, `availabilityPatterns` survive a
 * re-registration so a resident can correct their floor without losing
 * the rest of their record.
 *
 * @see lib/telegram-channel/process-update.ts  — channel-side call site
 * @see agent/tools/register_resident.ts        — agent fallback (kept for
 *                                                edge cases the regex
 *                                                doesn't catch)
 */

import { normaliseLanguageCode } from "./language.js";
import { getResident, setResident, type Resident } from "./redis.js";

/**
 * The strict regex used for both the slash-command path AND the free-text
 * path. The slash-prefix variant just strips the leading `/register` (and
 * optional bot @-mention) before applying this body regex.
 *
 * Capture groups:
 *   1. name      — one or more words; case checked later (single-word
 *                  names are rejected so "Diego" alone never registers —
 *                  first name + family name only)
 *   2. street    — single non-whitespace token ending in
 *                  `strasse`/`straße`/`str` (case-insensitive). German
 *                  streets are compound words (`Lutterothstrasse`,
 *                  `Methfesselstraße`), so a single \S+ token is the
 *                  right shape; abbreviated `Str.` works the same way.
 *   3. house     — number with optional letter suffix (`12a`, `12-14`)
 *   4. rest      — everything after the house number — captured as a
 *                  free-form remainder we then sub-parse for floor +
 *                  buzzer. Optional.
 *
 * "Methfesselstraße" / "Lutterothstrasse" / "Eppendorfer Str." all match.
 * "Patricia (Hs.90)" / "Hallo!" / "Wo ist mein Paket?" do NOT match (no
 * street-suffix token).
 *
 * `.+?` for name is non-greedy so the engine prefers the shortest name
 * that still leaves a valid street-token + house-number on the right.
 * For "Diego de Miguel Lutterothstrasse 69" the only valid right-side
 * is "Lutterothstrasse 69", so name resolves to "Diego de Miguel".
 */
const REGISTRATION_BODY_REGEX =
  /^\s*(.+?),?\s+(\S*(?:stra(?:ss|ß)e|str\.?))\s+(\d+[A-Za-z\-]*)\b\s*(.*?)\s*$/iu;

/**
 * `/register …` matcher. Optional bot @-mention is tolerated so taps
 * from a group context with multiple bots don't mis-route. Mirrors the
 * `/receive` matcher in `lib/slash-command.ts`.
 */
export function isRegisterCommand(text: string): boolean {
  return /^\/register(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text.trim());
}

/**
 * Structured shape of a parsed `/register …` or matching free-text
 * inbound. `null` when the text does not parse — the caller then either
 * shows the user a "try `/register Name, Street Number`" prompt (slash
 * variant) or falls through to the classifier (free-text variant).
 */
export interface ParsedRegistration {
  readonly name: string;
  readonly street: string;
  readonly houseNumber: string;
  readonly floor?: string;
  readonly buzzerName?: string;
}

/**
 * Parse a `/register …` slash command. Returns `null` when the slash is
 * present but the arguments don't match the strict body regex — the
 * caller then shows a "try `/register Name, Street Number`" prompt
 * rather than falling through to the agent.
 */
export function parseRegisterCommand(text: string): ParsedRegistration | null {
  if (!isRegisterCommand(text)) return null;
  const stripped = text
    .trim()
    .replace(/^\/register(?:@[A-Za-z0-9_]+)?\s*/i, "");
  if (stripped.length === 0) return null;
  return matchRegistrationBody(stripped);
}

/**
 * Parse a free-text registration inbound (no `/register` slash). More
 * conservative than the slash variant because there's no explicit
 * intent signal — false positives here would silently overwrite
 * existing Resident records on every directory-hint message a user
 * types. The body regex is strict (requires comma + street-suffix) so
 * the false-positive surface is small in practice.
 *
 * Returns `null` for inputs that do not match. The caller then falls
 * through to the Flow-2 classifier.
 */
export function parseFreeTextRegistration(text: string): ParsedRegistration | null {
  if (isRegisterCommand(text)) return null;
  return matchRegistrationBody(text);
}

function matchRegistrationBody(body: string): ParsedRegistration | null {
  const match = body.match(REGISTRATION_BODY_REGEX);
  if (!match) return null;
  const [, nameRaw, streetRaw, houseRaw, restRaw] = match;
  const name = collapseWhitespace(nameRaw!.trim());
  // Reject single-word names ("Diego" alone). A registered resident
  // needs a first name + family name so other neighbours can text-mention
  // them in a group post; a bare first name is too ambiguous.
  if (!/\s/.test(name)) return null;
  const street = collapseWhitespace(streetRaw!.trim());
  const houseNumber = houseRaw!.trim();
  const { floor, buzzerName } = splitFloorAndBuzzer(restRaw ?? "");
  const parsed: ParsedRegistration = {
    name,
    street,
    houseNumber,
    floor,
    buzzerName,
  };
  return parsed;
}

/**
 * Split the post-house-number remainder into an optional floor + buzzer.
 * Heuristics over the canonical German shape `<floor-phrase> [buzzer]`:
 *
 *   - Pure ordinal / "Etage" tokens go to floor:
 *       "Erdgeschoss", "EG", "II. OG", "5. Etage", "III. Stock"
 *   - Anything left after the floor phrase is the buzzer.
 *   - When no floor pattern matches, the whole remainder is the buzzer
 *     (if non-empty) — better than discarding it.
 *
 * The regex matches the common floor vocabulary but doesn't try to be
 * exhaustive — uncommon shapes fall through to the "everything is
 * buzzer" branch, and the user can re-register with a cleaner string.
 */
function splitFloorAndBuzzer(rest: string): {
  floor: string | undefined;
  buzzerName: string | undefined;
} {
  const trimmed = collapseWhitespace(rest.trim());
  if (trimmed.length === 0) return { floor: undefined, buzzerName: undefined };

  const FLOOR_REGEX =
    /^(?:(erdgeschoss|eg|hochparterre|hp|souterrain|untergeschoss|ug|kellergeschoss|kg)|(\d+\.?\s*(?:og|stock|etage|floor))|((?:[ivx]+|erste[rsn]?|zweite[rsn]?|dritte[rsn]?|vierte[rsn]?|fünfte[rsn]?|sechste[rsn]?|siebte[rsn]?|achte[rsn]?|neunte[rsn]?|zehnte[rsn]?)\.?\s*(?:og|stock|etage)?))\s*(.*)$/iu;
  const m = trimmed.match(FLOOR_REGEX);
  if (m) {
    const floorRaw = m[1] ?? m[2] ?? m[3] ?? "";
    const tailRaw = m[4] ?? "";
    const floor = collapseWhitespace(floorRaw.trim());
    const tail = collapseWhitespace(tailRaw.trim());
    return {
      floor: floor.length > 0 ? floor : undefined,
      buzzerName: tail.length > 0 ? tail : undefined,
    };
  }

  return { floor: undefined, buzzerName: trimmed };
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ");
}

/**
 * Inputs for `registerResident`. Mirrors `ParsedRegistration` plus the
 * caller's Telegram identity — the platform-side principal that
 * `register_resident` would normally read from `getSession()`. Passing
 * it explicitly here lets the channel handler stay decoupled from Ash
 * runtime context.
 */
export interface RegisterResidentInput {
  readonly name: string;
  readonly street: string;
  readonly houseNumber: string;
  readonly floor?: string;
  readonly buzzerName?: string;
  /** Telegram `user.id` of the caller — stored verbatim on `Resident.platformId`. */
  readonly platformId: string;
  /**
   * Telegram `from.language_code`. Normalised through
   * `normaliseLanguageCode` before persistence so "de-AT" / "EN" never
   * land on `Resident.language` raw.
   */
  readonly telegramLanguageCode?: string | null;
}

export interface RegisterResidentResult {
  readonly resident: Resident;
  /** `true` when an existing Resident record was updated; `false` for first-time registration. */
  readonly updated: boolean;
}

/**
 * Write a Resident record for the caller. Preserves `id`, `registeredAt`,
 * `language`, and `availabilityPatterns` from any existing record — the
 * same invariants `agent/tools/register_resident.ts` honours so a
 * re-registration through either path produces the same outcome.
 *
 * Throws on Redis I/O failure; the channel's catch logs the error and
 * falls back to the agent so the user gets some response (typically an
 * apology).
 */
export async function registerResident(
  input: RegisterResidentInput,
): Promise<RegisterResidentResult> {
  const existing = await getResident(input.platformId);
  const normalisedLanguage =
    normaliseLanguageCode(input.telegramLanguageCode) ?? undefined;
  const resident: Resident = {
    id: existing?.id ?? input.platformId,
    name: input.name,
    street: input.street,
    houseNumber: input.houseNumber,
    floor: input.floor,
    buzzerName: input.buzzerName,
    platformId: input.platformId,
    platform: "telegram",
    language: existing?.language ?? normalisedLanguage,
    availabilityPatterns: existing?.availabilityPatterns ?? [],
    registeredAt: existing?.registeredAt ?? Date.now(),
    source: "explicit",
    confirmed: true,
  };
  await setResident(resident);
  return { resident, updated: existing !== null };
}

/**
 * Per-language confirmation DM template (de/en/es/tr — same set as
 * `FLOW_2_ACK_DMS` in `flow-2-dms.ts` and `ACCEPT_RETRY_TOASTS` so a
 * future fifth language only touches one file per surface). Fields are
 * substituted via plain replacement, not a template engine — keep the
 * placeholder set minimal.
 *
 * The DM is ONE short sentence by design: the agent-generated welcome
 * wall the live trace produced was 200+ words across three messages.
 * One sentence in the resident's stored language is enough — they
 * already typed `/register` so they know what they did.
 */
const REGISTRATION_CONFIRMATION_TEMPLATES: Readonly<Record<string, string>> = {
  de: "Vielen Dank, {name}! Du bist jetzt unter {street} {houseNumber}{floorClause} registriert.",
  en: "Thanks, {name}! You're registered at {street} {houseNumber}{floorClause}.",
  es: "Gracias, {name}! Estás registrado en {street} {houseNumber}{floorClause}.",
  tr: "Teşekkürler, {name}! {street} {houseNumber}{floorClause} adresine kaydedildin.",
};

const REGISTRATION_FLOOR_CLAUSE: Readonly<Record<string, (floor: string) => string>> = {
  de: (floor) => `, ${floor}`,
  en: (floor) => `, ${floor}`,
  es: (floor) => `, ${floor}`,
  tr: (floor) => `, ${floor}`,
};

/**
 * Render the channel-deterministic confirmation DM for a successful
 * registration. Language fallback chain mirrors the rest of the channel
 * (Slice 1 #86, Bug 3 #95): resident.language → telegram languageCode →
 * "de". Floor is omitted from the rendered string when the resident
 * didn't supply one.
 */
export function buildRegistrationConfirmationDm(args: {
  readonly resident: Resident;
  readonly fallbackLanguageCode?: string | null;
}): string {
  const language =
    pickLanguage(args.resident.language) ??
    pickLanguage(args.fallbackLanguageCode) ??
    "de";
  const template =
    REGISTRATION_CONFIRMATION_TEMPLATES[language] ??
    REGISTRATION_CONFIRMATION_TEMPLATES["de"]!;
  const floorClauseFn =
    REGISTRATION_FLOOR_CLAUSE[language] ?? REGISTRATION_FLOOR_CLAUSE["de"]!;
  const floorClause = args.resident.floor
    ? floorClauseFn(args.resident.floor)
    : "";
  return template
    .replace("{name}", args.resident.name)
    .replace("{street}", args.resident.street)
    .replace("{houseNumber}", args.resident.houseNumber)
    .replace("{floorClause}", floorClause);
}

function pickLanguage(raw: string | null | undefined): string | null {
  const normalised = normaliseLanguageCode(raw);
  if (normalised && REGISTRATION_CONFIRMATION_TEMPLATES[normalised]) {
    return normalised;
  }
  return null;
}
