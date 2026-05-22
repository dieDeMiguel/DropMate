/**
 * Live-diagram SSE route — re-applied on v2.1 per #99.
 *
 * `/api/trace` streams every trace event from the in-process bus
 * (`lib/trace.ts`) to the connected browser. The booth-demo page
 * (restored in #102) consumes this stream via `EventSource` and
 * re-renders the diagram on each message.
 *
 * The route is scoped to the Telegram channel rather than factored
 * into a sibling channel because the diagram exists to visualise
 * the Telegram webhook pipeline — coupling them keeps the demo
 * self-contained and lets the factory mount it without an
 * extra Vercel function.
 */

import { subscribe, type TraceEvent } from "../trace.js";

/**
 * Streaming SSE response. Each subscribed event is encoded as a single
 * `data:` line with a JSON payload, followed by a blank line per the
 * SSE spec.
 *
 * The stream stays open until the client disconnects (Vercel imposes a
 * 300s function timeout on streaming responses). When the stream
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
