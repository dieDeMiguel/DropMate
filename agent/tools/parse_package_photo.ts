/**
 * `parse_package_photo` — unified vision tool that supersedes both
 * `parse_label` (group/Flow 1) and `parse_tracking_page` (DM/Flow 2).
 *
 * v2.1 #128: the pre-split design had two tools and the orchestration
 * layer decided which to call by chat type (group → label, DM → tracking
 * page). That hardcoded DM photo to Flow 2 even when the user sent a
 * shipping label (the privacy-correct Flow 1 entry surface), and it
 * required an `absenceSignal === undefined → Flow 2` heuristic the
 * channel had to reason about. Both went away when we pushed the
 * discriminator into the model itself: one LLM call, one structured
 * output, the channel branches on `kind`.
 *
 * Output is a Zod discriminated union on the literal `kind`:
 *
 *   - `kind: "shipping_label"`  — the photo shows a physical shipping
 *     label (or label sticker). The bot routes this to Flow 1
 *     (register the package on behalf of someone). Carries
 *     `carrier` + `recipientName` + `recipientHouseNumber` (the latter
 *     two omitted only when the model is uncertain).
 *   - `kind: "tracking_page"`   — the photo shows a carrier's tracking
 *     page screenshot ("where's my package?" view). The bot routes this
 *     to Flow 2 (pre-announce a package the requester is expecting).
 *     Carries `carrier` + `trackingNumber?` + optional window endpoints.
 *   - `kind: "unknown"`         — the photo can't be classified
 *     confidently. The bot sends the 3-path recovery DM.
 *
 * Single Vercel AI Gateway call with the same primary/fallback chain as
 * the pre-#128 split:
 *
 *   primary:  google/gemini-3.1-flash-lite — cheap, native vision
 *   fallback: anthropic/claude-sonnet-4.6  — stronger OCR + multilingual
 *
 * Model-level fallback (try primary → on error, try fallback) is
 * implemented here rather than via the Gateway's `order` provider
 * option because `order` routes between providers for the SAME model.
 * We want to try a cheap model first and fall back to a more capable
 * one if it errors — a different shape of resilience.
 *
 * Wiring: the channel layer invokes this on every inbound photo update
 * (`lib/telegram-channel/process-update.ts::routeDmPhoto` for DM photos,
 * `routeGroupPhoto` for group photos). The agent is never in the photo
 * loop on either surface; per v2.1 #128 the routing decision lives in
 * the channel based on `kind`.
 *
 * Privacy invariant (the reason #128 exists): a shipping label carries
 * PII (recipient name + house number). The DM photo path is the only
 * privacy-correct surface for registering one — group photo of a label
 * leaks PII to every neighbor in the chat. Routing on `kind` lets us
 * nudge group senders privately ("send labels to me directly") while
 * letting DM senders register via Flow 1.
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
      "HTTPS URL of the package photo. The channel resolves the " +
        "Telegram `file_id` to a signed proxy URL and passes it in " +
        "directly. The Vercel AI Gateway fetches the URL server-side " +
        "and forwards the bytes to the underlying vision model. Inline " +
        "bytes (Uint8Array / base64) are NOT supported here: the " +
        "Gateway client converts them to a `data:` URI which the " +
        "Gateway server rejects with `Unsupported file URI type`.",
    ),
  caption: z
    .string()
    .optional()
    .describe(
      "Optional free-text caption the sender attached. Useful for " +
        "tie-breaking when the photo is ambiguous (e.g. caption names " +
        "the recipient that the label has not yet been read for, or " +
        "the caption confirms 'I'm not home' for a tracking-page " +
        "screenshot). Pass through verbatim if present; otherwise omit.",
    ),
});

const shippingLabelSchema = z.object({
  kind: z.literal("shipping_label"),
  carrier: packageCarrierSchema.describe(
    "Carrier visible on the label (DHL, Hermes, DPD, GLS, UPS, " +
      "Amazon, or 'unknown' when no carrier branding is legible).",
  ),
  recipientName: z
    .string()
    .optional()
    .describe(
      "Recipient name printed on the label. The addressee, NOT the " +
        "sender. Omit when illegible or uncertain — the channel will " +
        "ask the holder to clarify rather than register a guess.",
    ),
  recipientHouseNumber: z
    .string()
    .optional()
    .describe(
      "House number from the recipient's street address on the label. " +
        "Strip street name + city — return just the number (and any " +
        "letter suffix like '12a'). Omit when absent or unreadable.",
    ),
  trackingNumber: z
    .string()
    .optional()
    .describe(
      "Tracking / sendungsnummer printed on the label, if legible. " +
        "Omit when absent or unreadable.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Overall extraction confidence. 'low' when the label is blurry, " +
        "partially obscured, or the recipient name is uncertain — the " +
        "channel will fall through to a clarification rather than " +
        "register a guess.",
    ),
  reason: z
    .string()
    .describe("One short sentence explaining the extraction."),
});

const trackingPageSchema = z.object({
  kind: z.literal("tracking_page"),
  carrier: packageCarrierSchema.describe(
    "Carrier the tracking page belongs to. Read from the page header / " +
      "logo / brand colours. 'unknown' if no carrier branding is legible.",
  ),
  trackingNumber: z
    .string()
    .optional()
    .describe(
      "Tracking / sendungsnummer printed on the page. Most carriers " +
        "display it prominently near the top. Omit when absent.",
    ),
  expectedWindowStartAt: z
    .string()
    .datetime()
    .optional()
    .describe(
      "Start of the estimated delivery window as an ISO 8601 datetime " +
        "string (e.g. '2026-05-19T13:00:00Z'). If the page shows only a " +
        "single time point, set this to that point. If the page shows " +
        "only a date with no time, omit BOTH this and the end field.",
    ),
  expectedWindowEndAt: z
    .string()
    .datetime()
    .optional()
    .describe(
      "End of the estimated delivery window as an ISO 8601 datetime " +
        "string. If the page shows a single time point, set this to " +
        "the same value as the start. Supplied paired with the start " +
        "(or both omitted).",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Overall extraction confidence. 'low' when the page is blurry, " +
        "partially obscured, the carrier is uncertain, or the window " +
        "is implied rather than printed.",
    ),
  reason: z
    .string()
    .describe("One short sentence explaining the extraction."),
});

const unknownSchema = z.object({
  kind: z.literal("unknown"),
  confidence: z.literal("low"),
  reason: z
    .string()
    .describe(
      "One short sentence explaining why the photo couldn't be " +
        "classified (e.g. 'photo is too dark', 'shows a person, no " +
        "package context', 'unrelated screenshot').",
    ),
});

const outputSchema = z.discriminatedUnion("kind", [
  shippingLabelSchema,
  trackingPageSchema,
  unknownSchema,
]);

export type ParsePackagePhotoResult = z.infer<typeof outputSchema>;

const visionPrompt = [
  "You are reading a package-related photo for a neighbor-coordination",
  "bot in Germany. Your single job is to classify the photo into one of",
  "three kinds and extract the structured fields for that kind. Be",
  "honest about confidence: if a field is blurry, partially obscured,",
  "or you are guessing — say so via `confidence` and omit the uncertain",
  "field rather than invent a plausible value.",
  "",
  "Decide first: which `kind` does this photo show?",
  "",
  "  shipping_label — a physical shipping label or label sticker. Hard",
  "    physical artifacts: paper printed by the carrier, attached to a",
  "    parcel, showing carrier branding + recipient address block +",
  "    tracking barcode. The photo is taken in the real world (visible",
  "    parcel surface, lighting, hands).",
  "",
  "  tracking_page  — a screenshot of a carrier's tracking page (the",
  "    'where is my package?' view a courier provides via SMS/email",
  "    link). Digital artifacts: UI chrome, status timeline, 'arriving",
  "    today between' text, navigation menus, often a map. NO physical",
  "    parcel visible. NO recipient name printed (privacy — the page",
  "    is consumed by the addressee themselves).",
  "",
  "  unknown        — anything else, including: photos that aren't",
  "    package-related at all, package contents (the bot stores carrier",
  "    + recipient only, not contents), screenshots of unrelated apps,",
  "    blurry/dark images you can't classify.",
  "",
  "Carriers to recognise on either kind (logo / brand colours / page or",
  "label layout):",
  "  DHL    — yellow + red, post horn logo",
  "  Hermes — orange, 'h' wordmark",
  "  DPD    — red + grey, 'DPD' wordmark",
  "  GLS    — yellow + blue, 'GLS' wordmark",
  "  UPS    — brown, shield logo",
  "  Amazon — black + orange smile, 'amazon' wordmark",
  "  unknown — any other carrier (e.g. FedEx, Hellofresh, Picnic),",
  "             or no visible carrier branding",
  "",
  "For shipping_label specifically:",
  "  - Recipient name: the addressee printed on the label, NOT the",
  "    sender. Omit if illegible or you are uncertain.",
  "  - House number: just the number (and any letter suffix like '12a').",
  "    Strip street name and city.",
  "",
  "For tracking_page specifically:",
  "  - Delivery window: many tracking pages show an estimated arrival",
  "    window ('Lieferung heute 13:00–16:00' / 'arriving today between",
  "    2pm and 5pm'). Return both endpoints as ISO 8601 datetimes in",
  "    the page's local timezone. If the page shows only a date with",
  "    no time, omit both endpoints. If a single time point ('um 14:00'),",
  "    set both endpoints to that point.",
  "  - Ignore the recipient address (privacy) and promotional banners.",
  "",
  "Confidence levels (within a kind):",
  "  high   — all fields you returned are clearly legible",
  "  medium — at least one field is partially obscured but readable",
  "  low    — fields uncertain, page/label heavily damaged, or you are",
  "           guessing the kind itself",
  "",
  "For `kind: \"unknown\"` confidence is always \"low\" — if you were",
  "confident enough to extract fields, you'd be on shipping_label or",
  "tracking_page instead.",
].join("\n");

interface VisionArgs {
  readonly imageUrl: string;
  readonly caption: string | undefined;
}

async function runVisionModel(
  model: string,
  args: VisionArgs,
): Promise<ParsePackagePhotoResult> {
  const userPrompt =
    args.caption && args.caption.length > 0
      ? `Sender's caption: "${args.caption}". Classify and extract.`
      : "Classify and extract.";

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
    "Classify a package-related photo as a shipping label, a carrier " +
    "tracking-page screenshot, or unknown — and extract the structured " +
    "fields for the chosen kind in one LLM call. Tries Gemini 3.1 Flash " +
    "Lite (vision) first, then falls back to Claude Sonnet 4.6 if the " +
    "primary errors. Routes via Vercel AI Gateway. Returns a " +
    "discriminated union on `kind` (shipping_label | tracking_page | " +
    "unknown). v2.1 #128: invoked by the channel layer " +
    "(`lib/telegram-channel/process-update.ts`) — NOT the conversational " +
    "agent. Supersedes the pre-#128 `parse_label` + `parse_tracking_page` " +
    "split: the channel branches on `kind` to pick Flow 1 vs Flow 2 vs " +
    "the unknown-photo recovery DM.",
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
