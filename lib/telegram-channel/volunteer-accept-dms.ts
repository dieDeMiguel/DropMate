/**
 * Deterministic DM templates for the channel-side volunteer-accept path.
 *
 * v2.1 #96 Part A: when a registered resident taps `[Ich kann helfen]`,
 * the channel writes the two outbound DMs itself (one operational handoff
 * to the volunteer, one named confirmation to the requester) instead of
 * handing the agent a `[VOLUNTEER_ACCEPTED]` synthetic and letting the
 * model compose them. The agent was free-form-emitting card-shaped text
 * to the group on the live trace — exactly the v2 chaos pattern (#85) in
 * text-only form, since Slice 5 (#90) had already removed the tools.
 *
 * Deterministic templates close that loop: the model never runs on the
 * accept-tap path now, so it cannot mis-route output to the group, name
 * deleted tools, or paraphrase the card text. Trade-off: the DMs are less
 * conversational than what the agent would have produced, but the privacy
 * + correctness guarantee is structural rather than instruction-based.
 *
 * Both DMs are localised to the four languages the rest of the v2.1
 * channel-side surface covers (de/en/es/tr — same set as the FLOW_2 DONE
 * ack examples and the v2.1 Bug 3 retry toasts). Unknown languages fall
 * back to German.
 *
 * @see lib/telegram-channel/process-update.ts — handleAcceptReceptionGroup
 */

import type { AcceptReceptionRequestResult } from "../reception-request.js";
import type { TelegramMessageEntity } from "./send.js";

/**
 * The four languages we ship localised templates for. Mirrors
 * `FLOW_2_DONE_ACK_EXAMPLES` and `ACCEPT_RETRY_TOASTS` in process-update.ts
 * so a fifth language only has to be added in one place per file.
 */
type SupportedLanguage = "de" | "en" | "es" | "tr";

const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set<SupportedLanguage>([
  "de",
  "en",
  "es",
  "tr",
]);

function pickLanguage(raw: string | null | undefined): SupportedLanguage {
  if (raw && SUPPORTED_LANGUAGES.has(raw)) {
    return raw as SupportedLanguage;
  }
  return "de";
}

/**
 * Per-language relative day labels for "today / tomorrow / day after
 * tomorrow". The window formatter consults this table when the start +
 * end of the expected window fall on the same Berlin calendar day (the
 * overwhelmingly common Flow 2 case — couriers don't deliver across
 * midnight). For spans across days, the formatter falls back to a
 * language-agnostic ISO-ish shape so the message stays legible.
 */
const RELATIVE_DAY_LABELS: Readonly<Record<SupportedLanguage, Readonly<Record<number, string>>>> = {
  de: { 0: "heute", 1: "morgen", 2: "übermorgen" },
  en: { 0: "today", 1: "tomorrow", 2: "the day after tomorrow" },
  es: { 0: "hoy", 1: "mañana", 2: "pasado mañana" },
  tr: { 0: "bugün", 1: "yarın", 2: "öbür gün" },
};

const BERLIN_DAY_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const BERLIN_TIME_HHMM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function berlinDayKey(unixMs: number): string {
  return BERLIN_DAY_KEY.format(unixMs);
}

function berlinTime(unixMs: number): string {
  return BERLIN_TIME_HHMM.format(unixMs);
}

function relativeDayOffset(unixMs: number): number | null {
  const oneDay = 24 * 60 * 60 * 1000;
  const today = berlinDayKey(Date.now());
  if (berlinDayKey(unixMs) === today) return 0;
  if (berlinDayKey(unixMs) === berlinDayKey(Date.now() + oneDay)) return 1;
  if (berlinDayKey(unixMs) === berlinDayKey(Date.now() + 2 * oneDay)) return 2;
  return null;
}

