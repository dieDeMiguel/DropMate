/**
 * `telegramChannel` factory tests.
 *
 * Scope is intentionally narrow: the factory is plumbing — it wraps
 * `defineChannel(...)` with closure-captured config and delegates
 * every interesting behaviour to `processInboundTelegramUpdate`
 * (covered exhaustively by `process-update.test.ts`) and
 * `drainSessionToTelegram` (covered by `outbound.test.ts`). The
 * cases here verify the plumbing itself:
 *
 *   - the factory accepts the documented config shape and returns
 *     a truthy channel value the Ash runtime can consume,
 *   - two factory calls with different configs return independent
 *     channel objects (no shared mutable state, so multi-bot
 *     deployment works),
 *   - `token` and `webhookSecret` are required strings — empty
 *     strings are allowed at the type level (the factory's callers
 *     should `process.env.X!` or guard before calling), but the
 *     factory itself doesn't crash on them.
 *
 * Behavioural integration (verify → parse → narrow → send → drain)
 * is exercised end-to-end by `process-update.test.ts`. Re-testing
 * that wiring through the factory would duplicate coverage without
 * adding signal.
 */

import { describe, expect, it } from "vitest";

import {
  detectTraceKind,
  telegramChannel,
  type TelegramChannelConfig,
} from "./factory.js";

function makeJsonRequest(body: unknown): Request {
  return new Request("https://example.com/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("telegramChannel", () => {
  const config: TelegramChannelConfig = {
    token: "bot-token-123",
    webhookSecret: "webhook-secret-abc",
  };

  it("returns a truthy channel object the Ash runtime can mount", () => {
    const channel = telegramChannel(config);

    expect(channel).toBeTruthy();
  });

  it("returns independent channel instances across calls (multi-bot safe)", () => {
    const channelA = telegramChannel({
      token: "bot-A",
      webhookSecret: "secret-A",
    });
    const channelB = telegramChannel({
      token: "bot-B",
      webhookSecret: "secret-B",
    });

    // Different invocations must produce distinct objects — otherwise
    // a multi-bot deployment that mounts two channels would share
    // closure state and route both bots through the same token.
    expect(channelA).not.toBe(channelB);
  });

  it("does not throw on empty token / webhookSecret strings", () => {
    // Empty strings are permitted at the type level — callers are
    // expected to guard upstream (e.g. `process.env.X!` will throw
    // long before this factory runs in misconfigured deployments).
    // The factory itself shouldn't crash on construction; any
    // empty-secret rejection happens later, at request time, inside
    // `verifyTelegramSecretHeader` (which returns a 500 status).
    expect(() =>
      telegramChannel({ token: "", webhookSecret: "" }),
    ).not.toThrow();
  });

  it("does not throw on long, unusual token / secret values", () => {
    // Telegram secret tokens permit up to 256 characters; the factory
    // must accept them verbatim (no length-based truncation or
    // normalisation).
    const longSecret = "x".repeat(256);
    const tokenWithColons = "1234567890:AAAAA-BBBBB_CCCCC-DDDDD";

    expect(() =>
      telegramChannel({
        token: tokenWithColons,
        webhookSecret: longSecret,
      }),
    ).not.toThrow();
  });
});

describe("detectTraceKind (#60 / #61 — trace-kind detection at webhook entry)", () => {
  it("returns 'photo' when the inbound update has a non-empty photo[]", async () => {
    const req = makeJsonRequest({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 42, type: "private" },
        from: { id: 99, is_bot: false, first_name: "Test" },
        photo: [{ file_id: "AgAC", file_size: 100, width: 90, height: 90 }],
      },
    });
    expect(await detectTraceKind(req)).toBe("photo");
  });

  it("returns 'callback' when the inbound update is a callback_query", async () => {
    const req = makeJsonRequest({
      update_id: 2,
      callback_query: {
        id: "cb1",
        data: "confirm_pickup:pkg_1",
        from: { id: 99, is_bot: false, first_name: "Test" },
        message: {
          message_id: 3,
          chat: { id: 42, type: "supergroup" },
        },
      },
    });
    expect(await detectTraceKind(req)).toBe("callback");
  });

  it("returns 'text' for a plain text DM", async () => {
    const req = makeJsonRequest({
      update_id: 3,
      message: {
        message_id: 4,
        chat: { id: 42, type: "private" },
        text: "Hallo",
      },
    });
    expect(await detectTraceKind(req)).toBe("text");
  });

  it("falls back to 'text' on malformed JSON (defensive)", async () => {
    const req = new Request("https://example.com/api/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json {{{",
    });
    expect(await detectTraceKind(req)).toBe("text");
  });

  it("does not consume the request body — downstream code can still call req.json()", async () => {
    const req = makeJsonRequest({
      update_id: 4,
      message: {
        message_id: 5,
        chat: { id: 42, type: "private" },
        photo: [{ file_id: "AgAC", file_size: 100, width: 90, height: 90 }],
      },
    });
    const kind = await detectTraceKind(req);
    expect(kind).toBe("photo");
    // Downstream re-read must work.
    const json = (await req.json()) as { update_id: number };
    expect(json.update_id).toBe(4);
  });

  it("returns 'callback' for a callback even when message.photo[] is also present (defensive against weird payloads)", async () => {
    // Bot API doesn't mix these in practice, but `extractInboundCallback`
    // takes precedence in the orchestrator, so this matches the
    // downstream routing.
    const req = makeJsonRequest({
      update_id: 5,
      callback_query: {
        id: "cb2",
        data: "x:y",
        from: { id: 1, is_bot: false, first_name: "T" },
        message: { message_id: 1, chat: { id: 1, type: "private" } },
      },
      message: {
        message_id: 1,
        chat: { id: 1, type: "private" },
        photo: [{ file_id: "AgAC", file_size: 100, width: 90, height: 90 }],
      },
    });
    expect(await detectTraceKind(req)).toBe("callback");
  });
});
