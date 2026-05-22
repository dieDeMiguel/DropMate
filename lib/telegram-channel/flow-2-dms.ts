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
 * Recovery prompt — the channel could not extract enough fields from a
 * DM photo (low confidence, vision-tool null/throw, unregistered photo
 * sender, getFileUrl throw, or createReceptionRequest hiccup). One
 * self-contained sentence per language pointing the user at `/receive`
 * (the explicit, classifier-bypassing Flow 2 entry from Slice 2 / #87).
 * Includes the `/register` hint inline so an unregistered user who sent
 * a photo gets the same recovery path without a second turn.
 */
const FLOW_2_VLC_DMS: Readonly<Record<SupportedLanguage, string>> = {
  de: "Ich konnte den Beleg nicht eindeutig lesen. Bitte versuche es nochmal mit /receive (z. B. /receive DHL morgen 14-16). Falls du dich noch nicht registriert hast, beginne mit /register.",
  en: "I couldn't read the receipt confidently. Please retry with /receive (e.g. /receive DHL morgen 14-16). If you haven't registered yet, start with /register.",
  es: "No pude leer el recibo con seguridad. Por favor intenta de nuevo con /receive (ej. /receive DHL morgen 14-16). Si aún no te has registrado, empieza con /register.",
  tr: "Belgeyi net okuyamadım. Lütfen tekrar /receive ile dene (örn. /receive DHL morgen 14-16). Henüz kayıt olmadıysan, /register ile başla.",
};

export function buildFlow2VisionLowConfidenceDm(
  raw: string | null | undefined,
): string {
  const language = pickLanguage(raw);
  return FLOW_2_VLC_DMS[language];
}
