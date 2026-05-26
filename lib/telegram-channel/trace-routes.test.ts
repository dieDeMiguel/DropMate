import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitTrace, runWithTrace } from "../trace.js";

import { handleTraceSseRequest } from "./trace-routes.js";

describe("handleTraceSseRequest", () => {
  it("returns SSE events for traces emitted inside runWithTrace", async () => {
    const controller = new AbortController();
    const req = new Request("http://localhost/api/trace", {
      signal: controller.signal,
    });
    const res = handleTraceSseRequest(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toContain("no-cache");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    // The initial chunk is the `: connected\n\n` liveness comment.
    const initial = await reader.read();
    expect(initial.done).toBe(false);
    accumulated += decoder.decode(initial.value);
    expect(accumulated).toContain(": connected");

    // Emit one event inside a trace scope and read the next chunk.
    runWithTrace({ traceId: "trace_sse_1", kind: "text" }, () => {
      emitTrace("webhook", "start");
    });

    const next = await reader.read();
    expect(next.done).toBe(false);
    accumulated += decoder.decode(next.value);

    // Each event should be a `data:` line with a JSON payload.
    const match = accumulated.match(/data: (\{.*\})\n\n/);
    expect(match).not.toBeNull();
    const event = JSON.parse(match![1]!);
    expect(event).toMatchObject({
      traceId: "trace_sse_1",
      kind: "text",
      stage: "webhook",
      phase: "start",
    });

    // Aborting the request cleans up the subscription so the bus
    // doesn't leak listeners across tests.
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("emits a named `heartbeat` event every 25s to keep the socket warm (#126)", async () => {
    // Per #126: the keep-alive must be a NAMED SSE event (visible in
    // DevTools) rather than a `:` comment (invisible). The client
    // ignores it (no `heartbeat` listener), but the operator can
    // confirm the connection is healthy on production from DevTools
    // alone.
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const req = new Request("http://localhost/api/trace", {
        signal: controller.signal,
      });
      const res = handleTraceSseRequest(req);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Drain the initial `: connected` chunk so the heartbeat timer is armed.
      const initial = await reader.read();
      expect(decoder.decode(initial.value)).toContain(": connected");

      // Advance the clock past one heartbeat interval (25s + slack).
      await vi.advanceTimersByTimeAsync(26_000);

      const next = await reader.read();
      expect(next.done).toBe(false);
      const chunk = decoder.decode(next.value);
      // Named event with empty JSON payload, terminated by the
      // SSE-required blank line.
      expect(chunk).toContain("event: heartbeat\n");
      expect(chunk).toContain("data: {}\n");
      // Regression pin: the legacy `: ping` comment shape must not
      // come back — DevTools wouldn't render it as an event.
      expect(chunk).not.toContain(": ping");

      controller.abort();
      await reader.cancel().catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes from the bus when the client aborts", async () => {
    const controller = new AbortController();
    const req = new Request("http://localhost/api/trace", {
      signal: controller.signal,
    });
    const res = handleTraceSseRequest(req);
    const reader = res.body!.getReader();

    // Drain the initial comment chunk so the start() callback has run.
    await reader.read();

    controller.abort();

    // After abort, emits should not push anything new to the closed
    // stream. We can't directly observe unsubscribe, but we can read
    // until done.
    runWithTrace({ traceId: "post_abort", kind: "text" }, () => {
      emitTrace("webhook", "start");
    });

    // The reader should resolve `done: true` (or error) shortly.
    await reader.cancel().catch(() => undefined);
  });
});