/**
 * Format an expected window in the target language. Returns `null` when
 * either endpoint is missing — callers drop the window phrase entirely
 * in that case rather than emitting a half-formed time.
 *
 * Format:
 *   - Same-day, known relative day:  `morgen 14:00–16:00` (de),
 *                                    `tomorrow 14:00–16:00` (en), etc.
 *   - Same-day, unknown relative:    `YYYY-MM-DD 14:00–16:00`
 *   - Different days:                `YYYY-MM-DD 14:00 – YYYY-MM-DD 02:00`
 *
 * Window endpoints are Unix ms; the formatter applies Europe/Berlin
 * locally via `Intl.DateTimeFormat`. Day-key comparisons use the
 * Berlin-localised `YYYY-MM-DD` key so DST transitions don't push an
 * endpoint into the wrong calendar bucket.
 */
function formatLocalisedWindow(
  start: number | undefined,
  end: number | undefined,
  language: SupportedLanguage,
): string | null {
  if (start === undefined || end === undefined) return null;

  const sameDay = berlinDayKey(start) === berlinDayKey(end);
  const startTime = berlinTime(start);
  const endTime = berlinTime(end);

  if (sameDay) {
    const offset = relativeDayOffset(start);
    const dayLabel =
      offset !== null
        ? RELATIVE_DAY_LABELS[language][offset]!
        : berlinDayKey(start);
    if (startTime === endTime) {
      return `${dayLabel} ${startTime}`;
    }
    return `${dayLabel} ${startTime}–${endTime}`;
  }

  return `${berlinDayKey(start)} ${startTime} – ${berlinDayKey(end)} ${endTime}`;
}

/**
 * Volunteer DM template — operational handoff. Names the requester and
 * embeds the operational fields (house, floor, buzzer, carrier, window)
 * the volunteer needs to actually receive the package. Optional fields
 * are omitted (not templatised) when absent — same rule as the agent's
 * instructions for field rendering.
 */
type VolunteerTemplate = (args: {
  readonly requesterName: string;
  readonly requesterHouseNumber: string;
  readonly requesterFloor: string | null;
  readonly requesterBuzzer: string | null;
  readonly carrier: string | null;
  readonly window: string | null;
}) => string;

const VOLUNTEER_DM_TEMPLATES: Readonly<Record<SupportedLanguage, VolunteerTemplate>> = {
  de: ({ requesterName, requesterHouseNumber, requesterFloor, requesterBuzzer, carrier, window }) => {
    const parts = [
      `Danke fürs Helfen! Das Paket ist für ${requesterName} aus Haus ${requesterHouseNumber}.`,
    ];
    if (requesterFloor) parts.push(`Etage: ${requesterFloor}.`);
    if (requesterBuzzer) parts.push(`Klingel: ${requesterBuzzer}.`);
    if (carrier) parts.push(`Carrier: ${carrier}.`);
    if (window) parts.push(`Erwartet: ${window}.`);
    return parts.join(" ");
  },
  en: ({ requesterName, requesterHouseNumber, requesterFloor, requesterBuzzer, carrier, window }) => {
    const parts = [
      `Thanks for helping! The package is for ${requesterName} at house ${requesterHouseNumber}.`,
    ];
    if (requesterFloor) parts.push(`Floor: ${requesterFloor}.`);
    if (requesterBuzzer) parts.push(`Buzzer: ${requesterBuzzer}.`);
    if (carrier) parts.push(`Carrier: ${carrier}.`);
    if (window) parts.push(`Expected: ${window}.`);
    return parts.join(" ");
  },
  es: ({ requesterName, requesterHouseNumber, requesterFloor, requesterBuzzer, carrier, window }) => {
    const parts = [
      `¡Gracias por ayudar! El paquete es para ${requesterName} de la casa ${requesterHouseNumber}.`,
    ];
    if (requesterFloor) parts.push(`Piso: ${requesterFloor}.`);
    if (requesterBuzzer) parts.push(`Timbre: ${requesterBuzzer}.`);
    if (carrier) parts.push(`Mensajería: ${carrier}.`);
    if (window) parts.push(`Esperado: ${window}.`);
    return parts.join(" ");
  },
  tr: ({ requesterName, requesterHouseNumber, requesterFloor, requesterBuzzer, carrier, window }) => {
    const parts = [
      `Yardım ettiğin için teşekkürler! Paket ${requesterHouseNumber} numaralı evdeki ${requesterName} için.`,
    ];
    if (requesterFloor) parts.push(`Kat: ${requesterFloor}.`);
    if (requesterBuzzer) parts.push(`Zil: ${requesterBuzzer}.`);
    if (carrier) parts.push(`Kargo: ${carrier}.`);
    if (window) parts.push(`Beklenen: ${window}.`);
    return parts.join(" ");
  },
};

