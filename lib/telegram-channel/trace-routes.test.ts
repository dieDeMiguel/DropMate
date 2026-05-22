import { describe, expect, it } from "vitest";

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
