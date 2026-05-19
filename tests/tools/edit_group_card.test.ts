import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadTool() {
  const mod = await import("../../agent/tools/edit_group_card.js");
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

const TEST_TOKEN = "111222:abcdef";

describe("edit_group_card", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = TEST_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("edits the card body via editMessageText AND strips the inline keyboard via editMessageReplyMarkup", async () => {
    const result = (await runExecute({
      chatId: -1001234567890,
      messageId: 555,
      text: "✅ angenommen von Marlene Hartmann",
    })) as { edited: boolean };

    expect(result).toEqual({ edited: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [textUrl, textInit] = fetchMock.mock.calls[0]!;
    expect(textUrl).toBe(
      `https://api.telegram.org/bot${TEST_TOKEN}/editMessageText`,
    );
    expect(JSON.parse(textInit?.body as string)).toEqual({
      chat_id: -1001234567890,
      message_id: 555,
      text: "✅ angenommen von Marlene Hartmann",
    });

    const [stripUrl, stripInit] = fetchMock.mock.calls[1]!;
    expect(stripUrl).toBe(
      `https://api.telegram.org/bot${TEST_TOKEN}/editMessageReplyMarkup`,
    );
    expect(JSON.parse(stripInit?.body as string)).toEqual({
      chat_id: -1001234567890,
      message_id: 555,
    });
  });

  it("throws when TELEGRAM_BOT_TOKEN is unset", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await expect(
      runExecute({
        chatId: -1001234567890,
        messageId: 555,
        text: "✅ angenommen",
      }),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the Bot API error when editMessageText returns non-2xx and skips the strip", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response("Bad Request: message can't be edited", { status: 400 }),
    );

    await expect(
      runExecute({
        chatId: -1001234567890,
        messageId: 555,
        text: "stale edit",
      }),
    ).rejects.toThrow(/editMessageText failed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the Bot API error when editMessageReplyMarkup fails after a successful text edit", async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response("Forbidden", { status: 403 }),
      );

    await expect(
      runExecute({
        chatId: -1001234567890,
        messageId: 555,
        text: "✅ angenommen",
      }),
    ).rejects.toThrow(/editMessageReplyMarkup failed/);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes a negative supergroup chat_id through verbatim (no normalisation)", async () => {
    await runExecute({
      chatId: -1001234567890,
      messageId: 1,
      text: "⏰ Zeit abgelaufen, niemand konnte annehmen.",
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string).chat_id).toBe(-1001234567890);
  });
});
