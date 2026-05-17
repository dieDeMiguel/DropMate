import { describe, expect, it } from "vitest";

import { verifyTelegramSecretHeader } from "./verify.js";

function makeRequest(headerValue: string | null): Request {
  const headers = new Headers();
  if (headerValue !== null) {
    headers.set("x-telegram-bot-api-secret-token", headerValue);
  }
  return new Request("https://example.com/api/telegram", {
    method: "POST",
    headers,
  });
}

describe("verifyTelegramSecretHeader", () => {
  it("accepts a request whose header matches the expected secret", () => {
    const req = makeRequest("s3cret");
    expect(verifyTelegramSecretHeader(req, "s3cret")).toEqual({ ok: true });
  });

  it("rejects a missing header with 401", () => {
    const req = makeRequest(null);
    expect(verifyTelegramSecretHeader(req, "s3cret")).toEqual({
      ok: false,
      status: 401,
      reason: "missing or wrong secret header",
    });
  });

  it("rejects a mismatched header with 401", () => {
    const req = makeRequest("nope");
    expect(verifyTelegramSecretHeader(req, "s3cret")).toEqual({
      ok: false,
      status: 401,
      reason: "missing or wrong secret header",
    });
  });

  it("fails fast with 500 when the expected secret is empty (server misconfig)", () => {
    const req = makeRequest("anything");
    expect(verifyTelegramSecretHeader(req, "")).toEqual({
      ok: false,
      status: 500,
      reason: "server misconfigured: TELEGRAM_WEBHOOK_SECRET_TOKEN unset",
    });
  });

  it("fails fast with 500 when the expected secret is undefined", () => {
    const req = makeRequest("anything");
    expect(verifyTelegramSecretHeader(req, undefined)).toEqual({
      ok: false,
      status: 500,
      reason: "server misconfigured: TELEGRAM_WEBHOOK_SECRET_TOKEN unset",
    });
  });

  it("does not short-circuit on a length mismatch (constant-time)", () => {
    // The whole point of a constant-time compare is "same answer, same time".
    // We can't measure timing reliably in a unit test, but we can at least
    // assert the function returns the expected rejection rather than
    // throwing on a length mismatch (which would be observable as a
    // different code path).
    const req = makeRequest("short");
    expect(verifyTelegramSecretHeader(req, "much-longer-secret")).toEqual({
      ok: false,
      status: 401,
      reason: "missing or wrong secret header",
    });
  });
});
