/**
 * `classify_dm_intent` — deterministic classifier for free-text DMs.
 *
 * v2.1 #110 widens the output schema from a boolean `isFlow2` to a
 * discriminated `kind` so the channel can route pickup-confirmation
 * DMs ("Hab abgeholt", "Picked up", "Recibido", "Teslim aldım") in
 * addition to Flow 2 ("I won't be home") inbounds. Both routes are
 * channel-deterministic — the agent never runs on the success path.
 *
 * v2.1 Slice 1 (#86): in v2, the conversational agent decided whether
 * an inbound free-text DM should write a reception request,
 * `register_expected_delivery`, look up neighbours, etc. The v2
 * regression (#85) showed this can't be left to the model — a single
 * DM "Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause" fired
 * nine tools across mutually-exclusive branches. v2.1 moves the
 * routing decision OUT of the model by calling this classifier from
 * `process-update.ts` BEFORE the agent runs. Slice 5 (#90) then hard-
 * deleted the legacy tools so the model literally cannot relapse.
 *
 * v2.1 Bug 1 fix (#93 / #92 Trace A): the v2.1 ship attempt produced a
 * card reading `heute 06:00–08:00` for the input `Ich erwarte morgen
 * 14-16 Uhr DHL und bin nicht zu Hause` (correct: `morgen 14:00–16:00`).
 * Root cause was a class of model arithmetic errors — the model was
 * being asked to emit Unix-ms numbers, conflate `morgen` (tomorrow)
 * with `morgens` (in the morning), and resolve the date without a
 * Berlin-anchored "today" stamp.
 *
 * The fix splits the model contract from the public return shape:
 *
 *   - **Model output schema** uses Berlin-local clock strings on a
 *     `YYYY-MM-DD` date — fields the model can name without
 *     arithmetic.
 *   - **Public return shape** stays the same (Unix ms) for downstream
 *     consumers. `execute()` converts the model's local strings into
 *     Unix ms via the same DST-safe Berlin helpers
 *     (`lib/berlin-time.ts`) the `/receive` parser uses.
 *
 * Same fallback chain as `parse_tracking_page`:
 *
 *   primary:  google/gemini-2.5-flash — cheap, multilingual NLU
 *   fallback: anthropic/claude-sonnet-4.6 — stronger reasoning, fewer
 *                                            false positives on idioms
 *
 * **Confidence rules (PRD-derived, false-positive cost > false-negative)**:
 *
 *   `confidence: "high"` ONLY when
 *     (a) an explicit absence signal is detected AND
 *     (b) at least one supporting field (carrier OR window) is present.
 *
 *   Ambiguous = `"medium"` or `"low"`. The channel posts the card ONLY
 *   on `confidence: "high"`; lower confidence falls through to the
 *   agent untouched so it can ask a follow-up or do whatever the
 *   plain text suggests.
 *
 *   This conservative bias is deliberate: a false positive posts a
 *   privacy-violating "X is expecting a package" to the group (PRD §9);
 *   a false negative just means the user re-asks with `/receive`. The
 *   second cost is much cheaper.
 */

import { defineTool } from "experimental-ash/tools";
import { generateObject } from "ai";
import { z } from "zod";

import {
  berlinClockToUnixMs,
  berlinDayParts,
  berlinDayPartsFromYmd,
  berlinWeekday,
  formatBerlinDate,
} from "../../lib/berlin-time.js";
import { packageCarrierSchema, type PackageCarrier } from "../../lib/redis.js";

export const PRIMARY_MODEL = "google/gemini-2.5-flash";
export const FALLBACK_MODEL = "anthropic/claude-sonnet-4.6";

const inputSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "The full inbound DM text in its original language. The channel " +
        "passes this through verbatim — no preprocessing.",
    ),
  languageHint: z
    .string()
    .optional()
    .describe(
      "Optional BCP-47 / ISO-639-1 language code from the Telegram " +
        "client (`message.from.language_code`). Used only as a hint " +
        "for the model when the text is short or ambiguous.",
    ),
});

/**
 * Schema the model fills. Internal to this tool — `execute()` converts
 * `expectedWindowStartLocal` / `expectedWindowEndLocal` into Unix ms
 * before returning to the channel.
 */
