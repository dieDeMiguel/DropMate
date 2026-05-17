import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendTelegramMessage } from "./send.js";

const TEST_TOKEN = "123456:abcdef";

describe("sendTelegramMessage", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the Bot API sendMessage endpoint with chat_id + text", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await sendTelegramMessage(TEST_TOKEN, 42, "Hallo!");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: 42,
      text: "Hallo!",
    });
  });

  it("throws when token is empty without hitting the network", async () => {
    await expect(sendTelegramMessage("", 1, "hi")).rejects.toThrow(
      /token is empty/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns early on empty text without calling the API", async () => {
    await sendTelegramMessage(TEST_TOKEN, 1, "");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with status + body when the API responds non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response("Bad Request: chat not found", {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    await expect(sendTelegramMessage(TEST_TOKEN, 1, "hi")).rejects.toThrow(
      /400 Bad Request.*chat not found/,
    );
  });

  it("propagates errors when reading the failure body throws", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.reject(new Error("stream broken")),
    } as unknown as Response);

    await expect(sendTelegramMessage(TEST_TOKEN, 1, "hi")).rejects.toThrow(
      /500 Internal Server Error/,
    );
  });
});