/**
 * Requester DM template — named confirmation. Names the volunteer + their
 * house number + (when present) the carrier and window. Returns the
 * template's `volunteerNameStart`/`length` indices so the caller can
 * build the `text_mention` MessageEntity that pings the volunteer's
 * Telegram account when the requester taps their name. UTF-16 code-unit
 * indexing matches Telegram's spec (the same way `computeMentionEntities`
 * in `agent/tools/post_to_group.ts` calculates offsets).
 */
interface RequesterTemplateResult {
  readonly text: string;
  readonly volunteerNameStart: number;
  readonly volunteerNameLength: number;
}

type RequesterTemplate = (args: {
  readonly volunteerName: string;
  readonly volunteerHouseNumber: string;
  readonly carrier: string | null;
  readonly window: string | null;
}) => RequesterTemplateResult;

function applyTemplateWithMention(
  before: string,
  volunteerName: string,
  after: string,
): RequesterTemplateResult {
  return {
    text: `${before}${volunteerName}${after}`,
    volunteerNameStart: before.length,
    volunteerNameLength: volunteerName.length,
  };
}

const REQUESTER_DM_TEMPLATES: Readonly<Record<SupportedLanguage, RequesterTemplate>> = {
  de: ({ volunteerName, volunteerHouseNumber, carrier, window }) => {
    const carrierPhrase = carrier ? `${carrier}-Paket` : "Paket";
    const windowPhrase = window ? ` ${window}` : "";
    return applyTemplateWithMention(
      "",
      volunteerName,
      ` aus Haus ${volunteerHouseNumber} nimmt dein ${carrierPhrase}${windowPhrase} entgegen.`,
    );
  },
  en: ({ volunteerName, volunteerHouseNumber, carrier, window }) => {
    const carrierPhrase = carrier ? `${carrier} package` : "package";
    const windowPhrase = window ? ` (${window})` : "";
    return applyTemplateWithMention(
      "",
      volunteerName,
      ` at house ${volunteerHouseNumber} will take your ${carrierPhrase}${windowPhrase}.`,
    );
  },
  es: ({ volunteerName, volunteerHouseNumber, carrier, window }) => {
    const carrierPhrase = carrier ? `paquete de ${carrier}` : "paquete";
    const windowPhrase = window ? ` (${window})` : "";
    return applyTemplateWithMention(
      "",
      volunteerName,
      ` de la casa ${volunteerHouseNumber} recibirá tu ${carrierPhrase}${windowPhrase}.`,
    );
  },
  tr: ({ volunteerName, volunteerHouseNumber, carrier, window }) => {
    const carrierPhrase = carrier ? `${carrier} paketini` : "paketini";
    const windowPhrase = window ? ` (${window})` : "";
    return applyTemplateWithMention(
      "",
      volunteerName,
      `, ${volunteerHouseNumber} numaralı evden${windowPhrase}, senin ${carrierPhrase} teslim alacak.`,
    );
  },
};

/**
 * Build the operational-handoff DM the channel sends to the volunteer.
 * Language picked off `volunteer.language` with German fallback.
 */
export function buildVolunteerAcceptDmText(
  accepted: AcceptReceptionRequestResult,
): string {
  const language = pickLanguage(accepted.volunteer.language);
  const template = VOLUNTEER_DM_TEMPLATES[language];
  const carrier =
    accepted.request.carrier && accepted.request.carrier !== "unknown"
      ? accepted.request.carrier
      : null;
  const window = formatLocalisedWindow(
    accepted.request.expectedWindowStartAt,
    accepted.request.expectedWindowEndAt,
    language,
  );
  return template({
    requesterName: accepted.requester.name,
    requesterHouseNumber: accepted.requester.houseNumber,
    requesterFloor: accepted.requester.floor,
    requesterBuzzer: accepted.requester.buzzerName,
    carrier,
    window,
  });
}

