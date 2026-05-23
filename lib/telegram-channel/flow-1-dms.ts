/**
 * Deterministic group ack + recipient DM templates for the
 * channel-side Flow 1 register-package path.
 *
 * v2.1 #106 Slice 1: when `classify_group_message` returns a
 * high-confidence package-registration verdict and the recipient
 * resolves to a registered Resident, the channel writes the group
 * ack + recipient DM itself instead of handing the agent a synthetic
 * and letting the model compose them. Same fix pattern that closed
 * Flow 2's text-leak surface (#96 Part A, #100): the model never
 * runs on the happy path, so it cannot fire a welcome wall,
 * paraphrase the card text, or name deleted tools.
 *
 * Only the recipient DM carries the `[Abgeholt]` inline keyboard (one
 * row, one button) with `callback_data: confirm_pickup:<package.id>`
 * since v2.1 #114 — the group ack is announce-only and pickup is
 * private. The existing `handleCallbackQuery` path in
 * `process-update.ts` routes the action (#24).
 *
 * de-only for Slice 1 — en/es/tr land alongside Slice 3 (#109) or as
 * a follow-up. Falls back to German silently when the recipient's
 * stored language isn't German; that's the dominant case on the MVP
 * street.
 *
 * @see lib/telegram-channel/process-update.ts — channel-side call site
 * @see lib/package.ts                          — registerPackage core
 */

import type { InlineKeyboardMarkup } from "./send.js";
import type { HolderSummary, ResidentRecipientSummary } from "../package.js";

/**
 * Single-button `[Abgeholt]` inline keyboard. `callback_data` is
 * `confirm_pickup:<package.id>`. v2.1 #114: this keyboard now lands
 * ONLY on the recipient's DM — never on the group ack. Pickup is
 * private business between the recipient and the bot; the group
 * stays at announce-only.
 *
 * Per Telegram spec: callback_data max 64 bytes. `pkg_<timestamp>_<rand>`
 * is well within budget.
 */
export function buildPickupKeyboard(packageId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Abgeholt",
          callback_data: `confirm_pickup:${packageId}`,
        },
      ],
    ],
  };
}

/**
 * Compose the group ack body. Public, neutral: names both holder +
 * recipient + their house numbers, no buzzer / floor (those are
 * private — PRD §9). Posted to the street group with the
 * `[Abgeholt]` button attached.
 *
 *     📦 Paket von <holder.name> (<holder.houseNumber>) an
 *     <recipient.name> (<recipient.houseNumber>).
 */
export function buildGroupAckText(args: {
  readonly holder: HolderSummary;
  readonly recipient: ResidentRecipientSummary;
}): string {
  return `📦 Paket von ${args.holder.name} (${args.holder.houseNumber}) an ${args.recipient.name} (${args.recipient.houseNumber}).`;
}

/**
 * Compose the recipient DM body. Private — names the holder + their
 * address details (house number, floor, buzzer) so the recipient can
 * walk over and collect. Includes the `[Abgeholt]` button only in
 * this DM (v2.1 #114: the group ack no longer carries the button;
 * pickup is private business between the recipient and the bot).
 *
 * Slice 1 ships de-only. Recipients on the MVP street are almost all
 * German-speakers; the en/es/tr variants land alongside Slice 3
 * (#109) which introduces the broader Flow 1 disambiguation surface
 * and the localised templates the agent's clarification synthetic
 * needs.
 *
 *     Hi <recipient.name>! <holder.name> hat ein Paket für dich
 *     angenommen.
 *
 *     📍 <holder.houseNumber>[, Stock <floor>][ — Klingel <buzzer>]
 *
 *     Melde dich, wenn du es abgeholt hast — tippe einfach auf
 *     [Abgeholt].
 */
