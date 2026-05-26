/**
 * Deterministic DM templates for the channel-side Flow 2 entry paths.
 *
 * v2.1 #100: when a free-text DM, `/receive` slash, or DM photo enters
 * Flow 2 successfully (the channel posted the neutral group card), the
 * channel writes the one-sentence ack DM itself instead of handing the
 * agent a `[FLOW_2 DONE]` synthetic and letting the model compose it.
 * Same fix pattern as #96 Part A applied to the volunteer-accept path:
 * the live trace showed the model free-form-emitting welcome walls +
 * duplicate registration confirmations + the FLOW_2 ack repeated 3×
 * after the channel-deterministic Flow 2 path had already done its job.
 *
 * For the "couldn't classify confidently" / "vision parse failed" /
 * "unregistered photo sender" / "Redis hiccup" cases the channel
 * previously handed the agent a `[VISION_LOW_CONFIDENCE]` synthetic.
 * Same fix: render a deterministic localised DM here and send it
 * directly, so the agent never runs on the Flow 2 entry path either.
 *
 * Both DMs are localised to the four languages the rest of the v2.1
 * channel-side surface covers (de/en/es/tr — same set as the volunteer
 * DM templates and the retry/cross-street/self-accept toasts). Unknown
 * languages fall back to German since the agent never sees these
 * synthetics anymore — there's no fallback path to drop the example
 * line and let the model improvise.
 *
 * @see lib/telegram-channel/process-update.ts — routeDmTextThroughClassifier,
 *   routeReceiveCommand, routeDmPhoto
 */

import { normaliseLanguageCode } from "../language.js";

type SupportedLanguage = "de" | "en" | "es" | "tr";

const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set<SupportedLanguage>([
  "de",
  "en",
  "es",
  "tr",
]);

function pickLanguage(raw: string | null | undefined): SupportedLanguage {
  const normalised = normaliseLanguageCode(raw);
  if (normalised && SUPPORTED_LANGUAGES.has(normalised)) {
    return normalised as SupportedLanguage;
  }
  return "de";
}

/**
 * Success ack — the channel just wrote the ReceptionRequest and the
 * neutral group card landed. One short sentence per language confirming
 * the request was passed to the group; no carrier/window/date repetition
 * (the card holds those).
 */
const FLOW_2_ACK_DMS: Readonly<Record<SupportedLanguage, string>> = {
  de: "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
  en: "Asked in the group — I'll let you know as soon as someone says yes.",
  es: "Pregunté en el grupo — te aviso en cuanto alguien responda.",
  tr: "Gruba sordum — biri yanıt verince haber veririm.",
};

export function buildFlow2AckDm(raw: string | null | undefined): string {
  const language = pickLanguage(raw);
  return FLOW_2_ACK_DMS[language];
}

/**
 * v2.1 #128: 3-path recovery DM for an unclassifiable DM photo. Sent
 * when the unified `parse_package_photo` returns `kind: "unknown"`,
 * when the vision tool throws on both primary + fallback, or when
 * `getFileUrl` fails. Replaces the pre-#128 single-path "retry via
 * /receive" copy.
 *
 * Lists three concrete next steps the sender can take:
 *   - retake a clearer LABEL photo (Flow 1 entry — the DM is now the
 *     privacy-correct surface for shipping labels per #128)
 *   - type the label details as text ("DHL for Anna Müller at #5") —
 *     handled today by the agent fallthrough
 *   - use `/receive` if expecting a package (Flow 2 entry)
 *
 * One self-contained DM per language. The `/register` hint is inlined
 * so an unregistered user who sent a photo gets the full recovery path
 * without a second turn. de/en/es/tr; falls back to German.
 */
const VLC_3_PATH_DMS: Readonly<Record<SupportedLanguage, string>> = {
  de:
    "Ich konnte das Foto nicht eindeutig zuordnen. Drei Wege weiter:\n" +
    "• Schicke mir das Etikett nochmal als deutlicheres Foto — ich registriere das Paket dann hier.\n" +
    "• Oder tippe die Etikett-Details als Text (z. B. „DHL für Anna Müller, Nummer 5\").\n" +
    "• Oder erwartest du selbst ein Paket? Dann nutze /receive (z. B. /receive DHL morgen 14-16).\n" +
    "Falls du dich noch nicht registriert hast, beginne mit /register.",
  en:
    "I couldn't classify that photo confidently. Three options:\n" +
    "• Resend a clearer photo of the label — I'll register the package here.\n" +
    "• Or type the label details as text (e.g. \"DHL for Anna Müller at #5\").\n" +
    "• Or are you expecting a package yourself? Use /receive (e.g. /receive DHL morgen 14-16).\n" +
    "If you haven't registered yet, start with /register.",
  es:
    "No pude clasificar la foto con seguridad. Tres opciones:\n" +
    "• Vuelve a enviarme una foto más clara de la etiqueta — registro el paquete aquí.\n" +
    "• O escribe los datos como texto (p. ej. „DHL para Anna Müller, número 5\").\n" +
    "• ¿O esperas un paquete tú mismo? Usa /receive (p. ej. /receive DHL morgen 14-16).\n" +
    "Si aún no te has registrado, empieza con /register.",
  tr:
    "Fotoğrafı net sınıflandıramadım. Üç seçenek var:\n" +
    "• Etiketin daha net bir fotoğrafını gönder — paketi burada kaydederim.\n" +
    "• Ya da etiket bilgilerini yaz (örn. „Anna Müller için DHL, no. 5\").\n" +
    "• Kendi paketini mi bekliyorsun? /receive ile dene (örn. /receive DHL morgen 14-16).\n" +
    "Henüz kayıt olmadıysan /register ile başla.",
};

export function buildVlc3PathDm(raw: string | null | undefined): string {
  const language = pickLanguage(raw);
  return VLC_3_PATH_DMS[language];
}
