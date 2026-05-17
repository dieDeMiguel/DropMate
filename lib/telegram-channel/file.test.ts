import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getTelegramFileUrl } from "./file.js";

const TOKEN = "111:AAA";

describe("getTelegramFileUrl", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls getFile with the right token + file_id and returns the download URL", async () => {
    const fetchSpy = vi
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, result: { file_path: "photos/file_42.jpg" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const url = await getTelegramFileUrl(TOKEN, "abc");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe(`https://api.telegram.org/bot${TOKEN}/getFile`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ file_id: "abc" }));

    expect(url).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/file_42.jpg`);
  });

  it("throws on a non-2xx response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("nope", { status: 400 }),
    );

    await expect(getTelegramFileUrl(TOKEN, "abc")).rejects.toThrow(
      /Telegram getFile failed: 400/,
    );
  });

  it("throws when the response omits file_path", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad Request" }), {
        status: 200,
      }),
    );

    await expect(getTelegramFileUrl(TOKEN, "abc")).rejects.toThrow(
      /no file_path/,
    );
  });

  it("throws when token is empty without hitting fetch", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    await expect(getTelegramFileUrl("", "abc")).rejects.toThrow(/token is empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws when file_id is empty without hitting fetch", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    await expect(getTelegramFileUrl(TOKEN, "")).rejects.toThrow(/file_id is empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
