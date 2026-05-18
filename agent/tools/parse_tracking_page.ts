/**
 * `parse_tracking_page` — dedicated vision tool that turns a carrier
 * tracking-page screenshot (DHL / UPS / FedEx / GLS / DPD / Hermes /
 * Amazon) into structured reception-request fields.
 *
 * Sibling of `parse_label.ts`. The two tools split the photo path by
 * Flow:
 *
 *   Flow 1 (group, label scan)         → `parse_label`
 *   Flow 2 (DM, reception request)     → this tool
 *
 * The orchestrator (`lib/telegram-channel/process-update.ts`) picks
 * which parser fires based on `isGroup`: DMs default to the
 * tracking-page parser, groups default to the label parser. Both
 * surface their result as a synthetic text message so the
 * conversational model never holds an inline `FilePart` itself —
 * mirrors Flow 1's shape exactly.
 *
 * Routes through Vercel AI Gateway with the same model-level fallback
 * chain as `parse_label`:
 *
 *   primary:  google/gemini-3.1-flash-lite — cheap, vision-native
 *   fallback: anthropic/claude-sonnet-4.6  — stronger OCR, multilingual
 *
 * URL form, not bytes: inline `Uint8Array` / base64 gets serialised by
 * the Gateway client to a `data:` URI which the Gateway server rejects
 * with `Unsupported file URI type`. The orchestrator resolves the
 * Telegram `file_id` through the existing `file-proxy.ts` and passes
 * the resulting HTTPS URL through.
 *
 * Output schema:
 *
 *   - `carrier`               — one of the seven supported carriers, or
 *                               "unknown" when no branding is legible.
 *   - `trackingNumber`        — when printed on the page.
 *   - `expectedWindowStartAt` — ISO datetime (UTC). When the page shows
 *     `expectedWindowEndAt`     a single-point ETA ('14:00'), both
 *                               endpoints collapse to that value.
 *   - `confidence`            — high / medium / low.
 *   - `reason`                — one short sentence for logs.
 *
 * Low-confidence parses surface explicitly. The agent's Flow 2
 * instructions tell it to confirm with the requester before posting
 * the group card rather than auto-creating a request on a guess.
 *
 * @see agent/tools/parse_label.ts — sibling for the Flow 1 path
 * @see lib/telegram-channel/process-update.ts — routing logic
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
      "HTTPS URL of the tracking-page screenshot. The orchestrator " +
        "resolves the Telegram `file_id` via the file-proxy route and " +
        "passes the resulting URL through. The Vercel AI Gateway " +
        "fetches the URL server-side and forwards the bytes to the " +
        "underlying vision model. Inline bytes are NOT supported — see " +
        "the parse_label module header for the full rationale.",
    ),
  caption: z
    .string()
    .optional()
    .describe(
      "Optional free-text caption the requester sent with the " +
        "screenshot. Useful when the page is in a language the parser " +
        "doesn't recognise and the caption restates the ETA. Pass " +
        "through verbatim if present; otherwise omit.",
    ),
});

const outputSchema = z.object({
  carrier: z
    .enum(["DHL", "Hermes", "DPD", "GLS", "UPS", "FedEx", "Amazon", "unknown"])
    .describe(
      "Carrier branding visible on the page. 'unknown' when no " +
        "carrier logo or wordmark is legible.",
    ),
  trackingNumber: z
    .string()
    .optional()
    .describe(
      "Tracking / sendungsnummer printed on the page, if legible. " +
        "Omit when absent or unreadable.",
    ),
  expectedWindowStartAt: z
    .string()
    .datetime()
    .optional()
    .describe(
      "ETA window start as an ISO 8601 datetime (UTC). For a " +
        "single-point ETA ('14:00'), set both `expectedWindowStartAt` " +
        "and `expectedWindowEndAt` to the same value. Omit when the " +
        "page shows only a day with no time.",
    ),
  expectedWindowEndAt: z
    .string()
    .datetime()
    .optional()
    .describe(
      "ETA window end as an ISO 8601 datetime (UTC). Must come " +
        "alongside `expectedWindowStartAt`; the downstream " +
        "`create_reception_request` tool rejects half-windows.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Overall extraction confidence. 'low' when the page is blurry, " +
        "the carrier branding is uncertain, or the ETA reads " +
        "ambiguously — the agent will confirm with the requester " +
        "before posting the group card.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence explaining the extraction — used for logs " +
        "and so the conversational model can reason about edge cases.",
    ),
});

export type ParseTrackingPageResult = z.infer<typeof outputSchema>;

const visionPrompt = [
  "You are reading a carrier tracking-page screenshot for a",
  "neighbor-coordination bot in Germany. The page is shown to the bot",
  "by the recipient — extract the carrier, tracking number, and the",
  "estimated delivery window. Be honest about confidence: if a field is",
  "blurry, partially obscured, or you're guessing — say so via the",
  "`confidence` enum and omit the uncertain field rather than invent",
  "a plausible value.",
  "",
  "Carriers to recognise (logo, brand colours, page layout):",
  "  DHL    — yellow + red, post horn logo, 'deutschepost' fineprint",
  "  Hermes — orange, 'h' wordmark",
  "  DPD    — red + grey, 'DPD' wordmark",
  "  GLS    — yellow + blue, 'GLS' wordmark",
  "  UPS    — brown, shield logo",
  "  FedEx  — purple + orange wordmark",
  "  Amazon — black + orange smile, 'amazon' wordmark",
  "  unknown — anything else, or no visible branding",
  "",
  "Tracking number: the carrier's primary reference printed on the",
  "page. Often labelled 'Sendungsnummer', 'Tracking number', 'Auftrag',",
  "etc. Omit if not visible.",
  "",
  "Expected delivery window: the ETA the page shows. The window may be",
  "a single point ('Lieferung gegen 14:00') — in that case set both",
  "`expectedWindowStartAt` and `expectedWindowEndAt` to the same",
  "datetime. Pages often show a date plus a time range ('Mo 19. Mai,",
  "12:00 – 16:00') — convert to UTC ISO 8601. Use the year visible on",
  "the page, or the current year if the page shows only month+day.",
  "Omit both fields entirely when the page shows only a day with no",
  "time of day. Ignore navigation chrome, the recipient address",
  "(privacy), and promotional banners.",
  "",
  "Confidence levels:",
  "  high   — carrier, tracking number, and ETA window all clearly legible",
  "  medium — at least one field is partially obscured but readable",
  "  low    — ETA ambiguous, or the page layout is unfamiliar",
].join("\n");

interface VisionArgs {
  readonly imageUrl: string;
  readonly caption: string | undefined;
}

async function runVisionModel(
  model: string,
  args: VisionArgs,
): Promise<ParseTrackingPageResult> {
  const userPrompt =
    args.caption && args.caption.length > 0
      ? `Requester's caption: "${args.caption}". Read the tracking page and return the structured fields.`
      : "Read the tracking page and return the structured fields.";

  const { object } = await generateObject({
    model,
    schema: outputSchema,
    system: visionPrompt,
    messages: [
      {
        role: "user",
        content: [
          // URL form (string) — the Gateway server fetches it directly.
          // See the parse_label module header for the inline-bytes
          // rejection rationale.
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
    "Extract carrier, tracking number, and the expected delivery " +
    "window from a carrier tracking-page screenshot. Tries Gemini 3.1 " +
    "Flash Lite (vision) first, then falls back to Claude Sonnet 4.6 " +
    "if the primary errors. Routes via Vercel AI Gateway. Returns " +
    "`{ carrier, trackingNumber?, expectedWindowStartAt?, " +
    "expectedWindowEndAt?, confidence, reason }`. The orchestrator " +
    "calls this on every inbound DM photo before the agent runs (the " +
    "label parser handles the group path); the conversational model " +
    "only ever sees the parsed text form.",
  inputSchema,
  async execute({ imageUrl, caption }) {
    const args: VisionArgs = { imageUrl, caption };

    try {
      return await runVisionModel(PRIMARY_MODEL, args);
    } catch (primaryError) {
      try {
        return await runVisionModel(FALLBACK_MODEL, args);
      } catch {
        throw primaryError;
      }
    }
  },
});