const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const modelOutputSchema = z.object({
  kind: z
    .enum([
      "flow2-reception",
      "pickup-confirmation",
      "registration",
      "other",
    ])
    .describe(
      "Discriminated intent of the inbound DM. Set EXACTLY one:\n" +
        "  - 'flow2-reception'      — pre-announce ('I won't be home'); the\n" +
        "                              channel writes a ReceptionRequest +\n" +
        "                              posts the neutral group card. Both\n" +
        "                              absenceSignal AND a supporting field\n" +
        "                              (carrier/window) should be present at\n" +
        "                              high confidence.\n" +
        "  - 'pickup-confirmation'  — the writer is confirming they already\n" +
        "                              picked up a held package ('Hab\n" +
        "                              abgeholt', 'Picked up', 'Recibido',\n" +
        "                              'Teslim aldım'). The channel resolves\n" +
        "                              which package via the writer's own\n" +
        "                              held-packages list. Set when the\n" +
        "                              writer is unambiguously closing\n" +
        "                              their own pickup. Conservative bias.\n" +
        "  - 'registration'         — `/register <name>, <street> <number>`\n" +
        "                              shape or the free-text equivalent.\n" +
        "  - 'other'                — everything else (chit-chat, Flow 0\n" +
        "                              without absence, Flow 3 search, Flow\n" +
        "                              1 group-label, unknown).",
    ),
  absenceSignal: z
    .boolean()
    .describe(
      "True iff the text explicitly states the writer will not be home. " +
        "See the system prompt's per-language absence-phrase list. False " +
        "when no clear absence signal is present.",
    ),
  carrier: packageCarrierSchema
    .optional()
    .describe(
      "Carrier if mentioned (DHL, Hermes, DPD, GLS, UPS, Amazon, " +
        "unknown). Omit when the user didn't name one.",
    ),
  expectedDate: z
    .string()
    .date()
    .optional()
    .describe(
      "Expected delivery date in 'YYYY-MM-DD' (Europe/Berlin), resolved " +
        "against the 'Today is …' anchor in the user prompt. Resolve " +
        "relative date words ('heute'/'today'/'hoy'/'bugün', " +
        "'morgen'/'tomorrow'/'mañana'/'yarın', 'übermorgen'/'pasado " +
        "mañana'/'öbür gün') and German weekday names ('Montag', …, " +
        "'Sonntag') against that anchor. Omit when the user gave no day.",
    ),
  expectedWindowStartLocal: z
    .string()
    .regex(HHMM_REGEX, "Must be 24h clock 'HH:mm'")
    .optional()
    .describe(
      "Window start as a Berlin local 24-hour clock string 'HH:mm' " +
        "(e.g. '14:00') on `expectedDate`. Do NOT emit Unix " +
        "timestamps or ISO strings here — just the clock face. The " +
        "tool's post-processing converts this to Europe/Berlin Unix " +
        "ms using a tzdb-backed offset. If the user gives a single " +
        "point in time ('um 14 Uhr'), set start === end. Omit when " +
        "the text gives no time at all.",
    ),
  expectedWindowEndLocal: z
    .string()
    .regex(HHMM_REGEX, "Must be 24h clock 'HH:mm'")
    .optional()
    .describe(
      "Window end as a Berlin local 24-hour clock string 'HH:mm'. " +
        "Paired with `expectedWindowStartLocal` — both supplied " +
        "together or both omitted. Must be >= start.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Routing confidence. Per-kind rules:\n" +
        "  - kind 'flow2-reception': `high` ONLY when absenceSignal &&\n" +
        "    (carrier OR window present). Anything else medium or low.\n" +
        "  - kind 'pickup-confirmation': `high` ONLY when the writer is\n" +
        "    unambiguously announcing they took possession ('Hab\n" +
        "    abgeholt', 'Picked up', 'Recibido', 'Teslim aldım'). A\n" +
        "    bare 'danke' or unrelated text is NOT a pickup confirmation.\n" +
        "  - kind 'registration': `high` on `/register …`; lower on\n" +
        "    free-text registration shapes.\n" +
        "  - kind 'other': always `low`.\n" +
        "The channel routes deterministically ONLY on `high`.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence explaining the classification. Logged on the " +
        "server; not shown to the user.",
    ),
});

/**
 * Discriminator on the classifier's intent verdict. Lifted out of the
 * `kind` field on `ClassifyDmIntentResult` so call sites can branch
 * on a named type rather than a string literal.
 */
export type DmIntentKind =
  | "flow2-reception"
  | "pickup-confirmation"
  | "registration"
  | "other";

/**
 * Public return shape. Window endpoints are Unix ms (Europe/Berlin),
 * converted from the model's local clock strings by `execute()`.
 *
 * `kind` (v2.1 #110) is the routing discriminator the channel
 * branches on. Pre-#110 callers consulted the boolean `isFlow2`;
 * post-#110 the equivalent check is `kind === "flow2-reception"`.
 */
