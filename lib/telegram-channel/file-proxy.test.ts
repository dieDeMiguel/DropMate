import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildFileProxyUrl,
  handleFileProxyRequest,
} from "./file-proxy.js";

const TOKEN = "111:AAA";
const SECRET = "ws-secret-32-bytes-or-so";

function makeReq(url: string): Request {
  return new Request(url, { method: "GET" });
}

describe("buildFileProxyUrl", () => {
  it("returns a fully-qualified URL with fileId in the path and exp+sig in the query", () => {
    const url = buildFileProxyUrl(
      "https://example.test",
      "AgADBAADfXkxG8C",
      SECRET,
    );
    expect(url).toMatch(
      /^https:\/\/example\.test\/api\/telegram-file\/AgADBAADfXkxG8C\?exp=\d+&sig=[0-9a-f]{64}$/,
    );
  });

  it("URL-encodes fileIds that contain reserved characters", () => {
    const url = buildFileProxyUrl(
      "https://example.test",
      "weird id/with?query",
      SECRET,
    );
    expect(url).toContain("/api/telegram-file/weird%20id%2Fwith%3Fquery?");
  });
});

describe("handleFileProxyRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns 400 when the id is missing", async () => {
    const res = await handleFileProxyRequest(
      makeReq("https://example.test/api/telegram-file/?exp=1&sig=x"),
      undefined,
      { token: TOKEN, secret: SECRET },
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 when exp or sig is missing", async () => {
    const res = await handleFileProxyRequest(
      makeReq("https://example.test/api/telegram-file/abc"),
      "abc",
      { token: TOKEN, secret: SECRET },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on signature mismatch", async () => {
    const url = new URL(
      buildFileProxyUrl("https://example.test", "abc", SECRET),
    );
    // Flip the last char of the sig.
    const badSig = url.searchParams.get("sig")!.slice(0, -1) + "0";
    url.searchParams.set("sig", badSig);
    const res = await handleFileProxyRequest(makeReq(url.toString()), "abc", {
      token: TOKEN,
      secret: SECRET,
    });
    expect(res.status).toBe(401);
  });

  it("returns 410 when the URL has expired", async () => {
    const url = buildFileProxyUrl(
      "https://example.test",
      "abc",
      SECRET,
      60, // 60s TTL
    );
    // Advance past the expiry.
    vi.advanceTimersByTime(120_000);

    const res = await handleFileProxyRequest(makeReq(url), "abc", {
      token: TOKEN,
      secret: SECRET,
    });
    expect(res.status).toBe(410);
  });

  it("returns 502 when the upstream Telegram fetch fails", async () => {
    const url = buildFileProxyUrl("https://example.test", "abc", SECRET);
    // Mock getFile + CDN download — getFile fails (non-2xx).
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, description: "file not found" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      fetchSpy as unknown as typeof fetch,
    );

    const res = await handleFileProxyRequest(makeReq(url), "abc", {
      token: TOKEN,
      secret: SECRET,
    });
    expect(res.status).toBe(502);
  });

  it("returns 200 with content-type image/jpeg even if Telegram returns application/octet-stream", async () => {
    // Reproduces the prod failure mode: Telegram CDN tags photos as
    // octet-stream; the Gateway rejects unless we override the type.
    const url = buildFileProxyUrl("https://example.test", "abc", SECRET);
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
    const fetchSpy = vi
      .fn()
      // 1. getFile response with file_path.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      // 2. CDN download.
      .mockResolvedValueOnce(
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      fetchSpy as unknown as typeof fetch,
    );

    const res = await handleFileProxyRequest(makeReq(url), "abc", {
      token: TOKEN,
      secret: SECRET,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(payload));
  });
});
