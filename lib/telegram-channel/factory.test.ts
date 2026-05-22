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

import { detectTraceKind, telegramChannel, type TelegramChannelConfig } from "./factory.js";

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
