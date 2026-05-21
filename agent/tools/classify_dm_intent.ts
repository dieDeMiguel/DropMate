/**
 * `classify_dm_intent` — deterministic classifier for free-text DMs
 * the channel layer must route to Flow 2 v2 (the requester is
 * pre-announcing a package and wants help receiving it).
 *
 * v2.1 Slice 1 (#86): in v2, the conversational agent decided whether
 * an inbound free-text DM should trigger `create_reception_request`,
 * `register_expected_delivery`, `find_available_neighbors`, etc. The
 * v2 regression (#85) showed this can't be left to the model — a
 * single DM "Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause"
 * fired nine tools across mutually-exclusive branches. v2.1 moves the
 * routing decision OUT of the model by calling this classifier from
 * `process-update.ts` BEFORE the agent runs.
 *
 * Same fallback chain as `parse_tracking_page`:
 *
 *   primary:  google/gemini-2.5-flash — cheap, multilingual NLU
 *   fallback: anthropic/claude-sonnet-4.6 — stronger reasoning, fewer
 *                                            false positives on idioms
 *
 * Output schema is intentionally narrow. The channel reads the booleans
 * and confidence to decide whether to deterministically post a Flow 2
 * v2 group card, and surfaces the structured fields to
 * `createReceptionRequest` so the card includes whatever the user gave.
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
 *
 * Times are returned as Unix ms in Europe/Berlin (anchored to the
 * model's current date, which is good enough — the user can always
 * correct via `/receive`). `expectedDate` stays as `YYYY-MM-DD` so
 * `createReceptionRequest` can pass it through to `expectedAt`
 * unchanged when no concrete window was extracted.
 */

import { defineTool } from "experimental-ash/tools";
import { generateObject } from "ai";
import { z } from "zod";

import { packageCarrierSchema } from "../../lib/redis.js";

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

const outputSchema = z.object({
  isFlow2: z
    .boolean()
    .describe(
      "True iff the message is a Flow 2 (pre-announce, 'I won't be home') " +
        "inbound. False for Flow 1 (group label / package received), Flow " +
        "3 (search 'where is my package?'), Flow 4 (status request), " +
        "registration, language switch, or off-topic chat.",
    ),
  absenceSignal: z
    .boolean()
    .describe(
      "True iff the text explicitly states the writer will not be home. " +
        "German: 'nicht zu Hause', 'nicht da', 'im Büro', 'unterwegs'. " +
        "English: 'won't be in', 'not home', 'out', 'at work'. " +
        "Spanish: 'no estaré en casa', 'fuera'. Turkish: 'evde " +
        "olmayacağım', 'dışarıdayım'. Set false if no clear absence " +
        "signal is present.",
    ),
  carrier: packageCarrierSchema
    .optional()
    .describe(
      "Carrier if mentioned (DHL, Hermes, DPD, GLS, UPS, Amazon). " +
        "Omit when the user didn't name one.",
    ),
  expectedDate: z
    .string()
    .date()
    .optional()
    .describe(
      "Expected delivery date in 'YYYY-MM-DD' (Europe/Berlin). " +
        "Resolve relative date words ('heute', 'morgen', 'übermorgen', " +
        "'today', 'tomorrow', 'mañana', 'yarın') against the current " +
        "date. Omit when the user gave no day at all.",
    ),
  expectedWindowStartAt: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Start of the expected-delivery window in Unix ms (Europe/Berlin). " +
        "Returned only when the text gives a concrete time, e.g. '14-16 " +
        "Uhr' on a known day. If the text gives a time but no day, " +
        "anchor to today's date. If a single time point ('um 14 Uhr'), " +
        "set start === end. Omit when there's no time information.",
    ),
  expectedWindowEndAt: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "End of the expected-delivery window in Unix ms. Paired with " +
        "`expectedWindowStartAt` — both supplied together or both " +
        "omitted. Must be >= start.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Routing confidence. `high` ONLY when isFlow2 && absenceSignal " +
        "&& (carrier or window present). Anything else is medium or " +
        "low. The channel posts the card ONLY on `high`.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence explaining the classification. Logged on the " +
        "server; not shown to the user.",
    ),
});