export function buildRecipientDmText(args: {
  readonly holder: HolderSummary;
  readonly recipient: ResidentRecipientSummary;
}): string {
  const { holder, recipient } = args;
  const floorClause = holder.floor ? `, Stock ${holder.floor}` : "";
  const buzzerClause = holder.buzzerName
    ? ` — Klingel ${holder.buzzerName}`
    : "";
  return [
    `Hi ${recipient.name}! ${holder.name} hat ein Paket für dich angenommen.`,
    "",
    `📍 ${holder.houseNumber}${floorClause}${buzzerClause}`,
    "",
    "Melde dich, wenn du es abgeholt hast — tippe einfach auf [Abgeholt].",
  ].join("\n");
}

/**
 * One-sentence localised nudge for an unregistered holder who tried
 * to register a package. Sent ONCE (best-effort) when
 * `registerPackage` throws `REGISTER_PACKAGE_HOLDER_NOT_REGISTERED`
 * so the user has a clear next step. Same de/en/es/tr language set as
 * the rest of the v2.1 channel; falls back to German.
 */
const HOLDER_NOT_REGISTERED_NUDGES: Readonly<Record<string, string>> = {
  de: "Um Pakete für andere zu registrieren, registriere dich zuerst mit /register.",
  en: "To register packages for neighbours, please /register first.",
  es: "Para registrar paquetes para vecinos, primero usa /register.",
  tr: "Komşular için paket kaydetmek için önce /register komutunu kullan.",
};

export function buildHolderNotRegisteredNudge(
  raw: string | null | undefined,
): string {
  if (raw && HOLDER_NOT_REGISTERED_NUDGES[raw]) {
    return HOLDER_NOT_REGISTERED_NUDGES[raw]!;
  }
  return HOLDER_NOT_REGISTERED_NUDGES["de"]!;
}

