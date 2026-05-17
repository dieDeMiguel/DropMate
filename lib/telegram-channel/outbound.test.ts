import { describe, expect, it, vi } from "vitest";

import type { Session } from "experimental-ash/channels";

import {
  TELEGRAM_SESSION_FAILED_REPLY,
  drainSessionToTelegram,
} from "./outbound.js";

type StreamEvent = { type: string; data: unknown };

/**
 * Build a fake Ash `Session` whose `getEventStream()` returns a
 * `ReadableStream` driven by `events`. Each entry is yielded once
 * then the stream closes — which is what the production stream does
 * when the turn completes.
 */
function makeSession(events: StreamEvent[]): Session {
  return {
    id: "sess_test",
    continuationToken: "tg:42",
    async getEventStream(): Promise<ReadableStream<StreamEvent>> {
      return new ReadableStream<StreamEvent>({
        start(controller) {
          for (const ev of events) controller.enqueue(ev);
          controller.close();
        },
      });
    },
  } as unknown as Session;
}

describe("drainSessionToTelegram", () => {
  it("posts assistant text on message.completed events", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession([
      {
        type: "message.completed",
        data: {
          message: "Hallo!",
          finishReason: "stop",
          sequence: 0,
          stepIndex: 0,
          turnId: "t1",
        },
      },
    ]);

    await drainSessionToTelegram(session, 42, { sendMessage });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(42, "Hallo!");
  });

  it("forwards every message.completed in order — one turn can emit several", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession([
      {
        type: "message.completed",
        data: {
          message: "First",
          finishReason: "tool_call",
          sequence: 0,
          stepIndex: 0,
          turnId: "t1",
        },
      },
      {
        type: "action.result",
        data: { result: "ok" },
      },
      {
        type: "message.completed",
        data: {
          message: "Second",
          finishReason: "stop",
          sequence: 1,
          stepIndex: 1,
          turnId: "t1",
        },
      },
    ]);

    await drainSessionToTelegram(session, 42, { sendMessage });

    expect(sendMessage.mock.calls).toEqual([
      [42, "First"],
      [42, "Second"],
    ]);
  });

  it("skips message.completed events with empty or null text", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession([
      {
        type: "message.completed",
        data: {
          message: null,
          finishReason: "tool_call",
          sequence: 0,
          stepIndex: 0,
          turnId: "t1",
        },
      },
      {
        type: "message.completed",
        data: {
          message: "",
          finishReason: "stop",
          sequence: 1,
          stepIndex: 0,
          turnId: "t1",
        },
      },
    ]);

    await drainSessionToTelegram(session, 42, { sendMessage });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("posts a generic apology on session.failed", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession([
      {
        type: "session.failed",
        data: { error: "boom" },
      },
    ]);

    await drainSessionToTelegram(session, 99, { sendMessage });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(99, TELEGRAM_SESSION_FAILED_REPLY);
  });

  it("ignores event types that are not user-facing", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession([
      { type: "session.started", data: {} },
      { type: "turn.started", data: {} },
      { type: "reasoning.completed", data: { reasoning: "…" } },
      { type: "step.completed", data: {} },
      { type: "turn.completed", data: {} },
      { type: "session.completed", data: {} },
    ]);

    await drainSessionToTelegram(session, 7, { sendMessage });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("logs and swallows errors thrown by getEventStream", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const session: Session = {
      id: "sess_err",
      continuationToken: "tg:1",
      async getEventStream() {
        throw new Error("stream unavailable");
      },
    } as unknown as Session;

    await expect(
      drainSessionToTelegram(session, 1, { sendMessage, logError }),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toBe("telegram outbound drain failed");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("logs and swallows errors thrown by sendMessage mid-stream", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Bot API 502"));
    const logError = vi.fn();
    const session = makeSession([
      {
        type: "message.completed",
        data: {
          message: "first",
          finishReason: "stop",
          sequence: 0,
          stepIndex: 0,
          turnId: "t1",
        },
      },
      {
        type: "message.completed",
        data: {
          message: "second",
          finishReason: "stop",
          sequence: 1,
          stepIndex: 0,
          turnId: "t1",
        },
      },
    ]);

    await drainSessionToTelegram(session, 42, { sendMessage, logError });

    // First send throws → drain aborts and logs. The second message
    // never gets posted because the failure puts us into the catch
    // branch. This is the same shape as the spike's original loop.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("releases the reader lock even on a clean close", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const stream = new ReadableStream<StreamEvent>({
      start(controller) {
        controller.enqueue({
          type: "message.completed",
          data: {
            message: "hi",
            finishReason: "stop",
            sequence: 0,
            stepIndex: 0,
            turnId: "t1",
          },
        });
        controller.close();
      },
    });
    const session: Session = {
      id: "sess_lock",
      continuationToken: "tg:1",
      async getEventStream() {
        return stream;
      },
    } as unknown as Session;

    await drainSessionToTelegram(session, 1, { sendMessage });

    // If `releaseLock()` didn't run, this `getReader()` would throw
    // "ReadableStream is locked".
    expect(() => stream.getReader()).not.toThrow();
  });
});
