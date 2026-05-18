/**
 * `parse_label` — vision tool covering the fallback chain and the
 * output schema's optional-field handling.
 *
 * Tests are intentionally model-agnostic: the AI Gateway's actual
 * routing (gemini → claude sonnet 4.6) is exercised behind
 * `generateObject`, which we mock. We assert on the call sequence
 * (primary first, then fallback iff primary throws) and on the model
 * strings the tool passes to `generateObject` so the fallback chain
 * stays stable.
 *
 * Model-identifier regression guard: the slugs are imported from the
 * tool module rather than re-typed here. If someone bumps `PRIMARY_MODEL`
 * or `FALLBACK_MODEL` to a wrong/text-only slug, the existence test
 * below (`primary slug names a current vision-capable model`) is the
 * canary — it asserts the slugs match a known-good vision-capable set.
 *
 * URL vs bytes: the tool takes an `imageUrl` string and passes it to
 * generateObject as `{ type: 'file', data: imageUrl, mediaType: 'image' }`.
 * Inline bytes (Uint8Array / base64) do NOT work via the Vercel AI
 * Gateway — the Gateway client converts them to a `data:` URI and the
 * Gateway server rejects with "Unsupported file URI type". Tests
 * therefore assert URL-shape, not byte-shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

async function loadTool() {
  const mod = await import("../../agent/tools/parse_label.js");
  return mod.default;
}

async function loadModelSlugs() {
  const mod = await import("../../agent/tools/parse_label.js");
  return { primary: mod.PRIMARY_MODEL, fallback: mod.FALLBACK_MODEL };
}

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

const sampleUrl =
  "https://api.telegram.org/file/bot111:AAA/photos/file_42.jpg";

describe("parse_label", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("returns the parsed label fields from the primary model on the happy path", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "DHL",
        trackingNumber: "00340434161094021899",
        recipientName: "Anna-Sophie Meyer",
        recipientHouseNumber: "92",
        confidence: "high",
        reason: "all fields legible",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
      caption: "Paket für Anna-Sophie",
    })) as {
      carrier: string;
      recipientName?: string;
      confidence: string;
    };

    expect(result.carrier).toBe("DHL");
    expect(result.recipientName).toBe("Anna-Sophie Meyer");
    expect(result.confidence).toBe("high");

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0][0];
    const { primary } = await loadModelSlugs();
    expect(call.model).toBe(primary);
  });

  it("returns a low-confidence parse intact so the orchestrator can append the please-confirm suffix", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "unknown",
        recipientName: "M?yer",
        confidence: "low",
        reason: "recipient name partially obscured",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
    })) as { confidence: string; reason: string };

    expect(result.confidence).toBe("low");
    expect(result.reason).toMatch(/obscured/);
  });

  it("falls back to the secondary model when the primary throws", async () => {
    generateObjectMock.mockRejectedValueOnce(
      new Error("primary vision call failed"),
    );
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "Hermes",
        recipientName: "Ritter",
        confidence: "medium",
        reason: "fallback succeeded",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
    })) as { carrier: string };

    expect(result.carrier).toBe("Hermes");

    const { primary, fallback } = await loadModelSlugs();
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(generateObjectMock.mock.calls[0]![0].model).toBe(primary);
    expect(generateObjectMock.mock.calls[1]![0].model).toBe(fallback);
  });

  it("re-throws the primary's error when BOTH primary and fallback fail (preserves the most diagnostic signal)", async () => {
    const primaryErr = new Error("gemma down");
    generateObjectMock.mockRejectedValueOnce(primaryErr);
    generateObjectMock.mockRejectedValueOnce(new Error("claude down too"));

    await expect(runExecute({ imageUrl: sampleUrl })).rejects.toBe(primaryErr);

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it("passes the image URL through as a FilePart with mediaType='image' so the Gateway server fetches it", async () => {
    // Regression guard for the v0.3 photo-path bug: passing inline bytes
    // makes the Gateway client serialize to `data:image/jpeg;base64,...`
    // and the Gateway server rejects with "Unsupported file URI type".
    // The tool MUST pass the URL through verbatim as the `data` field.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "DHL",
        confidence: "high",
        reason: "ok",
      },
    });

    await runExecute({
      imageUrl: sampleUrl,
      caption: "lab",
    });

    const call = generateObjectMock.mock.calls[0]![0];
    expect(Array.isArray(call.messages)).toBe(true);
    const userMessage = call.messages[0];
    expect(userMessage.role).toBe("user");
    expect(Array.isArray(userMessage.content)).toBe(true);

    const filePart = userMessage.content[0];
    expect(filePart.type).toBe("file");
    expect(filePart.mediaType).toBe("image");
    expect(filePart.data).toBe(sampleUrl);

    const textPart = userMessage.content[1];
    expect(textPart.type).toBe("text");
    expect(textPart.text).toMatch(/caption.*lab/i);
  });

  it("PRIMARY_MODEL and FALLBACK_MODEL name vision-capable slugs on the AI Gateway", async () => {
    // Regression guard for the v0.3 launch bug: `google/gemma-4-31b-it`
    // and friends are valid AI Gateway model IDs but are TEXT-ONLY —
    // passing a FilePart throws at the provider boundary, then the
    // fallback fires and also fails, and we get the "label couldn't
    // be parsed" branch in prod with no clear signal in logs.
    //
    // This test isn't a perfect oracle (the gateway adds models over
    // time and may add vision support to existing ones), but it catches
    // the specific class of mistake that bit us: someone reaches for a
    // cheap-sounding identifier without checking modalities. If you
    // need to add a new model, also add it to the allowlist here.
    const { primary, fallback } = await loadModelSlugs();

    // Vision-capable model families currently confirmed on the AI
    // Gateway. Extracted by querying
    //   curl https://ai-gateway.vercel.sh/v1/models
    // and cross-referencing the Vercel models page modality column.
    // Update this list when adding a new model — and only with a slug
    // that has confirmed image-input support.
    const visionCapablePrefixes = [
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "google/gemini-3-flash",
      "google/gemini-3-pro-preview",
      "google/gemini-3.1-flash-lite",
      "google/gemini-3.1-pro-preview",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4",
      "anthropic/claude-opus-4.1",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.7",
      "openai/gpt-5",
    ];

    // Slugs known to be text-only (or image-generation-only) — these
    // must NOT show up as primary or fallback. Hard-coded denylist as
    // a belt-and-braces for the allowlist above.
    const textOnlyOrImageGenSlugs = [
      "google/gemma-4-31b-it",
      "google/gemma-4-26b-a4b-it",
      "google/gemini-2.5-flash-image",
      "google/gemini-3-pro-image",
      "google/gemini-3.1-flash-image-preview",
    ];

    for (const slug of [primary, fallback]) {
      expect(textOnlyOrImageGenSlugs).not.toContain(slug);
      const matched = visionCapablePrefixes.some((p) => slug.startsWith(p));
      expect(matched, `${slug} is not in the vision-capable allowlist`).toBe(
        true,
      );
    }
  });

  it("uses a generic prompt when no caption is supplied", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "DHL",
        confidence: "high",
        reason: "ok",
      },
    });

    await runExecute({
      imageUrl: sampleUrl,
    });

    const call = generateObjectMock.mock.calls[0]![0];
    const textPart = call.messages[0].content[1];
    expect(textPart.text).not.toMatch(/caption/i);
    expect(textPart.text).toMatch(/read the label/i);
  });
});