/**
 * v2.1 #110: DM-text pickup confirmation responses. When a registered
 * resident DMs "Hab abgeholt" / "Picked up" / etc., the classifier
 * routes them through the same `lib/pickup.ts::confirmPickup` lib the
 * button-tap path uses (#108). The DM-text surface has different UX
 * surfaces from the button tap, so it gets its own template set:
 *
 *   - 0 open packages → tell the user there's nothing to close.
 *   - 1 open package  → confirm + thanks (the holder gets the same
 *                       thanks DM via `pickup-dms.ts::buildHolderThanksDmText`).
 *   - 2+ open packages → ask the user to disambiguate by tapping
 *                        [Abgeholt] in the per-package DM the bot
 *                        already sent above (v2.1 #115: the group ack
 *                        no longer carries the button after #114, so
 *                        the recipient's own DM thread is the only
 *                        surface with a button per package).
 *   - already done   → idempotent — the package is already closed.
 *   - retry          → recoverable failure (Redis hiccup, lookup
 *                       throws). User can re-send the DM.
 *
 * Localised de/en/es/tr, same set as flow-2-dms.ts /
 * volunteer-accept-dms.ts / pickup-dms.ts; falls back to German.
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

const DM_TEXT_PICKUP_NO_OPEN_PACKAGES: Readonly<
  Record<SupportedLanguage, string>
> = {
  de: "Du hast aktuell kein offenes Paket bei mir.",
  en: "You don't have any open packages with me right now.",
  es: "Ahora mismo no tienes ningún paquete pendiente conmigo.",
  tr: "Şu anda bende açık bir paketin yok.",
};

export function buildDmTextPickupNoOpenPackagesText(
  raw: string | null | undefined,
): string {
  return DM_TEXT_PICKUP_NO_OPEN_PACKAGES[pickLanguage(raw)];
}

const DM_TEXT_PICKUP_MULTIPLE_PACKAGES: Readonly<
  Record<SupportedLanguage, string>
> = {
  de: "Du hast mehrere offene Pakete. Bitte tippe [Abgeholt] in der entsprechenden DM oben — ich habe dir für jedes Paket eine eigene Nachricht geschickt.",
  en: "You have multiple open packages. Please tap [Abgeholt] in the corresponding DM above — I sent you a separate message for each one.",
  es: "Tienes varios paquetes pendientes. Por favor toca [Abgeholt] en el DM correspondiente arriba — te envié un mensaje aparte para cada uno.",
  tr: "Birden fazla açık paketin var. Lütfen yukarıdaki ilgili DM'de [Abgeholt] düğmesine dokun — her paket için ayrı bir mesaj gönderdim.",
};

export function buildDmTextPickupMultiplePackagesText(
  raw: string | null | undefined,
): string {
  return DM_TEXT_PICKUP_MULTIPLE_PACKAGES[pickLanguage(raw)];
}

const DM_TEXT_PICKUP_CONFIRMED: Readonly<
  Record<SupportedLanguage, string>
> = {
  de: "Hab notiert — danke!",
  en: "Got it — thanks!",
  es: "Anotado — ¡gracias!",
  tr: "Not aldım — teşekkürler!",
};

export function buildDmTextPickupConfirmedText(
  raw: string | null | undefined,
): string {
  return DM_TEXT_PICKUP_CONFIRMED[pickLanguage(raw)];
}

const DM_TEXT_PICKUP_ALREADY_DONE: Readonly<
  Record<SupportedLanguage, string>
> = {
  de: "Dieses Paket wurde schon abgeholt.",
  en: "This package has already been picked up.",
  es: "Este paquete ya ha sido recogido.",
  tr: "Bu paket zaten alınmış.",
};

export function buildDmTextPickupAlreadyDoneText(
  raw: string | null | undefined,
): string {
  return DM_TEXT_PICKUP_ALREADY_DONE[pickLanguage(raw)];
}

const DM_TEXT_PICKUP_RETRY: Readonly<Record<SupportedLanguage, string>> = {
  de: "Etwas ist schiefgelaufen. Bitte gleich nochmal versuchen.",
  en: "Something went wrong. Please try again in a moment.",
  es: "Algo salió mal. Por favor inténtalo de nuevo en un momento.",
  tr: "Bir şeyler ters gitti. Lütfen birazdan tekrar dene.",
};

export function buildDmTextPickupRetryText(
  raw: string | null | undefined,
): string {
  return DM_TEXT_PICKUP_RETRY[pickLanguage(raw)];
}

/**
 * v2.1 #109 (Slice 3 of #105): localised group question the channel
 * posts when a Flow 1 inbound's recipient name doesn't resolve to any
 * known street identity (`recipientResolution.kind === "unknown"`). The
 * post is neutral — no DM, no inline keyboard — and asks the group to
 * surface someone who knows the named recipient. The existing
 * `scan_unresolved_recipient_packages`-style 3-day cleanup
 * (or equivalent) handles unanswered questions; this slice just emits
 * the question.
 *
 * Posted in the holder's language (whoever uploaded the label is the
 * one most likely to share a language with the rest of the group);
 * falls back to German.
 */
const UNKNOWN_RECIPIENT_GROUP_QUESTIONS: Readonly<
  Record<SupportedLanguage, (name: string) => string>
> = {
  de: (name) => `📦 Paket für ${name} – kennt jemand ${name}?`,
  en: (name) => `📦 Package for ${name} – does anyone know ${name}?`,
  es: (name) => `📦 Paquete para ${name} – ¿alguien conoce a ${name}?`,
  tr: (name) => `📦 ${name} için paket – ${name} adında birini tanıyan var mı?`,
};

export function buildUnknownRecipientGroupQuestion(
  recipientName: string,
  rawLanguage: string | null | undefined,
): string {
  return UNKNOWN_RECIPIENT_GROUP_QUESTIONS[pickLanguage(rawLanguage)](
    recipientName,
  );
}

