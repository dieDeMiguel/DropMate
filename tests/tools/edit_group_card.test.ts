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

  it("rewrites the card text and strips the keyboard (two Bot API calls)", async () => {
    const result = (await runExecute({
      chatId: -1001234567890,
      messageId: 4242,
      text: "⏰ Zeit abgelaufen, niemand konnte annehmen.",
    })) as { edited: boolean };

    expect(result).toEqual({ edited: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [editTextUrl, editTextInit] = fetchMock.mock.calls[0]!;
    expect(editTextUrl).toBe(
      `https://api.telegram.org/bot${TEST_TOKEN}/editMessageText`,
    );
    expect(JSON.parse(editTextInit?.body as string)).toEqual({
      chat_id: -1001234567890,
      message_id: 4242,
      text: "⏰ Zeit abgelaufen, niemand konnte annehmen.",
    });

    const [stripUrl, stripInit] = fetchMock.mock.calls[1]!;
    expect(stripUrl).toBe(
      `https://api.telegram.org/bot${TEST_TOKEN}/editMessageReplyMarkup`,
    );
    expect(JSON.parse(stripInit?.body as string)).toEqual({
      chat_id: -1001234567890,
      message_id: 4242,
    });
  });

  it("throws when TELEGRAM_BOT_TOKEN is unset and does not call fetch", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await expect(
      runExecute({
        chatId: -1001234567890,
        messageId: 4242,
        text: "⏰ Zeit abgelaufen.",
      }),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a non-2xx Bot API failure on the text edit (and skips the keyboard strip)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("message to edit not found", { status: 400 }),
    );

    await expect(
      runExecute({
        chatId: -1001234567890,
        messageId: 4242,
        text: "⏰ Zeit abgelaufen.",
      }),
    ).rejects.toThrow(/editMessageText failed: 400/);

    // Only the text edit was attempted; the strip is skipped on failure
    // because editGroupCard awaits the text edit before issuing the strip.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-2xx Bot API failure on the keyboard strip", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not authorized", { status: 403 }));

    await expect(
      runExecute({
        chatId: -1001234567890,
        messageId: 4242,
        text: "❌ Paket nie angekommen — abgelaufen.",
      }),
    ).rejects.toThrow(/editMessageReplyMarkup failed: 403/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards numeric chatId verbatim (negative supergroup ids preserved)", async () => {
    await runExecute({
      chatId: -1009999999999,
      messageId: 7777,
      text: "❌ Paket nie angekommen — abgelaufen.",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string).chat_id).toBe(-1009999999999);
  });
});
