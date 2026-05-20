/**
 * Live-diagram routes — #58 first-light tracer, #59 V1 booth-ready cut.
 *
 * Two GET handlers that piggy-back on the Telegram channel's route
 * table (no separate Vercel function, no extra build step):
 *
 *   - `/api/trace` — Server-Sent Events stream. Subscribes to the
 *     in-process trace bus and forwards every event to the client as a
 *     `data:` line. The browser opens this with `EventSource(...)` and
 *     re-renders the diagram on each message.
 *
 *   - `/` — static HTML page with the SVG and the EventSource glue.
 *     Returning HTML inline (instead of a `public/` directory) sidesteps
 *     Nitro static-file configuration; #62 may graduate this to a real
 *     `public/index.html` once the diagram outgrows a string literal.
 *
 * Both routes are intentionally scoped to this channel rather than
 * factored into a sibling channel: the diagram exists to visualise the
 * Telegram webhook pipeline, so coupling them keeps the demo
 * self-contained.
 *
 * V1 layout (#59) — 8 architectural boxes wired together with PCB-style
 * right-angle cables. The animation engine consumes the trace events
 * the orchestrator + outbound drain emit and lights up each box +
 * cable in sequence:
 *
 *   webhook.start    → webhook box
 *   orchestrator.*   → orchestrator box
 *   parse_label.*    → parse_label box (photo path only; idle on text)
 *   ash_send.*       → ash session box
 *   tool.*           → tools box (sub-cells in #61)
 *   drain.*          → ash session stays bright while drain runs
 *   outbound.*       → outbound back to telegram
 *
 * Telegram + Redis + AI Gateway sit at the edges as static "destination"
 * boxes — the diagram still wires cables to them so visitors can see
 * the full system shape, but they don't fire their own events.
 */

import { subscribe, type TraceEvent } from "../trace.js";

/**
 * Streaming SSE response. Each subscribed event is encoded as a single
 * `data:` line with a JSON payload, followed by a blank line per the
 * SSE spec.
 *
 * The stream stays open until the client disconnects (Vercel imposes a
 * 300s function timeout on streaming responses — #62 hardens the
 * client-side `EventSource` reconnect behaviour). When the stream
 * closes, we unsubscribe so the bus doesn't leak listeners.
 */
export function handleTraceSseRequest(req: Request): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      // Emit a single comment line on connect so the browser's
      // `EventSource.onopen` fires immediately, even if no trace
      // events have arrived yet. Comments are ignored by EventSource's
      // default `message` listener, so this is a pure liveness signal.
      controller.enqueue(encoder.encode(": connected\n\n"));

      const unsubscribe = subscribe((event: TraceEvent) => {
        try {
          const payload = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Controller may have been closed by an abort handler racing
          // with an in-flight emit. Swallow — the unsubscribe in the
          // abort handler will run regardless.
        }
      });

      // Heartbeat every 25s so intermediaries (Vercel, browsers) don't
      // idle-close the stream before the function's 300s ceiling. SSE
      // comments are spec-blessed keep-alives.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);
      // Don't keep the process alive solely to send heartbeats.
      if (typeof (heartbeat as { unref?: () => void }).unref === "function") {
        (heartbeat as { unref: () => void }).unref();
      }

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Vercel's edge can buffer SSE without this. Belt-and-braces
      // alongside the explicit `no-transform`.
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
