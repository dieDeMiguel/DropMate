/**
 * `parse_tracking_page` — sibling vision tool to `parse_label`, but for
 * carrier tracking-page screenshots in DM.
 *
 * Same architecture as `parse_label`:
 *
 *   primary:  google/gemini-3.1-flash-lite — cheap, native vision
 *   fallback: anthropic/claude-sonnet-4.6  — stronger OCR + multilingual
 *
 * Different prompt and output schema: a tracking page (the screen the
 * carrier's "where's my package?" link lands on) carries the carrier
 * name, tracking number, and an estimated delivery window. There is no
 * recipient name on it — the addressee is the requester themself, and
 * the page is consumed in DM not in the group.
 *
 * Wiring (see `lib/telegram-channel/process-update.ts`):
 *
 *   - Group photo → `parse_label` (Flow 1; the holder is showing a
 *     shipping label they received on someone else's package).
 *   - DM photo   → `parse_tracking_page` (Flow 2 v2; the requester is
 *     pre-announcing a package they expect by uploading the carrier's
 *     tracking page).
 *
 * The orchestrator emits a synthetic text message the conversational
 * agent reads as if the user typed it:
 *
 *     [tracking page parsed] carrier=DHL trackingNumber=…
 *     windowStart=2026-05-19T13:00:00Z windowEnd=2026-05-19T16:00:00Z
 *     confidence=high caption='kann jemand annehmen?'
 *
 * The agent then runs Flow 2 v2 (`create_reception_request`) with no
 * follow-up question to the requester — the screenshot itself is the
 * absence signal (you don't upload a tracking page in DM unless you
 * want help). When `confidence === "low"`, the orchestrator appends a
 * "please confirm with the requester before posting" suffix so the
 * agent asks rather than auto-posting the card.
 *
 * Inputs:
 *   - `imageUrl`: HTTPS URL, NOT inline bytes — the Vercel AI Gateway
 *     server fetches the URL itself; passing bytes is converted to a
 *     `data:` URI that the Gateway server rejects with "Unsupported
 *     file URI type". See `parse_label.ts` for the full rationale.
 *   - `caption`: optional free-text the requester sent alongside the
 *     screenshot. Useful for tie-breaking absence intent ("kann jemand
 *     annehmen?" = explicit ask; "hat schon jemand mein Paket?" =
 *     search intent, not Flow 2 v2).
 *
 * Output is a strict zod schema so the model can't return free-form
 * prose. Optional fields stay optional — if the screenshot has no
 * tracking number visible (some carriers hide it behind a click) the
 * tool omits it rather than guesses.
 *
 * Times are returned as ISO 8601 datetimes; the conversational agent
 * converts to Unix ms via `Date.parse()` before passing to
 * `create_reception_request`'s `expectedWindowStartAt` /
 * `expectedWindowEndAt` inputs (per Flow 2 v2 instructions).
 */

import { defineTool } from "experimental-ash/tools";
import { generateObject } from "ai";
import { z } from "zod";

import { packageCarrierSchema } from "../../lib/redis.js";

export const PRIMARY_MODEL = "google/gemini-3.1-flash-lite";
export const FALLBACK_MODEL = "anthropic/claude-sonnet-4.6";

const inputSchema = z.object({
  imageUrl: z
    .string()
    .url()
    .describe(
      "HTTPS URL of the tracking-page screenshot. The orchestrator " +
        "resolves the Telegram `file_id` via `getTelegramFileUrl` (Bot " +
        "API getFile + CDN base) and passes the resulting URL through. " +
        "The Vercel AI Gateway fetches the URL server-side and forwards " +
        "the bytes to the underlying vision model. Inline bytes are NOT " +
        "supported (the Gateway client converts them to a `data:` URI " +
        "the Gateway server rejects). URL string in, structured fields " +
        "out.",
    ),
  caption: z
    .string()
    .optional()
    .describe(
      "Optional free-text caption the requester sent with the " +
        "screenshot. Useful for disambiguating intent (an absence " +
        "signal in the caption confirms Flow 2 v2; a search-intent " +
        "caption like 'wo ist mein Paket?' is something else). Pass " +
        "through verbatim if present; otherwise omit.",
    ),
});

