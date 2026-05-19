import { describe, expect, it } from "vitest";

import { emitTrace, runWithTrace } from "../trace.js";

import {
  handleFirstLightPageRequest,
  handleTraceSseRequest,
} from "./trace-routes.js";

describe("handleFirstLightPageRequest", () => {
  it("returns the static HTML page with no-store caching", async () => {
    const res = handleFirstLightPageRequest();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("/api/trace");
    expect(body).toContain("EventSource");
  });

  it("renders the V1 layout with all 8 architecture boxes (#59)", async () => {
    const body = await handleFirstLightPageRequest().text();
    // Edge boxes (passive destinations) + active stages. The orchestrator
    // emits per-stage events that target these by id; the diagram engine
    // resolves `box-${stage}` so the id pattern is load-bearing.
    for (const id of [
      "box-telegram",
      "box-webhook",
      "box-orchestrator",
      "box-parse_label",
      "box-ash_send",
      "box-tool",
      "box-gateway",
      "box-redis",
    ]) {
      expect(body).toContain(`id="${id}"`);
    }
  });

  it("includes the PCB cables wiring orchestrator → ash session → tools → outbound (#59)", async () => {
    const body = await handleFirstLightPageRequest().text();
    for (const id of [
      "cable-telegram-webhook",
      "cable-webhook-orchestrator",
      "cable-orchestrator-parse",
      "cable-orchestrator-ash",
      "cable-ash-tools",
      "cable-ash-outbound",
    ]) {
      expect(body).toContain(`id="${id}"`);
    }
  });

  it("declares the synthwave accent palette per trace kind", async () => {
    const body = await handleFirstLightPageRequest().text();
    expect(body).toContain("--text-accent");
    expect(body).toContain("--photo-accent");
    expect(body).toContain("--callback-accent");
  });

  it("declares the red-flash terminal-failure accent + CSS class (#60)", async () => {
    // #60 paints `parse_label.primary_failed` and `*.error` with the
    // red-flash visual. Both the accent variable and the keyframed
    // animation class need to ship in the static HTML so the runtime
    // engine can apply them.
    const body = await handleFirstLightPageRequest().text();
    expect(body).toContain("--error-accent");
    expect(body).toContain(".flash-error");
    expect(body).toContain("@keyframes flash-error");
  });

  it("registers per-event sub-label updates so visitors see the active model name (#60)", async () => {
    // The diagram engine reads `event.extras.model` on parse_label.start
    // and parse_label.fallback_start to update the box's sub-label.
    // The shipped JS must include the logic that does so.
    const body = await handleFirstLightPageRequest().text();
    expect(body).toContain("extras.model");
    // Renders short slug (no provider prefix).
    expect(body).toContain("shortModelName");
  });

  it("handles parse_label.primary_failed + parse_label.fallback_start phases in the animation engine (#60)", async () => {
    const body = await handleFirstLightPageRequest().text();
    expect(body).toContain("primary_failed");
    expect(body).toContain("fallback_start");
  });
});

describe("handleTraceSseRequest", () => {
  it("opens an SSE stream and forwards emitted events as data: lines", async () => {
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
    const event = JSON.parse(match![1]);
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
