/**
 * `classify_group_message` — deterministic classifier for group text
 * inbounds the channel layer must route to Flow 1 (someone announces
 * they accepted a package on behalf of a neighbour).
 *
 * v2.1 #106 Slice 1: the v2.1 architecture pulled Flow 2 routing out
 * of the model (see `classify_dm_intent.ts` / Slice 1 / #86). Flow 1
 * inbounds remained agent-driven until the live trace 2026-05-22
 * showed a single group photo producing 20+ free-form German
 * messages — references to deleted tools, v1 form-fill prose, and
 * the "Abgehott" typo. The structural fix mirrors Flow 2's: route
 * the registration decision via this classifier BEFORE the agent
 * runs, and on a high-confidence verdict the channel calls
 * `lib/package.ts::registerPackage` directly + posts the
 * deterministic group ack + recipient DM via
 * `lib/telegram-channel/flow-1-dms.ts`.
 *
 * Same fallback chain as `classify_dm_intent`:
 *
 *   primary:  google/gemini-2.5-flash — cheap, multilingual NLU
 *   fallback: anthropic/claude-sonnet-4.6 — stronger reasoning, fewer
 *                                           false positives on idioms
 *
 * **Confidence rules (PRD-derived, false-positive cost > false-negative)**:
 *
 *   `confidence: "high"` ONLY when
 *     (a) `isPackageRegistration` is true AND
 *     (b) at least one named recipient is present AND
 *     (c) the message phrasing is unambiguous about a package being
 *         received for someone else (not a question, not a search).
 *
 *   Anything else is `"medium"` or `"low"`. The channel registers the
 *   package ONLY on `confidence: "high"` AND a registered-resident
 *   recipient match; lower confidence / unknown recipients fall
 *   through to Slice 3 (#109) disambiguation (a clarification
 *   synthetic handed to the agent for ONE short question).
 *
 *   This conservative bias is deliberate: a false positive writes a
 *   Package record + posts to the group + DMs the wrong person; a
 *   false negative just means the holder gets nothing back and can
 *   restate.
 *
 * @see lib/telegram-channel/process-update.ts — channel-side call site
 * @see lib/package.ts                          — registerPackage core
 */

import { defineTool } from "experimental-ash/tools";
import { generateObject } from "ai";
import { z } from "zod";

import { packageCarrierSchema, type PackageCarrier } from "../../lib/redis.js";
import { repairFencedJson } from "../../lib/structured-output.js";

export const PRIMARY_MODEL = "google/gemini-2.5-flash";
export const FALLBACK_MODEL = "anthropic/claude-sonnet-4.6";

const inputSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "The full inbound group message text in its original language. The " +
        "channel passes this through verbatim — no preprocessing.",
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

const recipientSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Recipient name exactly as the holder wrote it in the message — " +
        "family name alone, or full given + family name. Do NOT add " +
        "honorifics or expand abbreviations.",
    ),
  houseNumber: z
    .string()
    .optional()
    .describe(
      "Recipient's house number if the message states one. Omit when " +
        "absent — the channel will default to the holder's own house " +
        "number, which is the overwhelmingly common case.",
    ),
});

const modelOutputSchema = z.object({
  isPackageRegistration: z
    .boolean()
    .describe(
      "True iff the message announces that the holder has just received " +
        "(or is about to receive on someone else's behalf) a package for " +
        "a NEIGHBOUR. False for off-topic chat, questions about a " +
        "package (Flow 3 search), pickup confirmations (Flow 1 close), " +
        "or a resident's own pre-announcement (Flow 2 — but Flow 2 " +
        "never happens in groups). When in doubt, set false — the holder " +
        "can restate.",
    ),
  recipients: z
    .array(recipientSchema)
    .describe(
      "One entry per named recipient. 'Pakete für A und B' → two " +
        "entries. 'Paket für Müller' → one entry with name='Müller'. " +
        "Empty array when isPackageRegistration is true but no " +
        "recipient was named — the classifier returns medium/low " +
        "confidence in that case so the channel can fall through.",
    ),
  carrier: packageCarrierSchema
    .optional()
    .describe(
      "Carrier if mentioned (DHL, Hermes, DPD, GLS, UPS, Amazon, " +
        "unknown). Omit when the holder didn't name one.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Routing confidence. `high` ONLY when isPackageRegistration && " +
        "recipients.length >= 1 && the phrasing is unambiguous. " +
        "Anything else is medium or low. The channel registers the " +
        "package ONLY on `high` AND a registered-resident recipient " +
        "match.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence explaining the classification. Logged on " +
        "the server; not shown to the user.",
    ),
});

export interface ClassifyGroupMessageRecipient {
  readonly name: string;
  readonly houseNumber?: string;
}

