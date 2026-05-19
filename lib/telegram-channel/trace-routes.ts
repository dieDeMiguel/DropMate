/**
 * Live-diagram routes — #58 first-light tracer.
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
 *     Nitro static-file configuration for this smoke-test slice; #59
 *     replaces the inline HTML with a real `public/index.html` once the
 *     diagram outgrows a string literal.
 *
 * Both routes are intentionally scoped to this channel rather than
 * factored into a sibling channel: the diagram exists to visualise the
 * Telegram webhook pipeline, so coupling them keeps the demo
 * self-contained.
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

/**
 * The first-light HTML page. Single box, one EventSource, the
 * minimum viable proof that the trace pipeline works end-to-end.
 *
 * Kept as a TypeScript template literal for now so we don't need
 * Nitro public-asset wiring. #59 will graduate this to a real file
 * under `public/` when the diagram grows beyond ~80 lines of markup.
 */
const FIRST_LIGHT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DropMate — live diagram</title>
  <style>
    :root {
      --bg: #0a0a14;
      --idle: #2a2a3a;
      --ignite: #00e5ff;
    }
    html, body { margin: 0; padding: 0; background: var(--bg); color: #e6e6f0; font-family: ui-monospace, "SF Mono", Menlo, monospace; height: 100%; }
    body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5rem; }
    h1 { font-size: 1rem; letter-spacing: 0.2em; text-transform: uppercase; color: #6a6a8a; font-weight: 500; }
    svg { width: 360px; height: 200px; }
    rect.box {
      fill: transparent;
      stroke: var(--idle);
      stroke-width: 2;
      transition: stroke 200ms ease, filter 200ms ease;
    }
    rect.box.ignite {
      stroke: var(--ignite);
      filter: drop-shadow(0 0 12px var(--ignite));
    }
    text.label { fill: #6a6a8a; font-size: 14px; letter-spacing: 0.15em; text-transform: uppercase; }
    text.label.ignite { fill: var(--ignite); }
    .status { font-size: 0.75rem; color: #6a6a8a; }
    .status.connected { color: #00e5ff; }
  </style>
</head>
<body>
  <h1>DropMate — first light</h1>
  <svg viewBox="0 0 360 200" role="img" aria-label="trace pipeline">
    <rect class="box" id="box" x="60" y="50" width="240" height="100" rx="8" />
    <text class="label" id="label" x="180" y="105" text-anchor="middle">webhook</text>
  </svg>
  <div class="status" id="status">connecting…</div>
  <script>
    (() => {
      const box = document.getElementById("box");
      const label = document.getElementById("label");
      const status = document.getElementById("status");
      const source = new EventSource("/api/trace");
      let fadeTimer = null;

      source.addEventListener("open", () => {
        status.textContent = "live";
        status.classList.add("connected");
      });

      source.addEventListener("error", () => {
        status.textContent = "reconnecting…";
        status.classList.remove("connected");
      });

      source.addEventListener("message", (e) => {
        let event;
        try { event = JSON.parse(e.data); } catch { return; }
        box.classList.add("ignite");
        label.classList.add("ignite");
        label.textContent = event.stage + "." + event.phase;
        if (fadeTimer) clearTimeout(fadeTimer);
        fadeTimer = setTimeout(() => {
          box.classList.remove("ignite");
          label.classList.remove("ignite");
          label.textContent = "webhook";
        }, 600);
      });
    })();
  </script>
</body>
</html>
`;

export function handleFirstLightPageRequest(): Response {
  return new Response(FIRST_LIGHT_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
