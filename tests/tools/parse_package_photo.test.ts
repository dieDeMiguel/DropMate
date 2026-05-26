/**
 * `parse_package_photo` — unified vision tool. Covers the discriminated
 * union output, the fallback chain, and URL-shape regression guards.
 *
 * Tests are intentionally model-agnostic: the AI Gateway's actual
 * routing (gemini → claude sonnet 4.6) is exercised behind
 * `generateObject`, which we mock. We assert on the call sequence
 * (primary first, then fallback iff primary throws) and on the model
 * strings the tool passes to `generateObject` so the fallback chain
 * stays stable.
 *
 * v2.1 #128: this tool supersedes `parse_label` + `parse_tracking_page`
 * with a single LLM call that returns one of three discriminated shapes
 * (`shipping_label` | `tracking_page` | `unknown`). The channel layer
 * branches on `kind` to pick Flow 1 (DM-photo register), Flow 2
 * (tracking-page reception request), or the recovery DM.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

async function loadTool() {
  const mod = await import("../../agent/tools/parse_package_photo.js");
  return mod.default;
}

async function loadModelSlugs() {
  const mod = await import("../../agent/tools/parse_package_photo.js");
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

describe("parse_package_photo", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("returns kind='shipping_label' with recipient + carrier fields on a clear label photo", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        kind: "shipping_label",
        carrier: "DHL",
        recipientName: "Anna-Sophie Meyer",
        recipientHouseNumber: "92",
        trackingNumber: "00340434161094021899",
        confidence: "high",
        reason: "all fields legible on a clear DHL label",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
      caption: "Paket für Anna-Sophie",
    })) as {
      kind: string;
      carrier: string;
      recipientName?: string;
      confidence: string;
    };

    expect(result.kind).toBe("shipping_label");
    expect(result.carrier).toBe("DHL");
    expect(result.recipientName).toBe("Anna-Sophie Meyer");
    expect(result.confidence).toBe("high");

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0][0];
    const { primary } = await loadModelSlugs();
    expect(call.model).toBe(primary);
  });

  it("returns kind='tracking_page' with carrier + window endpoints on a clear tracking page screenshot", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        kind: "tracking_page",
        carrier: "Hermes",
        trackingNumber: "H42-998877",
        expectedWindowStartAt: "2026-05-19T13:00:00Z",
        expectedWindowEndAt: "2026-05-19T16:00:00Z",
        confidence: "high",
        reason: "Hermes tracking page with explicit 13-16 window",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
      caption: "Bin morgen nicht zu Hause",
    })) as {
      kind: string;
      carrier: string;
      expectedWindowStartAt?: string;
      expectedWindowEndAt?: string;
      confidence: string;
    };

    expect(result.kind).toBe("tracking_page");
    expect(result.carrier).toBe("Hermes");
    expect(result.expectedWindowStartAt).toBe("2026-05-19T13:00:00Z");
    expect(result.expectedWindowEndAt).toBe("2026-05-19T16:00:00Z");
    expect(result.confidence).toBe("high");
  });

  it("returns kind='unknown' with confidence='low' on an unclassifiable photo", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        kind: "unknown",
        confidence: "low",
        reason: "photo is a meme screenshot, no package context",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
    })) as { kind: string; confidence: string; reason: string };

    expect(result.kind).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.reason).toMatch(/meme/);
  });

  it("falls back to the secondary model when the primary throws", async () => {
    generateObjectMock.mockRejectedValueOnce(
      new Error("primary vision call failed"),
    );
    generateObjectMock.mockResolvedValueOnce({
      object: {
        kind: "shipping_label",
        carrier: "Hermes",
        recipientName: "Ritter",
        recipientHouseNumber: "5",
        confidence: "medium",
        reason: "fallback succeeded",
      },
    });

    const result = (await runExecute({
      imageUrl: sampleUrl,
    })) as { kind: string; carrier: string };

    expect(result.kind).toBe("shipping_label");
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
    // Regression guard: passing inline bytes makes the Gateway client
    // serialize to `data:image/jpeg;base64,...` and the Gateway server
    // rejects with "Unsupported file URI type". The tool MUST pass the
    // URL through verbatim as the `data` field.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        kind: "shipping_label",
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
    // Regression guard for the v0.3 launch bug: text-only slugs (e.g.
    // `google/gemma-4-31b-it`) throw at the provider boundary on a
    // FilePart input. Both slugs must be on the vision-capable list.
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
        kind: "shipping_label",
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
    expect(textPart.text).toMatch(/classify/i);
  });

  it("system prompt names all three kinds AND distinguishes shipping_label vs tracking_page so the model can route correctly", async () => {
    // Regression pin against silently dropping a kind from the
    // classification rubric.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        kind: "unknown",
        confidence: "low",
        reason: "ok",
      },
    });
    await runExecute({ imageUrl: sampleUrl });

    const call = generateObjectMock.mock.calls[0]![0];
    expect(call.system).toMatch(/shipping_label/);
    expect(call.system).toMatch(/tracking_page/);
    expect(call.system).toMatch(/unknown/);
    // Disambiguation lives in the prompt: the model needs the cue that
    // physical artifacts → shipping_label, digital screenshots →
    // tracking_page.
    expect(call.system).toMatch(/physical/i);
    expect(call.system).toMatch(/screenshot/i);
  });
});
