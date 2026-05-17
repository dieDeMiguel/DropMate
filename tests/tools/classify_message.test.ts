import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

async function loadTool() {
  const mod = await import("../../agent/tools/classify_message.js");
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

describe("classify_message", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("returns the model's classification for a package message", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { isPackageRelated: true, reason: "explicit 'Paket für …'" },
    });

    const result = (await runExecute({ text: "Paket für Ritter" })) as {
      isPackageRelated: boolean;
      reason: string;
    };

    expect(result.isPackageRelated).toBe(true);
    expect(result.reason).toMatch(/Paket/);
  });

  it("returns false for off-topic chat", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { isPackageRelated: false, reason: "party flyer" },
    });

    const result = (await runExecute({
      text: "Sommerfest am Samstag im Hinterhof!",
    })) as { isPackageRelated: boolean };

    expect(result.isPackageRelated).toBe(false);
  });

  it("routes through Gemini Flash with cost-sorted gateway providers", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { isPackageRelated: true, reason: "x" },
    });

    await runExecute({ text: "Paket für Meyer" });

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0][0];
    expect(call.model).toBe("google/gemini-2.5-flash");
    expect(call.providerOptions).toEqual({ gateway: { sort: "cost" } });
    expect(call.prompt).toBe("Paket für Meyer");
    expect(typeof call.system).toBe("string");
  });
});
