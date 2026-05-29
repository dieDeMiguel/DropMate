import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadTool() {
  const mod = await import("../../agent/tools/post_to_group.js");
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
const TEST_GROUP_ID = "-1001234567890";

describe("post_to_group", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = TEST_TOKEN;
    process.env.TELEGRAM_GROUP_CHAT_ID = TEST_GROUP_ID;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_GROUP_CHAT_ID;
  });

  it("POSTs to the group chat id from TELEGRAM_GROUP_CHAT_ID", async () => {
    const result = (await runExecute({
      text: "2 Pakete bei Bremer (Hs.92) für Ritter und Meyer.",
    })) as { delivered: boolean };

    expect(result).toEqual({ delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`);
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: Number(TEST_GROUP_ID),
      text: "2 Pakete bei Bremer (Hs.92) für Ritter und Meyer.",
    });
  });

  it("throws when TELEGRAM_BOT_TOKEN is unset", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await expect(runExecute({ text: "hi" })).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN is not set/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when TELEGRAM_GROUP_CHAT_ID is unset", async () => {
    delete process.env.TELEGRAM_GROUP_CHAT_ID;
    await expect(runExecute({ text: "hi" })).rejects.toThrow(
      /TELEGRAM_GROUP_CHAT_ID is not set/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when TELEGRAM_GROUP_CHAT_ID is not a valid number", async () => {
    process.env.TELEGRAM_GROUP_CHAT_ID = "not-a-number";
    await expect(runExecute({ text: "hi" })).rejects.toThrow(
      /TELEGRAM_GROUP_CHAT_ID=not-a-number is not a valid number/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards inline-keyboard buttons as reply_markup with snake_case callback_data", async () => {
    await runExecute({
      text: "Paket für Meyer bei Bremer.",
      buttons: [
        [{ text: "Abgeholt", callbackData: "confirm_pickup:pkg_42" }],
      ],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: Number(TEST_GROUP_ID),
      text: "Paket für Meyer bei Bremer.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Abgeholt", callback_data: "confirm_pickup:pkg_42" }],
        ],
      },
    });
  });

  it("emits text_mention entities for `mentions` with the correct UTF-16 offsets (#45)", async () => {
    await runExecute({
      text: "Paket für Natascha Elter (Hs.71) bei Anna abgegeben.",
      mentions: [
        { name: "Natascha Elter", telegramUserId: 4242 },
      ],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.entities).toEqual([
      {
        type: "text_mention",
        offset: "Paket für ".length,
        length: "Natascha Elter".length,
        user: { id: 4242 },
      },
    ]);
  });

  it("silently skips mentions whose name is not present in the text (with a warn)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runExecute({
        text: "Paket für Meyer bei Bremer.",
        mentions: [
          { name: "Meyer", telegramUserId: 1 },
          { name: "Schmidt", telegramUserId: 2 }, // not in text
        ],
      });

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect(body.entities).toEqual([
        {
          type: "text_mention",
          offset: "Paket für ".length,
          length: "Meyer".length,
          user: { id: 1 },
        },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/Schmidt/);
    } finally {
      warn.mockRestore();
    }
  });

  it("omits the `entities` field entirely when no mentions are supplied (backwards compatible)", async () => {
    await runExecute({ text: "Paket für Meyer bei Bremer." });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect("entities" in body).toBe(false);
  });

  it("omits the `entities` field when every supplied mention's name is missing from the text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runExecute({
        text: "Paket für Meyer.",
        mentions: [{ name: "Schmidt", telegramUserId: 99 }],
      });
      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect("entities" in body).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