export interface RequesterDmResult {
  readonly text: string;
  readonly entities: ReadonlyArray<TelegramMessageEntity>;
}

/**
 * Build the named-confirmation DM the channel sends to the requester.
 * Embeds a single `text_mention` MessageEntity over the volunteer's name
 * so the requester sees a tap-to-DM link.
 *
 * Language picked off `requester.language` with German fallback. The
 * volunteer's Telegram user id is taken from `volunteer.platformId`
 * (which equals their Telegram user id for the DM platform — same
 * mapping the rest of the channel relies on).
 */
export function buildRequesterAcceptDm(
  accepted: AcceptReceptionRequestResult,
): RequesterDmResult {
  const language = pickLanguage(accepted.requester.language);
  const template = REQUESTER_DM_TEMPLATES[language];
  const carrier =
    accepted.request.carrier && accepted.request.carrier !== "unknown"
      ? accepted.request.carrier
      : null;
  const window = formatLocalisedWindow(
    accepted.request.expectedWindowStartAt,
    accepted.request.expectedWindowEndAt,
    language,
  );
  const rendered = template({
    volunteerName: accepted.volunteer.name,
    volunteerHouseNumber: accepted.volunteer.houseNumber,
    carrier,
    window,
  });

  const telegramUserId = Number(accepted.volunteer.platformId);
  const entities: ReadonlyArray<TelegramMessageEntity> = Number.isFinite(
    telegramUserId,
  )
    ? [
        {
          type: "text_mention",
          offset: rendered.volunteerNameStart,
          length: rendered.volunteerNameLength,
          user: { id: telegramUserId },
        },
      ]
    : [];

  return { text: rendered.text, entities };
}

/**
 * v2.1 #96 Part B: localized cross-street rejection toast. Used when
 * `acceptReceptionRequest` throws with code
 * `ACCEPT_DIFFERENT_STREET_ERROR_CODE` — the tapper's stored street
 * differs from the request's street, which is a permanent rejection (the
 * user's street doesn't change without re-registration). The button is
 * stripped at the same time so the volunteer doesn't keep re-tapping.
 *
 * Mirrors the language set covered by `ACCEPT_RETRY_TOASTS` and
 * `FLOW_2_DONE_ACK_EXAMPLES` so the channel's user-facing surface stays
 * consistent.
 */
const CROSS_STREET_TOASTS: Readonly<Record<SupportedLanguage, string>> = {
  de: "Du und dieser Nachbar müsst auf derselben Straße wohnen.",
  en: "You and this neighbor must live on the same street.",
  es: "Tú y este vecino debéis vivir en la misma calle.",
  tr: "Sen ve bu komşu aynı sokakta yaşamalısınız.",
};

export function crossStreetToastForLanguage(
  raw: string | null | undefined,
): string {
  const language = pickLanguage(raw);
  return CROSS_STREET_TOASTS[language];
}

/**
 * v2.1 #98: localized self-accept rejection toast. Used when
 * `acceptReceptionRequest` throws with code
 * `ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE` — the tapper is the requester of
 * the card they're trying to claim. Permanent rejection (the request's
 * `requesterResidentId` doesn't change), so the channel strips the
 * keyboard alongside the toast — no upside to leaving a retry button
 * under the requester's finger.
 *
 * Mirrors the language set covered by `CROSS_STREET_TOASTS`,
 * `ACCEPT_RETRY_TOASTS`, and `FLOW_2_DONE_ACK_EXAMPLES` so the channel's
 * user-facing surface stays consistent. Adding a fifth language is a
 * one-line touch in each of those tables.
 */
const SELF_ACCEPT_TOASTS: Readonly<Record<SupportedLanguage, string>> = {
  de: "Du kannst dein eigenes Paket nicht selbst annehmen.",
  en: "You can't volunteer for your own package.",
  es: "No puedes aceptar tu propio paquete.",
  tr: "Kendi paketini sen kabul edemezsin.",
};

export function selfAcceptToastForLanguage(
  raw: string | null | undefined,
): string {
  const language = pickLanguage(raw);
  return SELF_ACCEPT_TOASTS[language];
}
