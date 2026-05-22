/**
 * Deterministic templates for the channel-side Flow 1 pickup-tap
 * surface.
 *
 * v2.1 #108 (Slice 4 of #105): when the recipient taps `[Abgeholt]`
 * on the group ack posted by Slice 1 (#106) — or on the recipient
 * DM that also carries the keyboard — the channel writes the
 * group-ack edit + the holder thanks DM itself instead of handing
 * the agent a `[button-tap] …` synthetic and letting the model
 * compose them. Same shape pattern that closed Flow 2's text-leak
 * surface (#96 Part A, #100): the model never runs on the happy
 * path, so it cannot fire a welcome wall, paraphrase the card text,
 * or name deleted tools.
 *
 * Localised to de/en/es/tr — same set as `flow-2-dms.ts`,
 * `volunteer-accept-dms.ts`, and `flow-1-dms.ts::HOLDER_NOT_REGISTERED_NUDGES`.
 * A fifth language only has to be added in lockstep across those
 * four files.
 *
 * @see lib/telegram-channel/process-update.ts — handleCallbackQuery
 * @see lib/pickup.ts                           — confirmPickup core
 */

import type {
  PickupHolderSummary,
  PickupRecipientSummary,
} from "../pickup.js";

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
 * Compose the edited-in-place group ack body. Replaces the
 * `📦 Paket von … an …` line posted by Slice 1 with the same
 * structure plus a trailing `– ✅ abgeholt` marker so the group can
 * see the package is closed without reading a new message.
 *
 * Falls back to the names frozen on the Package record (passed via
 * the caller) when the resident lookups returned null — that
 * preserves group narration even if the holder or recipient
 * de-registered between Slice 1's post and the recipient tapping.
 */
export function buildGroupAckPickedUpText(args: {
  readonly holder: { readonly name: string; readonly houseNumber: string };
  readonly recipient: { readonly name: string; readonly houseNumber: string };
}): string {
  const { holder, recipient } = args;
  return `📦 Paket von ${holder.name} (${holder.houseNumber}) an ${recipient.name} (${recipient.houseNumber}) – ✅ abgeholt`;
}

/**
 * Per-language thanks DM the channel sends to the holder when the
 * recipient closes the package. Names the recipient so the holder
 * knows which neighbour just collected. One sentence — the DM is a
 * close-the-loop confirmation, not a procedural handoff.
 */
const HOLDER_THANKS_DM_TEMPLATES: Readonly<Record<
  SupportedLanguage,
  (recipientName: string) => string
>> = {
  de: (recipientName) =>
    `${recipientName} hat das Paket abgeholt – danke fürs Annehmen!`,
  en: (recipientName) =>
    `${recipientName} has picked up the package — thanks for taking it in!`,
  es: (recipientName) =>
    `${recipientName} ha recogido el paquete — ¡gracias por aceptarlo!`,
  tr: (recipientName) =>
    `${recipientName} paketi aldı — kabul ettiğin için teşekkürler!`,
};

/**
 * Build the thanks DM the channel sends to the holder. Language
 * picked off the holder's stored language with German fallback.
 */
export function buildHolderThanksDmText(args: {
  readonly holder: PickupHolderSummary;
  readonly recipient: PickupRecipientSummary;
}): string {
  const language = pickLanguage(args.holder.language);
  return HOLDER_THANKS_DM_TEMPLATES[language](args.recipient.name);
}

/**
 * Per-language toast for the `PICKUP_NOT_RECIPIENT` failure case
 * (caller is not the package's recipient). Permanent rejection —
 * the channel strips the keyboard alongside this toast so the
 * caller doesn't keep re-tapping.
 */
const PICKUP_NOT_RECIPIENT_TOASTS: Readonly<Record<
  SupportedLanguage,
  string
>> = {
  de: "Du bist nicht der Empfänger dieses Pakets.",
  en: "You are not the recipient of this package.",
  es: "No eres el destinatario de este paquete.",
  tr: "Bu paketin alıcısı sen değilsin.",
};

export function pickupNotRecipientToast(
  raw: string | null | undefined,
): string {
  const language = pickLanguage(raw);
  return PICKUP_NOT_RECIPIENT_TOASTS[language];
}

/**
 * Per-language toast for the `PICKUP_ALREADY_DONE` failure case
 * (package is already in `status: "picked_up"`). Keyboard should
 * already be stripped from the previous success; no further
 * keyboard action needed.
 */
const PICKUP_ALREADY_DONE_TOASTS: Readonly<Record<
  SupportedLanguage,
  string
>> = {
  de: "Dieses Paket wurde schon abgeholt.",
  en: "This package has already been picked up.",
  es: "Este paquete ya ha sido recogido.",
  tr: "Bu paket zaten alınmış.",
};

export function pickupAlreadyDoneToast(
  raw: string | null | undefined,
): string {
  const language = pickLanguage(raw);
  return PICKUP_ALREADY_DONE_TOASTS[language];
}

/**
 * Per-language generic retry toast for the recoverable failure
 * class (Redis hiccup, `getRegisteredResident` race vs gate, …).
 * Keyboard stays live in this branch so the caller can re-tap once
 * the underlying hiccup clears.
 *
 * Mirrors `ACCEPT_RETRY_TOASTS` in `process-update.ts` verbatim;
 * exported separately here so the pickup callback site doesn't
 * have to import the volunteer-accept retry table.
 */
const PICKUP_RETRY_TOASTS: Readonly<Record<SupportedLanguage, string>> = {
  de: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
  en: "Something went wrong. Please try again.",
  es: "Algo salió mal. Por favor inténtalo de nuevo.",
  tr: "Bir şeyler ters gitti. Lütfen tekrar deneyin.",
};

export function pickupRetryToast(raw: string | null | undefined): string {
  const language = pickLanguage(raw);
  return PICKUP_RETRY_TOASTS[language];
}
