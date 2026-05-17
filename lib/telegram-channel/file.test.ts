import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchTelegramFile, getTelegramFileUrl } from "./file.js";

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

describe("fetchTelegramFile", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the file_id, downloads the bytes, and returns them with the CDN's media type", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    // 1. getFile → path
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, result: { file_path: "photos/file_42.jpg" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    // 2. CDN → bytes
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic header
    fetchSpy.mockResolvedValueOnce(
      new Response(payload, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const result = await fetchTelegramFile(TOKEN, "abc");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const downloadCall = fetchSpy.mock.calls[1]!;
    expect(downloadCall[0]).toBe(
      `https://api.telegram.org/file/bot${TOKEN}/photos/file_42.jpg`,
    );
    expect(result.mediaType).toBe("image/png");
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.bytes)).toEqual(Array.from(payload));
  });

  it("falls back to image/jpeg when the CDN omits content-type", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      // No content-type header.
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    const result = await fetchTelegramFile(TOKEN, "abc");
    expect(result.mediaType).toBe("image/jpeg");
  });

  it("throws when the CDN download returns a non-2xx", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(fetchTelegramFile(TOKEN, "abc")).rejects.toThrow(
      /Telegram file download failed: 404/,
    );
  });

  it("propagates getFile failures without attempting a download", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 400 }));

    await expect(fetchTelegramFile(TOKEN, "abc")).rejects.toThrow(
      /Telegram getFile failed: 400/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
