/**
 * Dev-only trace seed endpoint tests (#104, extended in #125).
 *
 * The handler walks three branches: production gate (`X-Demo-Token`
 * vs `DEMO_TRACE_TOKEN`), input validation (400 on bad JSON / missing
 * fields), and the happy path (204 + event lands on the trace bus).
 * The bus assertions use the real `subscribe` rather than a mocked
 * emitter — the whole point of the dev seed is that it exercises the
 * same code path as the production webhook.
 */

import { afterEach, describe, expect, it } from "vitest";

import { subscribe, type TraceEvent } from "../trace.js";

import { handleTraceDevEmitRequest } from "./trace-dev-routes.js";

function postJson(body: unknown, extraHeaders?: Record<string, string>): Request {
  return new Request("http://localhost/api/trace/dev/emit", {
    method: "POST",
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  });
}

describe("handleTraceDevEmitRequest", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalToken = process.env.DEMO_TRACE_TOKEN;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalToken === undefined) {
      delete process.env.DEMO_TRACE_TOKEN;
    } else {
      process.env.DEMO_TRACE_TOKEN = originalToken;
    }
  });

  it("returns 404 in production when no X-Demo-Token is sent", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEMO_TRACE_TOKEN = "expected-token";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson({ stage: "registration", phase: "start" }),
      );

      expect(res.status).toBe(404);
      // The 404 branch must short-circuit BEFORE emitTrace runs —
      // otherwise a prod deploy could be probed to inject diagram noise.
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("returns 404 in production when X-Demo-Token doesn't match", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEMO_TRACE_TOKEN = "expected-token";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson(
          { stage: "registration", phase: "start" },
          { "X-Demo-Token": "wrong-token" },
        ),
      );

      expect(res.status).toBe(404);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("returns 204 + emits in production when X-Demo-Token matches", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEMO_TRACE_TOKEN = "expected-token";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson(
          { stage: "schedule", phase: "fire", kind: "text", traceId: "demo-1" },
          { "X-Demo-Token": "expected-token" },
        ),
      );

      expect(res.status).toBe(204);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        stage: "schedule",
        phase: "fire",
        traceId: "demo-1",
        kind: "text",
      });
    } finally {
      unsubscribe();
    }
  });

  it("returns 404 in production when DEMO_TRACE_TOKEN env is unset, even with a header", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DEMO_TRACE_TOKEN;

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      // An attacker probing the URL with a guessed header must not be
      // able to tell "this endpoint exists but is misconfigured" apart
      // from "this endpoint doesn't exist".
      const res = await handleTraceDevEmitRequest(
        postJson(
          { stage: "channel", phase: "start" },
          { "X-Demo-Token": "anything" },
        ),
      );

      expect(res.status).toBe(404);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("404 body is byte-identical across the prod-no-header, prod-wrong-token, and prod-no-env paths", async () => {
    process.env.NODE_ENV = "production";

    process.env.DEMO_TRACE_TOKEN = "expected-token";
    const noHeader = await handleTraceDevEmitRequest(
      postJson({ stage: "channel", phase: "start" }),
    );
    const wrongHeader = await handleTraceDevEmitRequest(
      postJson(
        { stage: "channel", phase: "start" },
        { "X-Demo-Token": "wrong" },
      ),
    );

    delete process.env.DEMO_TRACE_TOKEN;
    const noEnv = await handleTraceDevEmitRequest(
      postJson(
        { stage: "channel", phase: "start" },
        { "X-Demo-Token": "anything" },
      ),
    );

    const [bodyA, bodyB, bodyC] = await Promise.all([
      noHeader.text(),
      wrongHeader.text(),
      noEnv.text(),
    ]);

    // All three error paths must look the same to an outsider — the
    // body must not say "unauthorized", "forbidden", or anything that
    // hints at authentication. Plain "Not Found" matches a generic
    // route-not-found 404.
    expect(bodyA).toBe("Not Found");
    expect(bodyB).toBe("Not Found");
    expect(bodyC).toBe("Not Found");
  });

  it("ignores X-Demo-Token outside production (permissive dev path)", async () => {
    // Dev/test/Docker hosts don't require the token. Passing one
    // (e.g. when the same seed script is used against dev + prod)
    // is harmless — the handler should not 404 on a stray header.
    process.env.NODE_ENV = "development";
    process.env.DEMO_TRACE_TOKEN = "expected-token";

    const received: TraceEvent[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    try {
      const res = await handleTraceDevEmitRequest(
        postJson(
          { stage: "channel", phase: "start" },
          { "X-Demo-Token": "totally-different-token" },
        ),
      );

      expect(res.status).toBe(204);
      expect(received).toHaveLength(1);
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