export interface ClassifyGroupMessageResult {
  readonly isPackageRegistration: boolean;
  readonly recipients: ReadonlyArray<ClassifyGroupMessageRecipient>;
  readonly carrier?: PackageCarrier;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

export const groupClassifierSystemPrompt = [
  "You are a deterministic classifier for a German-speaking",
  "neighbor-coordination bot. A registered resident has posted in the",
  "street group chat. Decide whether the message announces that the",
  "writer has received (or is about to receive on someone's behalf) a",
  "package addressed to ANOTHER neighbour — and extract whatever",
  "supporting fields are present.",
  "",
  "Flow 1 examples (return isPackageRegistration=true):",
  "  - 'Paket für Müller' — short form, family name only",
  "  - 'Habe ein Päckchen für <name> angenommen' — explicit",
  "  - 'Pakete für Anna und Beate' — two recipients = two entries",
  "  - 'DHL für Schmidt aus Nr. 88' — carrier + house number visible",
  "  - 'Paket für Familie Yılmaz' — family-name form",
  "",
  "NOT Flow 1 (return isPackageRegistration=false):",
  "  - 'Hat jemand mein Paket?' — Flow 3 search, not a registration",
  "  - 'Wo ist mein Zalando?' — Flow 3 search by the addressee",
  "  - 'Wer hat Lust auf Pizza?' — off-topic chat",
  "  - '<name> bringt morgen Kuchen mit' — social, no package",
  "  - 'Ich erwarte morgen DHL' — Flow 2 (pre-announce), and Flow 2",
  "    is DM-only — group Flow 2 is not a thing in v2.1",
  "  - 'Abgeholt, danke!' / 'Hab abgeholt' — pickup confirmation, not",
  "    a registration. Different flow.",
  "  - 'Paket für mich angekommen' — the writer is the recipient, no",
  "    handoff needed",
  "",
  "Recipient extraction:",
  "  - Single recipient: 'Paket für <name>' → recipients=[{name:<name>}]",
  "  - Multiple: 'Pakete für <a> und <b>' → two entries",
  "  - House number when stated: 'für Müller (Hs.<n>)' →",
  "    recipients=[{name:'Müller', houseNumber:'<n>'}]. Strip the 'Hs.'",
  "    prefix.",
  "  - Family form: 'für Familie Yılmaz' → name='Familie Yılmaz' is",
  "    fine — the channel will name-match either way",
  "",
  "Carriers to recognise (otherwise omit):",
  "  DHL, Hermes, DPD, GLS, UPS, Amazon. FedEx → 'unknown'.",
  "",
  "===== Confidence =====",
  "",
  "  high   — isPackageRegistration AND recipients.length >= 1 AND",
  "           unambiguous phrasing",
  "  medium — isPackageRegistration plausible but recipient name is",
  "           hedged ('vielleicht für Anna?'), or no recipient was",
  "           named ('Paket angekommen, wisst ihr wem?'), or carrier",
  "           is inferred from context rather than stated",
  "  low    — borderline cases (could be social chat referencing a",
  "           package, could be Flow 3, could be Flow 1)",
  "",
  "Bias toward LOWER confidence when uncertain. A false positive",
  "writes a Package record + DMs the wrong neighbour; a false negative",
  "just means the holder restates with a clearer phrasing.",
].join("\n");

interface ClassifierArgs {
  readonly text: string;
  readonly languageHint?: string;
}

async function runClassifierModel(
  model: string,
  args: ClassifierArgs,
): Promise<ClassifyGroupMessageResult> {
  const userPrompt = args.languageHint
    ? [
        `Telegram client language hint: ${args.languageHint}.`,
        "",
        "Inbound group message:",
        args.text,
      ].join("\n")
    : [
        "No language hint from the client.",
        "",
        "Inbound group message:",
        args.text,
      ].join("\n");

  const { object } = await generateObject({
    model,
    schema: modelOutputSchema,
    system: groupClassifierSystemPrompt,
    prompt: userPrompt,
    experimental_repairText: repairFencedJson,
    providerOptions: {
      gateway: {
        sort: "cost",
      },
    },
  });

  return {
    isPackageRegistration: object.isPackageRegistration,
    recipients: object.recipients,
    carrier: object.carrier,
    confidence: object.confidence,
    reason: object.reason,
  };
}

export default defineTool({
  description:
    "Classify a group text message as a Flow 1 package registration " +
    "or not, extracting recipient names / house numbers / carrier " +
    "when present. Tries Gemini 2.5 Flash first, falls back to " +
    "Claude Sonnet 4.6 if the primary errors. Returns " +
    "`{ isPackageRegistration, recipients: [{ name, houseNumber? }], " +
    "carrier?, confidence, reason }`. The channel registers the " +
    "package ONLY on `confidence === 'high'` AND a registered " +
    "recipient match — biased conservatively so false positives " +
    "(wrong-neighbour DMs, group cards posted on social chat) stay " +
    "rare.",
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
