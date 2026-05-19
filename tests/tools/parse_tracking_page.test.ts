/**
 * `parse_tracking_page` — vision tool covering the fallback chain and
 * the output schema's optional-field handling. Sibling to
 * `parse_label.test.ts`; same conventions (mocked `generateObject`,
 * model-string regression guard) so a future contributor can pattern-
 * match across both tools without re-learning the test shape.
 *
 * URL vs bytes: the tool takes an `imageUrl` string and passes it to
 * `generateObject` as `{ type: 'file', data: imageUrl, mediaType: 'image' }`.
 * Inline bytes do NOT work via the Vercel AI Gateway — the Gateway
 * client converts them to a `data:` URI and the Gateway server rejects
 * with "Unsupported file URI type". Tests therefore assert URL-shape,
 * not byte-shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

async function loadTool() {
  const mod = await import("../../agent/tools/parse_tracking_page.js");
  return mod.default;
}

async function loadModelSlugs() {
  const mod = await import("../../agent/tools/parse_tracking_page.js");
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

describe("parse_tracking_page", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("returns the parsed tracking-page fields from the primary model on the happy path", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "DHL",
        trackingNumber: "00340434161094021899",
        expectedWindowStartAt: "2026-05-19T13:00:00Z",
        expectedWindowEndAt: "2026-05-19T16:00:00Z",
        absenceSignal: true,
        confidence: "high",
        reason: "all fields legible; caption explicitly says 'bin nicht da'",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
      caption: "kann jemand annehmen? bin nicht da",
    })) as {
      carrier: string;
      trackingNumber?: string;
      expectedWindowStartAt?: string;
      expectedWindowEndAt?: string;
      absenceSignal?: boolean;
      confidence: string;
    };

    expect(result.carrier).toBe("DHL");
    expect(result.trackingNumber).toBe("00340434161094021899");
    expect(result.expectedWindowStartAt).toBe("2026-05-19T13:00:00Z");
    expect(result.expectedWindowEndAt).toBe("2026-05-19T16:00:00Z");
    expect(result.absenceSignal).toBe(true);
    expect(result.confidence).toBe("high");

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0]![0];
    const { primary } = await loadModelSlugs();
    expect(call.model).toBe(primary);
  });

  it("returns a low-confidence parse intact so the orchestrator can append the please-confirm suffix", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "unknown",
        confidence: "low",
        reason: "carrier logo obscured by screenshot crop",
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
    const primaryErr = new Error("gemini down");
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
      caption: "kann jemand annehmen?",
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
    expect(textPart.text).toMatch(/caption.*annehmen/i);
  });

  it("PRIMARY_MODEL and FALLBACK_MODEL name vision-capable slugs on the AI Gateway", async () => {
    // Regression guard for the v0.3 launch bug (mirrors parse_label's
    // canary): text-only Gemma variants are valid AI Gateway model IDs
    // but throw at the provider boundary when handed a FilePart. If you
    // need to add a new model, add it to the allowlist here AND check
    // its modality column on https://ai-gateway.vercel.sh/v1/models.
    const { primary, fallback } = await loadModelSlugs();

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
    expect(textPart.text).toMatch(/read the tracking page/i);
  });

  it("preserves an optional absenceSignal=false when the model explicitly declared no absence", async () => {
    // The schema admits absenceSignal as optional; a model that says
    // "no, the caption was a search intent" should round-trip the
    // explicit `false` so the orchestrator can route to a different
    // flow rather than defaulting to Flow 2 v2.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "DHL",
        absenceSignal: false,
        confidence: "medium",
        reason: "caption asks where the package IS, not requesting help",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
      caption: "wo ist mein Paket? Sollte schon da sein",
    })) as { absenceSignal?: boolean };

    expect(result.absenceSignal).toBe(false);
  });
});
