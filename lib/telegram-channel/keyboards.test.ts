import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  answerCallbackQuery,
  editMessageReplyMarkup,
} from "./keyboards.js";

const TOKEN = "123456:abcdef";

describe("answerCallbackQuery", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs callback_query_id to the Bot API", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await answerCallbackQuery(TOKEN, "cb_abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`,
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      callback_query_id: "cb_abc",
    });
  });

  it("includes a notification text when supplied", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    await answerCallbackQuery(TOKEN, "cb_abc", "Bestätigt");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      callback_query_id: "cb_abc",
      text: "Bestätigt",
    });
  });

  it("omits the text field when empty", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    await answerCallbackQuery(TOKEN, "cb_abc", "");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      callback_query_id: "cb_abc",
    });
  });

  it("throws when token is empty without hitting the network", async () => {
    await expect(answerCallbackQuery("", "cb_abc")).rejects.toThrow(
      /token is empty/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with status + body when the API responds non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response("Query is too old", {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    await expect(answerCallbackQuery(TOKEN, "cb_old")).rejects.toThrow(
      /400 Bad Request.*Query is too old/,
    );
  });
});

describe("editMessageReplyMarkup", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs chat_id + message_id with no keyboard to strip the markup", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    await editMessageReplyMarkup(TOKEN, 42, 555);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://api.telegram.org/bot${TOKEN}/editMessageReplyMarkup`,
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: 42,
      message_id: 555,
    });
  });

  it("forwards a new keyboard when supplied", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    await editMessageReplyMarkup(TOKEN, 42, 555, {
      inline_keyboard: [[{ text: "Done", callback_data: "noop" }]],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: 42,
      message_id: 555,
      reply_markup: {
        inline_keyboard: [[{ text: "Done", callback_data: "noop" }]],
      },
    });
  });

  it("throws when token is empty without hitting the network", async () => {
    await expect(editMessageReplyMarkup("", 1, 1)).rejects.toThrow(
      /token is empty/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with status + body when the API responds non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response("Message to edit not found", {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    await expect(editMessageReplyMarkup(TOKEN, 1, 999)).rejects.toThrow(
      /400 Bad Request.*Message to edit not found/,
    );
  });
});
