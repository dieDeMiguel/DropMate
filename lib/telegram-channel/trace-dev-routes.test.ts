/**
 * Dev-only trace seed endpoint tests (#104).
 *
 * The handler walks three branches: production short-circuit (404),
 * input validation (400 on bad JSON / missing fields), and the happy
 * path (204 + event lands on the trace bus). The bus assertions use
 * the real `subscribe` rather than a mocked emitter — the whole point
 * of the dev seed is that it exercises the same code path as the
 * production webhook.
 */

import { afterEach, describe, expect, it } from "vitest";

import { subscribe, type TraceEvent } from "../trace.js";

import { handleTraceDevEmitRequest } from "./trace-dev-routes.js";

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/trace/dev/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleTraceDevEmitRequest", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("returns 404 in production without touching the bus", async () => {
    process.env.NODE_ENV = "production";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson({ stage: "registration", phase: "start" }),
      );

      expect(res.status).toBe(404);
      // The 404 branch must short-circuit BEFORE emitTrace runs —
      // otherwise a prod deploy with NODE_ENV unset could be probed
      // to inject diagram noise.
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("emits a trace event on the bus in dev (204 No Content)", async () => {
    process.env.NODE_ENV = "development";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson({
          stage: "registration",
          phase: "start",
          traceId: "seed-1",
          kind: "text",
          extras: { src: "seed-script" },
        }),
      );

      expect(res.status).toBe(204);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        traceId: "seed-1",
        kind: "text",
        stage: "registration",
        phase: "start",
        extras: { src: "seed-script" },
      });
    } finally {
      unsubscribe();
    }
  });

  it("generates a traceId and defaults kind to text when omitted", async () => {
    process.env.NODE_ENV = "development";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson({ stage: "channel", phase: "start" }),
      );

      expect(res.status).toBe(204);
      expect(received).toHaveLength(1);
      expect(received[0]?.kind).toBe("text");
      expect(typeof received[0]?.traceId).toBe("string");
      expect(received[0]?.traceId.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it("returns 400 on malformed JSON without emitting", async () => {
    process.env.NODE_ENV = "development";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const req = new Request("http://localhost/api/trace/dev/emit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });

      const res = await handleTraceDevEmitRequest(req);

      expect(res.status).toBe(400);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("returns 400 when stage is missing or empty", async () => {
    process.env.NODE_ENV = "development";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const missing = await handleTraceDevEmitRequest(
        postJson({ phase: "start" }),
      );
      const empty = await handleTraceDevEmitRequest(
        postJson({ stage: "", phase: "start" }),
      );

      expect(missing.status).toBe(400);
      expect(empty.status).toBe(400);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("returns 400 when phase is missing or empty", async () => {
    process.env.NODE_ENV = "development";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const missing = await handleTraceDevEmitRequest(
        postJson({ stage: "channel" }),
      );
      const empty = await handleTraceDevEmitRequest(
        postJson({ stage: "channel", phase: "" }),
      );

      expect(missing.status).toBe(400);
      expect(empty.status).toBe(400);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("falls back to kind=text when kind is not one of the supported values", async () => {
    process.env.NODE_ENV = "development";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson({ stage: "channel", phase: "start", kind: "bogus-kind" }),
      );

      expect(res.status).toBe(204);
      expect(received[0]?.kind).toBe("text");
    } finally {
      unsubscribe();
    }
  });

  it("accepts photo and callback kinds verbatim", async () => {
    process.env.NODE_ENV = "development";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      await handleTraceDevEmitRequest(
        postJson({ stage: "vision", phase: "start", kind: "photo" }),
      );
      await handleTraceDevEmitRequest(
        postJson({ stage: "flow2", phase: "accept.start", kind: "callback" }),
      );

      expect(received.map((e) => e.kind)).toEqual(["photo", "callback"]);
    } finally {
      unsubscribe();
    }
  });

  it("drops extras that aren't a plain object", async () => {
    process.env.NODE_ENV = "development";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      // Arrays + scalars are not Record-shaped — the handler must not
      // forward them as `extras` because the SSE consumer assumes a
      // record.
      await handleTraceDevEmitRequest(
        postJson({ stage: "channel", phase: "start", extras: ["a", "b"] }),
      );
      await handleTraceDevEmitRequest(
        postJson({ stage: "channel", phase: "start", extras: "scalar" }),
      );

      expect(received).toHaveLength(2);
      expect(received[0]?.extras).toBeUndefined();
      expect(received[1]?.extras).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("treats NODE_ENV undefined as permissive (matches Docker / custom hosts)", async () => {
    // Hosts that don't set NODE_ENV would otherwise hit a hard-to-debug
    // 404 — the seed script and the docs would both lie. The handler
    // is permissive when NODE_ENV is unset; operators who want to lock
    // it down set NODE_ENV=production.
    delete process.env.NODE_ENV;

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson({ stage: "channel", phase: "start" }),
      );

      expect(res.status).toBe(204);
      expect(received).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});
