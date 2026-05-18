/**
 * `parse_label` — dedicated vision tool that turns a shipping-label
 * photo (bytes + mediaType) into structured package data.
 *
 * Routes through Vercel AI Gateway with an explicit model-level
 * fallback chain:
 *
 *   primary:  google/gemini-3.1-flash-lite — cheap, native vision
 *   fallback: anthropic/claude-sonnet-4.6  — stronger OCR + multilingual
 *
 * Earlier iterations of this tool used `google/gemma-4-31b-it` →
 * `anthropic/claude-opus-4.5`. Gemma 4 is text-only on the gateway
 * (Gemma open-weight models don't include vision in the IT variants);
 * passing a `FilePart` to it threw at the provider boundary and the
 * fallback to Opus 4.5 (now superseded) didn't reliably rescue the
 * call. Gemini 3.1 Flash Lite is the cheapest current vision-native
 * Gemini and Sonnet 4.6 is the current Anthropic price/perf sweet
 * spot for OCR.
 *
 * Model-level fallback (try primary → on error, try fallback) is
 * implemented here rather than via the Gateway's `order` provider
 * option because `order` routes between providers for the SAME model,
 * not between different models. We want to try a cheap model first
 * and fall back to a more capable one if it errors — a different
 * shape of resilience.
 *
 * The primary handles >90% of straightforward Latin-script shipping
 * labels at a fraction of the cost; the fallback only fires if the
 * primary errors. The conversational agent stays on Gemini Flash
 * (see `agent/agent.ts`) — only the photo turn pays the vision cost,
 * and only via this tool.
 *
 * The orchestrator (`lib/telegram-channel/process-update.ts`) calls
 * `parse_label` BEFORE handing the turn to the conversational agent
 * when an inbound update contains a photo. The result is folded back
 * into a synthetic text message ("[label parsed] carrier=DHL …") so
 * the rest of Flow 1 (`register_package`, `notify_recipient`,
 * `post_to_group`) runs unchanged on a text-only model surface.
 *
 * Low-confidence parses surface explicitly (`confidence: "low"`) so
 * the agent knows to ask for confirmation before registering rather
 * than auto-creating a Package on a guess.
 */

import { defineTool } from "experimental-ash/tools";
import { generateObject } from "ai";
import { z } from "zod";

export const PRIMARY_MODEL = "google/gemini-3.1-flash-lite";
export const FALLBACK_MODEL = "anthropic/claude-sonnet-4.6";

const inputSchema = z.object({
  imageBase64: z
    .string()
    .min(1)
    .describe(
      "Base64-encoded image bytes of the shipping label photo. The " +
        "orchestrator encodes the bytes returned by `fetchTelegramFile` " +
        "before calling this tool.",
    ),
  mediaType: z
    .string()
    .min(1)
    .describe(
      "MIME type of the image, e.g. 'image/jpeg' or 'image/png'. From " +
        "the Bot API `getFile` response.",
    ),
  caption: z
    .string()
    .optional()
    .describe(
      "Optional free-text caption the holder sent with the photo. " +
        "Useful for disambiguating multi-label photos ('für Ritter und " +
        "Meyer' + two visible labels = two packages). Pass through " +
        "verbatim if present; otherwise omit.",
    ),
});

const outputSchema = z.object({
  carrier: z
    .enum(["DHL", "Hermes", "DPD", "GLS", "UPS", "Amazon", "unknown"])
    .describe(
      "Carrier visible on the label. 'unknown' when no carrier branding " +
        "is legible.",
    ),
  trackingNumber: z
    .string()
    .optional()
    .describe(
      "Tracking / sendungsnummer printed on the label, if legible. " +
        "Omit when absent or unreadable.",
    ),
  recipientName: z
    .string()
    .optional()
    .describe(
      "Recipient name read off the label. Omit if illegible — the " +
        "agent will ask one clarifying question rather than register a " +
        "guess.",
    ),
  recipientHouseNumber: z
    .string()
    .optional()
    .describe(
      "House number from the recipient address block on the label, if " +
        "visible. Omit if absent or unreadable.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Overall extraction confidence. 'low' when the label is blurry, " +
        "partially obscured, or the recipient name is uncertain — the " +
        "agent will confirm with the holder before registering.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence explaining the extraction — used for logs " +
        "and so the conversational model can reason about edge cases.",
    ),
});

export type ParseLabelResult = z.infer<typeof outputSchema>;

const visionPrompt = [
  "You are reading a shipping-label photo for a neighbor-coordination",
  "bot in Germany. Extract the structured fields below from what is",
  "visible on the label. Be honest about confidence: if a field is",
  "blurry, partially obscured, or you're guessing — say so via the",
  "`confidence` enum and omit the uncertain field rather than invent",
  "a plausible value.",
  "",
  "Carriers to recognise (logo, brand colours, label layout):",
  "  DHL    — yellow + red, post horn logo",
  "  Hermes — orange, 'h' wordmark",
  "  DPD    — red + grey, 'DPD' wordmark",
  "  GLS    — yellow + blue, 'GLS' wordmark",
  "  UPS    — brown, shield logo",
  "  Amazon — black + orange smile, 'amazon' wordmark",
  "  unknown — anything else, or no visible branding",
  "",
  "Recipient name: the addressee printed on the label, NOT the sender.",
  "Omit it if the name is illegible or you're uncertain who it refers",
  "to.",
  "",
  "House number: the number from the recipient's street address on the",
  "label. Strip street name and city — return just the number (and any",
  "letter suffix like '12a').",
  "",
  "Confidence levels:",
  "  high   — all fields you returned are clearly legible",
  "  medium — at least one field is partially obscured but readable",
  "  low    — recipient name uncertain, or label heavily damaged",
].join("\n");

interface VisionArgs {
  readonly imageBytes: Uint8Array;
  readonly mediaType: string;
  readonly caption: string | undefined;
}

async function runVisionModel(
  model: string,
  args: VisionArgs,
): Promise<ParseLabelResult> {
  const userPrompt =
    args.caption && args.caption.length > 0
      ? `Holder's caption: "${args.caption}". Read the label and return the structured fields.`
      : "Read the label and return the structured fields.";

  const { object } = await generateObject({
    model,
    schema: outputSchema,
    system: visionPrompt,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: args.imageBytes, mediaType: args.mediaType },
          { type: "text", text: userPrompt },
        ],
      },
    ],
  });
  return object;
}

export default defineTool({
  description:
    "Extract carrier, tracking number, recipient name, and recipient " +
    "house number from a shipping-label photo. Tries Gemini 3.1 Flash " +
    "Lite (vision) first, then falls back to Claude Sonnet 4.6 if the " +
    "primary errors. Routes via Vercel AI Gateway. Returns `{ carrier, " +
    "trackingNumber?, recipientName?, recipientHouseNumber?, confidence, " +
    "reason }`. The orchestrator calls this on every inbound photo " +
    "before the agent runs; the conversational model only ever sees " +
    "the parsed text form.",
  inputSchema,
  async execute({ imageBase64, mediaType, caption }) {
    const imageBytes = Uint8Array.from(Buffer.from(imageBase64, "base64"));
    const args: VisionArgs = { imageBytes, mediaType, caption };

    try {
      return await runVisionModel(PRIMARY_MODEL, args);
    } catch (primaryError) {
      // Primary failed (auth, timeout, model-not-found, content-too-large,
      // …). Try the fallback. If the fallback ALSO fails, surface the
      // primary's error — that's the more diagnostic signal for ops.
      try {
        return await runVisionModel(FALLBACK_MODEL, args);
      } catch {
        throw primaryError;
      }
    }
  },
});
