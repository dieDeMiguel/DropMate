/**
 * Dev-only synthetic trace seed (#104).
 *
 * `POST /api/trace/dev/emit` lets the booth-demo diagram light up
 * without real Telegram traffic. In `pnpm dev`, the bot's webhook
 * still points at the production deploy, so localhost gets zero
 * inbound updates — making it impossible to iterate on box layout,
 * cable timing, or ignite/heartbeat tuning. This endpoint forwards
 * a JSON-described trace event onto the same in-process bus the
 * real webhook uses, so the diagram (which subscribes via
 * `/api/trace`) renders it identically to a production event.
 *
 * Production guard: returns 404 when `process.env.NODE_ENV` is
 * `"production"`. The route stays mounted unconditionally so the
 * factory shape doesn't fork on NODE_ENV; the handler short-circuits
 * instead. Deployments that don't set NODE_ENV (custom hosts, Docker)
 * default to permissive — the assumption is that anything serving
 * traffic publicly should set `NODE_ENV=production`.
 *
 * Request body shape:
 *
 *   {
 *     "stage":   "registration",     // required string
 *     "phase":   "start",            // required string
 *     "traceId": "trace_seed_1",     // optional; one is generated if absent
 *     "kind":    "text",             // optional; defaults to "text"
 *     "extras":  { "src": "seed" }   // optional record passed through verbatim
 *   }
 *
 * The handler wraps `emitTrace` in a fresh `runWithTrace` scope so the
 * event lands on the bus (emitTrace is a no-op outside a scope). One
 * scope per request is fine: a typical seed run fires events serially
 * and the diagram already groups inbound events by `traceId`.
 *
 * @see scripts/seed-diagram.sh — the canonical seed sequence
 * @see lib/telegram-channel/trace-routes.ts — the SSE consumer side
 */

import { emitTrace, runWithTrace, type TraceKind } from "../trace.js";

const VALID_KINDS: ReadonlyArray<TraceKind> = ["text", "photo", "callback"];

interface DevEmitBody {
  readonly stage: string;
  readonly phase: string;
  readonly traceId?: string;
  readonly kind?: TraceKind;
  readonly extras?: Readonly<Record<string, unknown>>;
}

/**
 * Handle a dev-emit POST. Returns 404 in production, 400 on malformed
 * input, 204 on success. The body is intentionally permissive: any
 * `stage` / `phase` string is accepted, including ones the diagram
 * has no matching box for (the diagram silently drops unknown stages,
 * so a typo is self-correcting).
 */
export async function handleTraceDevEmitRequest(
  req: Request,
): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not Found", { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  if (!body || typeof body !== "object") {
    return jsonError(400, "body must be a JSON object");
  }
  const candidate = body as Record<string, unknown>;
  const stage = candidate.stage;
  const phase = candidate.phase;
  if (typeof stage !== "string" || stage.length === 0) {
    return jsonError(400, "stage must be a non-empty string");
  }
  if (typeof phase !== "string" || phase.length === 0) {
    return jsonError(400, "phase must be a non-empty string");
  }

  const rawTraceId = candidate.traceId;
  const traceId =
    typeof rawTraceId === "string" && rawTraceId.length > 0
      ? rawTraceId
      : crypto.randomUUID().slice(0, 8);

  const rawKind = candidate.kind;
  const kind: TraceKind =
    typeof rawKind === "string" && (VALID_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as TraceKind)
      : "text";

  const rawExtras = candidate.extras;
  const extras =
    rawExtras && typeof rawExtras === "object" && !Array.isArray(rawExtras)
      ? (rawExtras as Readonly<Record<string, unknown>>)
      : undefined;

  runWithTrace({ traceId, kind }, () => {
    emitTrace(stage, phase, extras);
  });

  return new Response(null, { status: 204 });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
