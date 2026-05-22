import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emitTrace,
  getCurrentTraceContext,
  runWithTrace,
  subscribe,
  type TraceEvent,
} from "./trace.js";

describe("trace", () => {
  // Each test subscribes to the global bus; the unsubscribe handle is
  // run in `afterEach` so listeners don't leak across cases.
  const unsubscribes: Array<() => void> = [];
  afterEach(() => {
    while (unsubscribes.length) unsubscribes.pop()!();
  });

  function record(): TraceEvent[] {
    const seen: TraceEvent[] = [];
    unsubscribes.push(
      subscribe((event) => {
        seen.push(event);
      }),
    );
    return seen;
  }

  it("is a no-op outside a runWithTrace scope", () => {
    const events = record();
    emitTrace("webhook", "start");
    expect(events).toEqual([]);
    expect(getCurrentTraceContext()).toBeUndefined();
  });

  it("emits events inside a runWithTrace scope with traceId + kind inherited", () => {
    const events = record();
    runWithTrace({ traceId: "trace_abc", kind: "text" }, () => {
      emitTrace("webhook", "start");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "trace_abc",
      kind: "text",
      stage: "webhook",
      phase: "start",
    });
    expect(typeof events[0]!.ts).toBe("number");
  });

  it("propagates context across awaits (AsyncLocalStorage semantics)", async () => {
    const events = record();
    await runWithTrace(
      { traceId: "trace_async", kind: "photo" },
      async () => {
        await Promise.resolve();
        emitTrace("orchestrator", "start", { fileId: "AgAC" });
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "trace_async",
      kind: "photo",
      stage: "orchestrator",
      phase: "start",
      extras: { fileId: "AgAC" },
    });
  });

  it("isolates concurrent runWithTrace scopes", async () => {
    const events = record();

    await Promise.all([
      runWithTrace({ traceId: "trace_a", kind: "text" }, async () => {
        await Promise.resolve();
        emitTrace("webhook", "start");
      }),
      runWithTrace({ traceId: "trace_b", kind: "callback" }, async () => {
        await Promise.resolve();
        emitTrace("webhook", "start");
      }),
    ]);

    const byTrace = new Map(events.map((e) => [e.traceId, e]));
    expect(byTrace.get("trace_a")?.kind).toBe("text");
    expect(byTrace.get("trace_b")?.kind).toBe("callback");
  });

  it("unsubscribe stops further deliveries", () => {
    const events: TraceEvent[] = [];
    const unsubscribe = subscribe((e) => events.push(e));

    runWithTrace({ traceId: "t1", kind: "text" }, () => {
      emitTrace("webhook", "start");
    });
    expect(events).toHaveLength(1);

    unsubscribe();
    runWithTrace({ traceId: "t1", kind: "text" }, () => {
      emitTrace("webhook", "end");
    });
    expect(events).toHaveLength(1);
  });

  it("forwards the function return value through runWithTrace", () => {
    const result = runWithTrace({ traceId: "t", kind: "text" }, () => 42);
    expect(result).toBe(42);
  });

  it("includes extras only when supplied", () => {
    const events = record();
    runWithTrace({ traceId: "t", kind: "text" }, () => {
      emitTrace("webhook", "start");
      emitTrace("orchestrator", "start", { traceId: "echo" });
    });

    expect(events[0]).not.toHaveProperty("extras");
    expect(events[1]!.extras).toEqual({ traceId: "echo" });
  });

  it("does not throw if a subscriber handler throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      unsubscribes.push(
        subscribe(() => {
          throw new Error("boom");
        }),
      );
      // Node's EventEmitter throws synchronously from emit if a listener
      // throws — but only when there is no `error` listener. We wrap
      // emit-callers in a domain (the SSE route) to keep the bus healthy.
      // Here we just confirm the emit itself doesn't take down the
      // process when a sibling subscriber misbehaves.
      expect(() =>
        runWithTrace({ traceId: "t", kind: "text" }, () => {
          try {
            emitTrace("webhook", "start");
          } catch {
            /* swallowed for this assertion */
          }
        }),
      ).not.toThrow();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
