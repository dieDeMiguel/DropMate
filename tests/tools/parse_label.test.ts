/**
 * `parse_label` — vision tool covering the fallback chain and the
 * output schema's optional-field handling.
 *
 * Tests are intentionally model-agnostic: the AI Gateway's actual
 * routing (gemma → claude opus 4.5) is exercised behind `generateObject`,
 * which we mock. We assert on the call sequence (primary first, then
 * fallback iff primary throws) and on the model strings the tool
 * passes to `generateObject` so the fallback chain stays stable.
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

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

const sampleBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const sampleBase64 = Buffer.from(sampleBytes).toString("base64");

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
      imageBase64: sampleBase64,
      mediaType: "image/jpeg",
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
    expect(call.model).toBe("google/gemma-4-31b-it");
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
      imageBase64: sampleBase64,
      mediaType: "image/jpeg",
    })) as { confidence: string; reason: string };

    expect(result.confidence).toBe("low");
    expect(result.reason).toMatch(/obscured/);
  });

  it("falls back to Claude Opus 4.5 when the primary model throws", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("gemma quota exceeded"));
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "Hermes",
        recipientName: "Ritter",
        confidence: "medium",
        reason: "fallback succeeded",
      },
    });

    const result = (await runExecute({
      imageBase64: sampleBase64,
      mediaType: "image/jpeg",
    })) as { carrier: string };

    expect(result.carrier).toBe("Hermes");

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(generateObjectMock.mock.calls[0]![0].model).toBe(
      "google/gemma-4-31b-it",
    );
    expect(generateObjectMock.mock.calls[1]![0].model).toBe(
      "anthropic/claude-opus-4.5",
    );
  });

  it("re-throws the primary's error when BOTH primary and fallback fail (preserves the most diagnostic signal)", async () => {
    const primaryErr = new Error("gemma down");
    generateObjectMock.mockRejectedValueOnce(primaryErr);
    generateObjectMock.mockRejectedValueOnce(new Error("claude down too"));

    await expect(
      runExecute({ imageBase64: sampleBase64, mediaType: "image/jpeg" }),
    ).rejects.toBe(primaryErr);

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it("passes the image as a FilePart with the bytes the orchestrator base64-decoded", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        carrier: "DHL",
        confidence: "high",
        reason: "ok",
      },
    });

    await runExecute({
      imageBase64: sampleBase64,
      mediaType: "image/png",
      caption: "lab",
    });

    const call = generateObjectMock.mock.calls[0]![0];
    expect(Array.isArray(call.messages)).toBe(true);
    const userMessage = call.messages[0];
    expect(userMessage.role).toBe("user");
    expect(Array.isArray(userMessage.content)).toBe(true);

    const filePart = userMessage.content[0];
    expect(filePart.type).toBe("file");
    expect(filePart.mediaType).toBe("image/png");
    expect(filePart.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(filePart.data).equals(Buffer.from(sampleBytes))).toBe(
      true,
    );

    const textPart = userMessage.content[1];
    expect(textPart.type).toBe("text");
    expect(textPart.text).toMatch(/caption.*lab/i);
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
      imageBase64: sampleBase64,
      mediaType: "image/jpeg",
    });

    const call = generateObjectMock.mock.calls[0]![0];
    const textPart = call.messages[0].content[1];
    expect(textPart.text).not.toMatch(/caption/i);
    expect(textPart.text).toMatch(/read the label/i);
  });
});
