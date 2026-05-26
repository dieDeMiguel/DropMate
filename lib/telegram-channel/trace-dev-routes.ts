/**
 * Dev-only synthetic trace seed (#104, extended in #125 for prod demo use).
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
 * Production access is gated by an `X-Demo-Token` header (#125). When
 * `NODE_ENV === "production"`:
 *
 *   - If `DEMO_TRACE_TOKEN` env var is unset → 404 (we can't authenticate
 *     so we can't allow the call; treat the endpoint as nonexistent).
 *   - If the `X-Demo-Token` header is missing or doesn't match → 404.
 *   - If it matches → proceed exactly as the dev path does.
 *
 * The 404 response is a plain `"Not Found"` body — byte-identical for
 * the prod-no-token path and the prod-wrong-token path — so an
 * outsider probing the URL can't tell whether an authenticated
 * endpoint exists. Schedules `defineSchedule` and other primitives
 * never expose existence either, so the diagram demo endpoint
 * shouldn't be the exception.
 *
 * Outside production (NODE_ENV unset, "development", "test", Docker
 * builds without an explicit env), the endpoint stays permissive —
 * no token required — so the local `pnpm seed-diagram` flow keeps
 * working as it did pre-#125.
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
 * Blast radius if `DEMO_TRACE_TOKEN` leaks: an attacker can pollute
 * the booth-demo diagram's visible trace log for the duration of
 * their session. No Redis writes, no Telegram sends, no Package or
 * ReceptionRequest mutations — the endpoint's only side-effect is
 * `getBus().emit("trace", …)`. Recoverable by a page reload.
 *
 * @see scripts/seed-diagram.sh — the canonical seed sequence (sends header)
 * @see docs/booth-demo.md — operator docs for `DEMO_TRACE_TOKEN`
 * @see lib/telegram-channel/trace-routes.ts — the SSE consumer side
 */

import { emitTrace, runWithTrace, type TraceKind } from "../trace.js";

const DEMO_TOKEN_HEADER = "x-demo-token";
const NOT_FOUND_BODY = "Not Found";

const VALID_KINDS: ReadonlyArray<TraceKind> = ["text", "photo", "callback"];

interface DevEmitBody {
  readonly stage: string;
  readonly phase: string;
  readonly traceId?: string;
  readonly kind?: TraceKind;
  readonly extras?: Readonly<Record<string, unknown>>;
}

/**
 * Handle a dev-emit POST. In production: 404 unless `X-Demo-Token`
 * matches `DEMO_TRACE_TOKEN`. Outside production: 400 on malformed
 * input, 204 on success. The body is intentionally permissive: any
 * `stage` / `phase` string is accepted, including ones the diagram
 * has no matching box for (the diagram silently drops unknown stages,
 * so a typo is self-correcting).
 */
export async function handleTraceDevEmitRequest(
  req: Request,
): Promise<Response> {
  if (process.env.NODE_ENV === "production" && !isAuthorizedForProd(req)) {
    return notFound();
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

function notFound(): Response {
  return new Response(NOT_FOUND_BODY, { status: 404 });
}

/**
 * Compare two strings in constant time so a probe can't infer the
 * configured token byte-by-byte from response timing. The blast
 * radius here is small (trace-bus pollution, not data exfil), but
 * a constant-time check is cheap and idiomatic.
 *
 * Returns false immediately on length mismatch — that's not a timing
 * leak because the length of `DEMO_TRACE_TOKEN` isn't a secret worth
 * protecting (any reasonable token is the same length across calls).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorizedForProd(req: Request): boolean {
  const configured = process.env.DEMO_TRACE_TOKEN;
  if (typeof configured !== "string" || configured.length === 0) {
    // No token configured ⇒ no way to authenticate ⇒ treat as nonexistent.
    // Surfacing a 500 ("misconfigured") would leak the route's existence.
    return false;
  }
  const supplied = req.headers.get(DEMO_TOKEN_HEADER);
  if (typeof supplied !== "string" || supplied.length === 0) {
    return false;
  }
  return constantTimeEqual(supplied, configured);
}