export interface ClassifyDmIntentResult {
  readonly kind: DmIntentKind;
  readonly absenceSignal: boolean;
  readonly carrier?: PackageCarrier;
  readonly expectedDate?: string;
  readonly expectedWindowStartAt?: number;
  readonly expectedWindowEndAt?: number;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

export const classifierSystemPrompt = [
  "You are a deterministic classifier for a German-speaking",
  "neighbor-coordination bot. A registered resident sends the bot a",
  "free-text DM. Assign EXACTLY ONE `kind` value:",
  "",
  "  - 'flow2-reception'     — pre-announce 'I won't be home', the writer",
  "                             wants help receiving a package.",
  "  - 'pickup-confirmation' — the writer is confirming they already",
  "                             collected a held package addressed to",
  "                             them.",
  "  - 'registration'        — `/register …` or the free-text registration",
  "                             shape.",
  "  - 'other'               — chit-chat, Flow 0 pre-announce WITHOUT",
  "                             absence, Flow 3 search, Flow 1 group label,",
  "                             status request, unknown.",
  "",
  "===== kind: 'flow2-reception' =====",
  "",
  "Examples:",
  "  - 'Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause'",
  "  - 'Tomorrow I'll get a Hermes package but I'll be at work'",
  "  - 'Mañana espero un paquete de DHL pero no estaré en casa'",
  "  - 'Yarın bir DHL kargosu bekliyorum ama evde olmayacağım'",
  "  - 'Donnerstag kommt mein Paket, ich bin nicht da'",
  "",
  "NOT 'flow2-reception':",
  "  - 'Wo ist mein Paket?' — Flow 3 search, not a pre-announce → 'other'",
  "  - 'Habe ein Paket für Müller angenommen' — Flow 1 group label →",
  "    'other'",
  "  - 'Ein Paket kommt heute' — pre-announce WITHOUT absence → 'other'",
  "  - '/register <name>, <street> <number>' → 'registration'",
  "  - 'Danke!' / 'Hallo' / 'Wie geht's?' → 'other'",
  "",
  "===== kind: 'pickup-confirmation' =====",
  "",
  "The writer is closing the loop on a held package addressed to them.",
  "Canonical phrasings:",
  "  DE: 'Hab abgeholt', 'Habe das Paket abgeholt', 'Schon abgeholt',",
  "      'Hab das Paket', 'Ist abgeholt'",
  "  EN: 'Picked up', 'Got the package', 'Got it', 'Picked it up',",
  "      'Package picked up'",
  "  ES: 'Recibido', 'Lo recogí', 'Ya lo tengo', 'Paquete recogido',",
  "      'Lo he recogido'",
  "  TR: 'Teslim aldım', 'Paketi aldım', 'Aldım', 'Paket bende'",
  "",
  "Confidence rules:",
  "  - `high`   — unambiguous closing language (one of the canonical",
  "               phrasings or a clear paraphrase).",
  "  - `medium` — the writer might be confirming pickup but the language",
  "               is fuzzy ('ich habe das', 'I have it').",
  "  - `low`    — uncertain.",
  "",
  "NOT 'pickup-confirmation':",
  "  - 'Wo ist mein Paket?' — Flow 3 search → 'other'",
  "  - 'Habe ein Paket für Müller angenommen' — Flow 1 (writer is the",
  "    HOLDER, not the recipient) → 'other'",
  "  - 'Danke' / 'Thanks' alone — too generic → 'other'",
  "  - 'Ich nehme das Paket an' — accepting a Flow 2 ask, not pickup →",
  "    'other'",
  "",
  "Absence-signal phrases to recognise (across languages):",
  "  DE: 'nicht zu Hause', 'nicht da', 'im Büro', 'unterwegs',",
  "      'auf der Arbeit', 'verreist'",
  "  EN: 'won't be in', 'not home', 'not at home', 'out', 'at work',",
  "      'away', 'travelling'",
  "  ES: 'no estaré en casa', 'no estoy', 'fuera', 'en el trabajo'",
  "  TR: 'evde olmayacağım', 'evde değilim', 'dışarıdayım', 'işteyim'",
  "",
  "Carriers to recognise (otherwise omit):",
  "  DHL, Hermes, DPD, GLS, UPS, Amazon. FedEx → 'unknown'.",
  "",
  "===== CRITICAL: morgen ≠ morgens =====",
  "",
  "The German word 'morgen' ALWAYS means 'tomorrow' (the day after",
  "today). It is NEVER a time-of-day. The German word for 'morning' as",
  "a time-of-day is 'morgens', 'am Morgen', 'vormittags', or 'in der",
  "Frühe'. When the user writes 'morgen 14-16 Uhr', interpret it as:",
  "",
  "    expectedDate            = TOMORROW (the date in the prompt's",
  "                              'Tomorrow is …' line)",
  "    expectedWindowStartLocal = '14:00'",
  "    expectedWindowEndLocal   = '16:00'",
  "",
  "NEVER set the date to today's date when the user writes 'morgen'.",
  "NEVER interpret 'morgen 14-16 Uhr' as '06:00–10:00 today' just",
  "because 'morgen' sounds like 'morning' in English.",
  "",
  "Same rule for English: 'tomorrow' is always a calendar day, never a",
  "time. 'mañana' (Spanish) and 'yarın' (Turkish) likewise.",
  "",
  "===== German time-of-day phrases =====",
  "",
  "Time-of-day words (DE) that mean 'this part of <the named day>':",
  "  'früh' / 'in der Frühe' / 'morgens' / 'am Morgen'  → 06:00-09:00",
  "  'Vormittag' / 'vormittags'                          → 09:00-12:00",
  "  'Mittag' / 'mittags'                                → 12:00-14:00",
  "  'Nachmittag' / 'nachmittags'                        → 14:00-18:00",
  "  'Abend' / 'abends'                                  → 18:00-21:00",
  "  'Nacht' / 'nachts'                                  → 21:00-23:59",
  "",
  "Combine with the day word:",
  "  'heute Vormittag'    → today 09:00-12:00",
  "  'heute Nachmittag'   → today 14:00-18:00",
  "  'morgen Vormittag'   → tomorrow 09:00-12:00 (NOT today morning)",
  "  'morgen früh'        → tomorrow 06:00-09:00 (NOT today morning)",
  "",
  "===== German weekday names =====",
  "",
  "Montag, Dienstag, Mittwoch, Donnerstag, Freitag, Samstag, Sonntag",
  "resolve to the NEXT occurrence of that weekday in Europe/Berlin,",
  "relative to the 'Today is …' anchor in the user prompt. If today is",
  "Mittwoch and the user writes 'Donnerstag', that is tomorrow. If",
  "today IS Donnerstag and the user writes 'Donnerstag', resolve to",
  "one week from today.",
  "",
  "===== Windows =====",
  "",
  "When the text gives a time like '14-16 Uhr' / '2-4pm' / 'de 14 a 16' /",
  "'14-16 arasında', set `expectedWindowStartLocal` and",
  "`expectedWindowEndLocal` to the Berlin-local clock-face strings",
  "('HH:mm'). For a single point ('um 14 Uhr'), set start === end.",
  "Always emit `expectedDate` alongside a window — anchor to today if",
  "the text gives a window but no day.",
  "",
  "Do NOT emit Unix timestamps or ISO strings in the window fields —",
  "only the 'HH:mm' clock face. The tool converts to Berlin Unix ms.",
  "",
  "===== Confidence =====",
  "",
  "  high   — kind: 'flow2-reception' AND absenceSignal AND (carrier OR",
  "           window present), OR kind: 'pickup-confirmation' AND",
  "           unambiguous closing language, OR kind: 'registration' with",
  "           the `/register` prefix.",
  "  medium — kind: 'flow2-reception' AND absenceSignal but no",
  "           supporting field, OR kind: 'pickup-confirmation' with",
  "           fuzzy closing language.",
  "  low    — kind: 'other' (always), or kind uncertain.",
  "",
  "Bias toward LOWER confidence when uncertain. A false-positive Flow 2",
  "posts to the group (privacy leak per PRD §9); a false-positive pickup",
  "closes the wrong package (canonical state corruption). False negatives",
  "are cheap — the writer just re-asks via /receive or taps the group",
  "[Abgeholt] button.",
].join("\n");

interface ClassifierArgs {
  readonly text: string;
  readonly languageHint?: string;
}

/**
 * Build the per-call user prompt with Berlin-anchored date references.
 * The model receives concrete `YYYY-MM-DD` values for today / tomorrow
 * / day-after-tomorrow so it can resolve relative date words without
 * doing arithmetic itself.
 */
export function buildClassifierUserPrompt(
  args: ClassifierArgs,
  now: number = Date.now(),
): string {
  const today = berlinDayParts(now, 0);
  const tomorrow = berlinDayParts(now, 1);
  const dayAfter = berlinDayParts(now, 2);
  const todayYmd = formatBerlinDate(today);
  const tomorrowYmd = formatBerlinDate(tomorrow);
  const dayAfterYmd = formatBerlinDate(dayAfter);
  const weekday = berlinWeekday(now);

  const dateBlock = [
    `Today is ${todayYmd} (${weekday}, Europe/Berlin).`,
    `Tomorrow is ${tomorrowYmd}. Day after tomorrow is ${dayAfterYmd}.`,
    "Resolve 'heute'/'today' → today; 'morgen'/'tomorrow' → tomorrow;",
    "'übermorgen' → day after tomorrow. Weekday names ('Montag', …)",
    "resolve to the NEXT occurrence relative to today.",
  ].join("\n");

  const hintLine = args.languageHint
    ? `Telegram client language hint: ${args.languageHint}.`
    : "No language hint from the client.";

  return [
    dateBlock,
    "",
    hintLine,
    "",
    "Inbound DM:",
    args.text,
  ].join("\n");
}

async function runClassifierModel(
  model: string,
  args: ClassifierArgs,
): Promise<ClassifyDmIntentResult> {
  const userPrompt = buildClassifierUserPrompt(args, Date.now());

  const { object } = await generateObject({
    model,
    schema: modelOutputSchema,
    system: classifierSystemPrompt,
    prompt: userPrompt,
    providerOptions: {
      gateway: {
        sort: "cost",
      },
    },
  });

  return toPublicResult(object);
}

/**
 * Convert the model's local clock strings into Berlin Unix ms.
 *
 * Exported for direct unit testing — the same conversion runs inside
 * `execute()` after every successful model call.
 */
export function toPublicResult(
  model: z.infer<typeof modelOutputSchema>,
): ClassifyDmIntentResult {
  const result: {
    kind: DmIntentKind;
    absenceSignal: boolean;
    carrier?: PackageCarrier;
    expectedDate?: string;
    expectedWindowStartAt?: number;
    expectedWindowEndAt?: number;
    confidence: "high" | "medium" | "low";
    reason: string;
  } = {
    kind: model.kind,
    absenceSignal: model.absenceSignal,
    confidence: model.confidence,
    reason: model.reason,
  };
  if (model.carrier !== undefined) result.carrier = model.carrier;
  if (model.expectedDate !== undefined) result.expectedDate = model.expectedDate;

  // Window fields: convert local clock + date → Unix ms. Both endpoints
  // must be present AND we need a date to anchor against. If anything is
  // missing, drop the window — better to surface a date-only request
  // than to invent a window with the wrong day.
  if (
    model.expectedWindowStartLocal !== undefined &&
    model.expectedWindowEndLocal !== undefined &&
    model.expectedDate !== undefined
  ) {
    try {
      const day = berlinDayPartsFromYmd(model.expectedDate);
      const [sh, sm] = parseHhmm(model.expectedWindowStartLocal);
      const [eh, em] = parseHhmm(model.expectedWindowEndLocal);
      const start = berlinClockToUnixMs(day, sh, sm);
      const end = berlinClockToUnixMs(day, eh, em);
      if (end >= start) {
        result.expectedWindowStartAt = start;
        result.expectedWindowEndAt = end;
      }
    } catch {
      // Malformed model output — drop the window fields rather than
      // throwing. The classifier still reports isFlow2 / carrier so
      // the channel can fall through to the agent.
    }
  }

  return result;
}

function parseHhmm(hhmm: string): [number, number] {
  const m = HHMM_REGEX.exec(hhmm);
  if (!m) throw new Error(`parseHhmm: not HH:mm — ${hhmm}`);
  const [h, mm] = hhmm.split(":");
  return [Number(h), Number(mm)];
}

export default defineTool({
  description:
    "Classify a free-text DM by intent kind ('flow2-reception', " +
    "'pickup-confirmation', 'registration', 'other'), extracting " +
    "Flow-2 supporting fields (carrier / date / window) when present. " +
    "Tries Gemini 2.5 Flash first, falls back to Claude Sonnet 4.6 if " +
    "the primary errors. Returns `{ kind, absenceSignal, carrier?, " +
    "expectedDate?, expectedWindowStartAt?, expectedWindowEndAt?, " +
    "confidence, reason }` (window endpoints in Europe/Berlin Unix " +
    "ms, converted in-tool from the model's local clock strings). " +
    "The channel routes deterministically off `confidence === 'high'` " +
    "and the `kind` discriminator — biased conservatively so false " +
    "positives (privacy-violating group posts, wrong-package pickup " +
    "closure) stay rare.",
  inputSchema,
  async execute({ text, languageHint }) {
    const args: ClassifierArgs = { text, languageHint };

    try {
      return await runClassifierModel(PRIMARY_MODEL, args);
    } catch (primaryError) {
      try {
        return await runClassifierModel(FALLBACK_MODEL, args);
      } catch {
        throw primaryError;
      }
    }
  },
});
