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
 * Both surfaces carry the `[Abgeholt]` inline keyboard (one row, one
 * button) with `callback_data: confirm_pickup:<package.id>`. The
 * existing `handleCallbackQuery` path in `process-update.ts` already
 * routes that action (#24), so the close-the-loop pickup tap works
 * the same way it did for the agent-driven Flow 1.
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
 * `confirm_pickup:<package.id>` so the recipient (or any registered
 * resident, with scope-gating in the callback handler) can close the
 * package by tapping the same button on either the group ack OR the
 * recipient DM.
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
 * walk over and collect. Includes the `[Abgeholt]` button in the
 * recipient DM AND in the group ack so they can close from either
 * surface.
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
 *     [Abgeholt] hier oder in der Gruppe.
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
    "Melde dich, wenn du es abgeholt hast — tippe einfach auf [Abgeholt] hier oder in der Gruppe.",
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
 *   - 2+ open packages → ask the user to disambiguate by tapping the
 *                        button on the right group ack (the button is
 *                        unambiguous; DM text isn't).
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
  de: "Welches Paket meinst du? Bitte tippe in der Gruppe auf [Abgeholt] beim richtigen Paket.",
  en: "Which package? Please tap [Picked up] on the right one in the group.",
  es: "¿Cuál paquete? Por favor toca [Recogido] en el correcto en el grupo.",
  tr: "Hangi paket? Lütfen gruptaki doğru paketin [Alındı] düğmesine dokun.",
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