/**
 * v2.1 #109 (Slice 3 of #105): discriminator for the
 * `[FLOW_1 CLARIFICATION]` synthetic the channel hands the agent when
 * it genuinely can't deterministically resolve a Flow 1 inbound.
 *
 *   - `low-conf`         — classifier/vision returned medium or low
 *                          confidence with a non-resident resolution
 *                          (or an unknown recipient at low/medium
 *                          confidence; high-conf unknowns go to the
 *                          group-question branch instead).
 *   - `missing-recipient`— classifier/vision was positive but the
 *                          recipient name field is absent (or there
 *                          are zero recipients on a positive
 *                          registration verdict).
 *   - `ambiguous-multi`  — the inbound names two or more recipients
 *                          but the channel only parsed one (typical
 *                          photo case: caption says "Paket für Anna
 *                          und Beate", label says just "Anna").
 *   - `parse-failed`     — vision tool threw on both primary +
 *                          fallback. Channel can't even tell what's
 *                          on the label; the agent asks the holder
 *                          to retype the recipient.
 */
export type Flow1ClarificationReason =
  | "low-conf"
  | "missing-recipient"
  | "ambiguous-multi"
  | "parse-failed";

/**
 * Synthetic the channel hands the agent on a Flow 1 disambiguation
 * fallthrough. Kept in English regardless of the holder's language:
 * the agent's reply uses `args.language` and the system prompt
 * localises the *output*, so this scaffolding text never reaches
 * end users.
 *
 * The shape matches the design in #109's body — recipient/confidence/
 * caption fields are embedded so the agent can quote them in its
 * clarifying question without re-running classification.
 */
export function buildFlow1ClarificationSynthetic(args: {
  readonly language: string;
  readonly reason: Flow1ClarificationReason;
  readonly source: "text" | "photo";
  readonly carrier?: string;
  readonly recipientName?: string;
  readonly confidence?: "low" | "medium" | "high";
  readonly caption?: string;
  readonly holderName?: string;
  readonly holderHouseNumber?: string;
}): string {
  const recipient = args.recipientName ?? "none";
  const confidence = args.confidence ?? "low";
  const carrier = args.carrier ?? "unknown";
  const fieldLabel = args.source === "photo" ? "Caption" : "Text";
  const captionLine =
    args.caption && args.caption.length > 0 ? args.caption : "(no caption)";
  const holder = args.holderName ?? "(unknown)";
  const holderHouse = args.holderHouseNumber ?? "?";
  return [
    `[FLOW_1 CLARIFICATION language=${args.language} reason=${args.reason}]`,
    `The channel parsed: carrier=${carrier} recipientName=${recipient} confidence=${confidence}.`,
    `${fieldLabel}: ${captionLine}.`,
    `Holder: ${holder} (house ${holderHouse}).`,
    `Your only job: ONE short clarifying question in ${args.language} to the holder.`,
    `Do NOT call any tools. Do NOT post to the group. Do NOT mention finding`,
    `neighbours, availability, or absence.`,
  ].join("\n");
}

/**
 * Cheap regex heuristic for "the caption names 2+ recipients but the
 * vision tool only returned 1". Detects:
 *
 *   - "Anna und Beate" / "Anna and Beate" (German/English conjunction)
 *   - "Anna, Beate" (comma between two capitalised words)
 *
 * Used by the photo route to upgrade a low-conf or missing-recipient
 * fallthrough to `reason=ambiguous-multi` so the agent's clarifying
 * question can ask about the second label directly ("Sehe ich noch
 * ein zweites Etikett?"). Returning false here means the channel
 * reports the primary reason; nothing breaks if the heuristic misses.
 */
export function captionLooksLikeMultiRecipient(
  caption: string | undefined,
): boolean {
  if (!caption) return false;
  // Two capitalised name-shaped tokens joined by "und" / "and" / comma.
  const re =
    /[A-ZÄÖÜ][\p{L}-]+(?:\s+[A-ZÄÖÜ][\p{L}-]+)?\s+(?:und|and|y|ve)\s+[A-ZÄÖÜ][\p{L}-]+|[A-ZÄÖÜ][\p{L}-]+\s*,\s*[A-ZÄÖÜ][\p{L}-]+/u;
  return re.test(caption);
}
