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
 * #79: invoked by the conversational agent itself as the first tool
 * call of every Flow 1 group-photo turn. The channel hands the agent a
 * `[photo received] file_url=<https-url> caption='…'` synthetic; the
 * agent reads `file_url` and passes it through here. Pre-#79 the
 * channel pre-called this tool and folded the structured result into a
 * `[label parsed] …` synthetic — that worked, but the vision call's
 * token spend was a sidecar and didn't show up on the Agent Runs row
 * for the turn. Moving the call site inside the turn (the model never
 * sees image bytes either way — it reads the tool's structured return)
 * fixes the attribution gap.
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
  imageUrl: z
    .string()
    .url()
    .describe(
      "HTTPS URL of the shipping-label photo. The channel resolves the " +
        "Telegram `file_id` to a signed proxy URL and hands it to the " +
        "agent inside the `[photo received] file_url=…` synthetic; the " +
        "agent passes that URL through verbatim. The Vercel AI Gateway " +
        "fetches the URL server-side and forwards the bytes to the " +
        "underlying vision model. Inline bytes (Uint8Array / base64) " +
        "are NOT supported here: the Gateway client converts them to a " +
        "`data:` URI which the Gateway server rejects with `Unsupported " +
        "file URI type`. URL string in, vision out.",
    ),
  caption: z
    .string()
    .optional()
    .describe(
      "Optional free-text caption the holder sent with the photo. " +
        "Useful for disambiguating multi-label photos (e.g. a caption " +
        "naming two recipients alongside two visible labels = two " +
        "packages). Pass through verbatim if present; otherwise omit.",
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
  readonly imageUrl: string;
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
          // URL form (string) — the Gateway server fetches it directly.
          // Inline bytes would be re-encoded to a `data:` URI by the
          // Gateway client and rejected server-side. `mediaType: 'image'`
          // (top-level IANA segment) matches the AI SDK 7 docs example
          // and lets each provider sniff its own subtype from the
          // fetched bytes.
          { type: "file", data: args.imageUrl, mediaType: "image" },
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
    "reason }`. The conversational agent invokes this as the first " +
    "tool call of every Flow 1 group-photo turn; the model never sees " +
    "image bytes, only the structured return value.",
  inputSchema,
  async execute({ imageUrl, caption }) {
    const args: VisionArgs = { imageUrl, caption };

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