export type ClassifyDmIntentResult = z.infer<typeof outputSchema>;

const classifierPrompt = [
  "You are a deterministic classifier for a German-speaking",
  "neighbor-coordination bot. A registered resident sends the bot a",
  "free-text DM. Decide whether the message is a Flow 2 inbound — the",
  "resident is pre-announcing a package they expect and won't be home",
  "to receive — and extract whatever supporting fields are present.",
  "",
  "Flow 2 examples (return isFlow2=true):",
  "  - 'Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause'",
  "  - 'Tomorrow I'll get a Hermes package but I'll be at work'",
  "  - 'Mañana espero un paquete de DHL pero no estaré en casa'",
  "  - 'Yarın bir DHL kargosu bekliyorum ama evde olmayacağım'",
  "  - 'Donnerstag kommt mein Paket, ich bin nicht da'",
  "",
  "NOT Flow 2 (return isFlow2=false):",
  "  - 'Wo ist mein Paket?' — Flow 3 search, not a pre-announce",
  "  - 'Habe ein Paket für Müller angenommen' — Flow 1, group label",
  "  - 'Ein Paket kommt heute' — pre-announce WITHOUT absence; Flow 0",
  "  - '/register <name>, <street> <number>' — registration",
  "  - 'Danke!' / 'Hallo' / 'Wie geht's?' — chit-chat",
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
  "Dates: resolve relative date words ('heute'/'today'/'hoy'/'bugün',",
  "'morgen'/'tomorrow'/'mañana'/'yarın', 'übermorgen'/'day after",
  "tomorrow'/'pasado mañana'/'öbür gün') against today's date in",
  "Europe/Berlin timezone. Return as 'YYYY-MM-DD'.",
  "",
  "Windows: when the user gives a time like '14-16 Uhr' / '2-4pm' /",
  "'de 14 a 16' / '14-16 arasında', resolve to Unix ms (Europe/Berlin)",
  "on the resolved date (or today if no date). For a single time point",
  "('um 14 Uhr'), set start === end.",
  "",
  "Confidence rules:",
  "  high   — isFlow2 AND absenceSignal AND (carrier OR window present)",
  "  medium — isFlow2 AND absenceSignal but no supporting field, OR",
  "           isFlow2 with absence implicit ('I'll be travelling next",
  "           week')",
  "  low    — isFlow2 uncertain (vague phrasing, missing absence),",
  "           non-Flow-2 inbounds (isFlow2: false → always low)",
  "",
  "Bias toward LOWER confidence when uncertain. A false positive posts",
  "to the group; a false negative just means the user re-asks.",
].join("\n");

interface ClassifierArgs {
  readonly text: string;
  readonly languageHint?: string;
}

async function runClassifierModel(
  model: string,
  args: ClassifierArgs,
): Promise<ClassifyDmIntentResult> {
  const today = new Date().toISOString().slice(0, 10);
  const userPrompt = [
    `Today's date (Europe/Berlin) is ${today}.`,
    args.languageHint
      ? `Telegram client language hint: ${args.languageHint}.`
      : "No language hint from the client.",
    "",
    "Inbound DM:",
    args.text,
  ].join("\n");

  const { object } = await generateObject({
    model,
    schema: outputSchema,
    system: classifierPrompt,
    prompt: userPrompt,
    providerOptions: {
      gateway: {
        sort: "cost",
      },
    },
  });
  return object;
}

export default defineTool({
  description:
    "Classify a free-text DM as Flow 2 (pre-announce 'I won't be home') " +
    "or not, extracting carrier / date / window when present. Tries " +
    "Gemini 2.5 Flash first, falls back to Claude Sonnet 4.6 if the " +
    "primary errors. Returns `{ isFlow2, absenceSignal, carrier?, " +
    "expectedDate?, expectedWindowStartAt?, expectedWindowEndAt?, " +
    "confidence, reason }`. The channel routes the card-posting " +
    "decision off `confidence === 'high'` — biased conservatively so " +
    "false positives (privacy-violating group posts) stay rare.",
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
