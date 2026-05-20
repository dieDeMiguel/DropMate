import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  describe("default sendMessage (no spy)", () => {
    const fetchMock = vi.fn();
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = originalToken;
      }
    });

    it("uses deps.token when supplied, ignoring the env var", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "env-token-should-be-ignored";
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      const session = makeSession([
        {
          type: "message.completed",
          data: {
            message: "hi",
            finishReason: "stop",
            sequence: 0,
            stepIndex: 0,
            turnId: "t1",
          },
        },
      ]);

      await drainSessionToTelegram(session, 42, { token: "explicit-token" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        "https://api.telegram.org/botexplicit-token/sendMessage",
      );
    });

    it("falls back to TELEGRAM_BOT_TOKEN when deps.token is omitted", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "env-fallback-token";
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      const session = makeSession([
        {
          type: "message.completed",
          data: {
            message: "hi",
            finishReason: "stop",
            sequence: 0,
            stepIndex: 0,
            turnId: "t1",
          },
        },
      ]);

      await drainSessionToTelegram(session, 42);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        "https://api.telegram.org/botenv-fallback-token/sendMessage",
      );
    });

    it("logs and swallows when neither deps.token nor env is set", async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const logError = vi.fn();
      const session = makeSession([
        {
          type: "message.completed",
          data: {
            message: "hi",
            finishReason: "stop",
            sequence: 0,
            stepIndex: 0,
            turnId: "t1",
          },
        },
      ]);

      await expect(
        drainSessionToTelegram(session, 42, { logError }),
      ).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0]?.[0]).toBe(
        "telegram outbound drain failed",
      );
    });
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

describe("drainSessionToTelegram — trace integration (#59)", () => {
  // Dynamic import for the tracer so the test file doesn't leak
  // top-level bus listeners into the global scope.
  async function recordEventsInside<T>(
    fn: () => Promise<T>,
  ): Promise<{ events: Array<{ stage: string; phase: string; extras?: Record<string, unknown> }>; result: T }> {
    const { runWithTrace, subscribe } = await import("../trace.js");
    const events: Array<{ stage: string; phase: string; extras?: Record<string, unknown> }> = [];
    const unsubscribe = subscribe((e) => {
      if (e.traceId !== "trace_drain") return;
      events.push({ stage: e.stage, phase: e.phase, extras: e.extras as Record<string, unknown> | undefined });
    });
    try {
      const result = await runWithTrace(
        { traceId: "trace_drain", kind: "text" },
        fn,
      );
      return { events, result };
    } finally {
      unsubscribe();
    }
  }

  it("emits drain.start + drain.end + outbound.start/end around sendMessage", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession([
      {
        type: "message.completed",
        data: {
          message: "Hallo",
          finishReason: "stop",
          sequence: 0,
          stepIndex: 0,
          turnId: "t1",
        },
      },
    ]);

    const { events } = await recordEventsInside(() =>
      drainSessionToTelegram(session, 42, { sendMessage }),
    );

    expect(events.map((e) => `${e.stage}.${e.phase}`)).toEqual([
      "drain.start",
      "outbound.start",
      "outbound.end",
      "drain.end",
    ]);
    expect(sendMessage).toHaveBeenCalledWith(42, "Hallo");
  });

  it("emits tool.start for each action in an actions.requested batch", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession([
      {
        type: "actions.requested",
        data: {
          actions: [
            { id: "call_1", toolName: "register_package" },
            { id: "call_2", toolName: "notify_recipient" },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "t1",
        },
      },
    ]);

    const { events } = await recordEventsInside(() =>
      drainSessionToTelegram(session, 1, { sendMessage }),
    );

    const tools = events.filter((e) => e.stage === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      stage: "tool",
      phase: "start",
      extras: { name: "register_package", id: "call_1" },
    });
    expect(tools[1]).toMatchObject({
      stage: "tool",
      phase: "start",
      extras: { name: "notify_recipient", id: "call_2" },
    });
  });

  it("emits tool.end on action.result with the matching toolName + status", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const session = makeSession([
      {
        type: "action.result",
        data: {
          result: { toolCallId: "call_1", toolName: "register_package" },
          status: "completed",
          sequence: 0,
          stepIndex: 0,
          turnId: "t1",
        },
      },
    ]);

    const { events } = await recordEventsInside(() =>
      drainSessionToTelegram(session, 1, { sendMessage }),
    );

    const toolEnd = events.find((e) => e.stage === "tool" && e.phase === "end");
    expect(toolEnd).toBeDefined();
    expect(toolEnd!.extras).toMatchObject({
      name: "register_package",
      id: "call_1",
      status: "completed",
    });
  });

  it("emits drain.error when getEventStream throws", async () => {
    const sendMessage = vi.fn();
    const logError = vi.fn();
    const session: Session = {
      id: "sess_err",
      continuationToken: "tg:1",
      async getEventStream() {
        throw new Error("stream unavailable");
      },
    } as unknown as Session;

    const { events } = await recordEventsInside(() =>
      drainSessionToTelegram(session, 1, { sendMessage, logError }),
    );

    expect(events.map((e) => `${e.stage}.${e.phase}`)).toEqual([
      "drain.start",
      "drain.error",
    ]);
  });

  it("is silent when called outside any runWithTrace scope", async () => {
    const { subscribe } = await import("../trace.js");
    const events: unknown[] = [];
    const unsubscribe = subscribe((e) => events.push(e));

    try {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const session = makeSession([
        {
          type: "message.completed",
          data: {
            message: "hi",
            finishReason: "stop",
            sequence: 0,
            stepIndex: 0,
            turnId: "t1",
          },
        },
      ]);

      // No `runWithTrace` — drain must run cleanly + emit nothing.
      await drainSessionToTelegram(session, 42, { sendMessage });
      expect(events).toEqual([]);
      expect(sendMessage).toHaveBeenCalledWith(42, "hi");
    } finally {
      unsubscribe();
    }
  });
});