const outputSchema = z.object({
  carrier: packageCarrierSchema.describe(
    "Carrier the tracking page belongs to (DHL, Hermes, DPD, GLS, " +
      "UPS, Amazon, or 'unknown'). Read this from the page header / " +
      "logo / brand colours. Use 'unknown' if no carrier branding is " +
      "legible.",
  ),
  trackingNumber: z
    .string()
    .optional()
    .describe(
      "Tracking / sendungsnummer printed on the page, if visible. " +
        "Most carriers display it prominently near the top. Omit when " +
        "absent or unreadable.",
    ),
  expectedWindowStartAt: z
    .string()
    .datetime()
    .optional()
    .describe(
      "Start of the estimated delivery window as an ISO 8601 datetime " +
        "string (e.g. '2026-05-19T13:00:00Z'). If the page shows a " +
        "single time point ('14:00'), set this to that point. If the " +
        "page shows only a date with no time, omit BOTH this and the " +
        "end field. The conversational agent converts ISO → Unix ms " +
        "before passing to `create_reception_request`.",
    ),
  expectedWindowEndAt: z
    .string()
    .datetime()
    .optional()
    .describe(
      "End of the estimated delivery window as an ISO 8601 datetime " +
        "string. If the page shows a single time point, set this to " +
        "the same value as the start. Must be supplied paired with " +
        "the start (or both omitted).",
    ),
  absenceSignal: z
    .boolean()
    .optional()
    .describe(
      "Whether the caption (if any) explicitly says the requester " +
        "won't be home. German: 'nicht zu Hause', 'nicht da', 'im " +
        "Büro'. English: 'won't be in', 'not home', 'out'. Equivalents " +
        "in any language. Omit when the caption was empty or carries " +
        "no clear absence signal — the orchestrator treats an absent " +
        "field as 'true' because uploading a tracking page in DM is " +
        "itself an implicit absence signal.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Overall extraction confidence. 'low' when the page is blurry, " +
        "partially obscured, the carrier is uncertain, or the window " +
        "is implied rather than printed — the agent will confirm with " +
        "the requester before posting the group card.",
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
  "neighbor-coordination bot in Germany. The page is the 'where is my",
  "package?' view a courier provides via SMS/email link. Extract the",
  "structured fields below from what is visible. Be honest about",
  "confidence: if a field is blurry, partially obscured, or you are",
  "guessing — say so via the `confidence` enum and omit the uncertain",
  "field rather than invent a plausible value.",
  "",
  "Carriers to recognise (logo / brand colours / page layout):",
  "  DHL    — yellow + red, post horn logo",
  "  Hermes — orange, 'h' wordmark",
  "  DPD    — red + grey, 'DPD' wordmark",
  "  GLS    — yellow + blue, 'GLS' wordmark",
  "  UPS    — brown, shield logo",
  "  Amazon — black + orange smile, 'amazon' wordmark",
  "  unknown — any other carrier (e.g. FedEx, Hellofresh, Picnic),",
  "             or no visible carrier branding",
  "",
  "Tracking number: the alphanumeric package id printed on the page,",
  "often near 'Sendungsnummer' / 'Tracking number' / 'Tracking-ID'.",
  "",
  "Delivery window: many tracking pages show an estimated arrival",
  "window ('Lieferung heute 13:00–16:00' / 'arriving today between",
  "2pm and 5pm'). Return both endpoints as ISO 8601 datetime strings",
  "in the page's local timezone. If the page shows only a date with",
  "no time, omit both endpoints. If the page shows a single time",
  "point ('um 14:00'), set both endpoints to that point.",
  "",
  "Ignore: navigation chrome, the recipient address (privacy),",
  "promotional banners, and 'related products' carousels. Only read",
  "the carrier name, tracking number, and delivery window.",
  "",
  "Caption: also read the user's caption (if provided) for an explicit",
  "absence signal ('I won't be home', 'bin nicht da', etc.). If the",
  "caption clearly states the user won't be home, set `absenceSignal`",
  "to true. If the caption is empty or carries no clear signal, omit",
  "the field — the orchestrator treats absence as implicit on the DM",
  "screenshot path.",
  "",
  "Confidence levels:",
  "  high   — all fields you returned are clearly legible",
  "  medium — at least one field is partially obscured but readable",
  "  low    — carrier uncertain, window guessed, or page heavily damaged",
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
    "Extract carrier, tracking number, and estimated delivery window " +
    "from a carrier tracking-page screenshot (the 'where is my " +
    "package?' page the requester sees after clicking the SMS/email " +
    "link). Tries Gemini 3.1 Flash Lite (vision) first, then falls " +
    "back to Claude Sonnet 4.6 if the primary errors. Routes via " +
    "Vercel AI Gateway. Returns `{ carrier, trackingNumber?, " +
    "expectedWindowStartAt?, expectedWindowEndAt?, absenceSignal?, " +
    "confidence, reason }` with window endpoints as ISO 8601 " +
    "datetimes. The orchestrator calls this on every inbound DM photo " +
    "before the agent runs; the conversational model only ever sees " +
    "the parsed text form.",
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
