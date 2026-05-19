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

/**
 * The V1 booth-ready diagram page. Eight boxes laid out top-down to
 * mirror the Excalidraw architecture diagram, wired together with
 * PCB-style cables that animate when trace events arrive.
 *
 * Animation timing (booth-tuned):
 *   - `MIN_HOP_MS = 600`       — visible duration of each box ignite
 *   - `MAX_HOP_MS = 4000`      — cap so a hung backend doesn't freeze
 *   - `INTER_HOP_MS = 200`     — gap between successive box ignitions
 *   - `POST_HOLD_MS = 2000`    — completed path stays bright
 *   - `POST_FADE_MS = 2000`    — gradual fade back to idle
 *   - `IDLE_PULSE_MS = 3000`   — heartbeat cadence at idle
 *
 * Multi-trace: if a second event stream arrives mid-animation it gets
 * queued; the engine works one trace at a time so visitors can follow
 * the visual without seeing two cables run simultaneously.
 *
 * Palette is synthwave: dark background, neon cyan for text traces
 * (photo=amber, callback=magenta added in #60/#61), dim gray for idle.
 * Glow via `filter: drop-shadow()` rather than SVG <filter> elements
 * for cheaper compositing on the booth laptop's GPU.
 */
const LIVE_DIAGRAM_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DropMate — live diagram</title>
  <style>
    :root {
      --bg: #07070d;
      --idle: #2a2a3a;
      --idle-fill: rgba(42, 42, 58, 0.18);
      --text-accent: #00e5ff;
      --photo-accent: #ffb547;
      --callback-accent: #ff5cf2;
      --label: #6a6a8a;
      --label-bright: #d8d8ff;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: #e6e6f0; font-family: ui-monospace, "SF Mono", Menlo, monospace; height: 100%; overflow: hidden; }
    body { display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 1.25rem; }
    h1 { font-size: 0.85rem; letter-spacing: 0.32em; text-transform: uppercase; color: var(--label); font-weight: 500; margin: 0; }
    .stage { width: 100%; max-width: 920px; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
    svg { width: 100%; height: 100%; max-height: 80vh; }

    /* Boxes: idle by default; ignite + post-hold drive their own classes. */
    rect.box {
      fill: var(--idle-fill);
      stroke: var(--idle);
      stroke-width: 2;
      transition: stroke 200ms ease, fill 200ms ease, filter 200ms ease;
    }
    rect.box.ignite {
      stroke: var(--accent, var(--text-accent));
      fill: rgba(0, 229, 255, 0.06);
      filter: drop-shadow(0 0 10px var(--accent, var(--text-accent)));
    }
    rect.box.hold {
      stroke: var(--accent, var(--text-accent));
      filter: drop-shadow(0 0 6px var(--accent, var(--text-accent)));
    }
    /* Heartbeat — subtle breathing pulse when no trace is animating. */
    rect.box.heartbeat {
      animation: heartbeat 3s ease-in-out infinite;
    }
    @keyframes heartbeat {
      0%, 100% { stroke: var(--idle); filter: none; }
      50% { stroke: #3d3d55; filter: drop-shadow(0 0 4px #3d3d55); }
    }
    /* Edge boxes (TELEGRAM / REDIS / AI GATEWAY) are passive destinations.
       Render dimmer so they read as "context" boxes rather than
       active stages. */
    rect.edge { stroke: #1f1f30; }
    rect.edge.heartbeat { animation-duration: 4s; }
    rect.edge.ignite { stroke: var(--accent, var(--text-accent)); fill: rgba(0, 229, 255, 0.04); }

    text.label {
      fill: var(--label);
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      text-anchor: middle;
      font-weight: 500;
      transition: fill 200ms ease;
      pointer-events: none;
    }
    text.label.ignite { fill: var(--label-bright); }
    text.label.hold { fill: var(--label-bright); }
    text.sub {
      fill: var(--label);
      font-size: 9px;
      letter-spacing: 0.12em;
      text-anchor: middle;
      opacity: 0.55;
      pointer-events: none;
    }

    /* PCB cables: dim outline by default; animated stroke-dashoffset
       creates the running-current visual when a cable lights up. */
    path.cable {
      fill: none;
      stroke: var(--idle);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      transition: stroke 200ms ease, filter 200ms ease;
    }
    path.cable.run {
      stroke: var(--accent, var(--text-accent));
      filter: drop-shadow(0 0 6px var(--accent, var(--text-accent)));
      stroke-dasharray: 8 6;
      animation: flow 600ms linear forwards;
    }
    path.cable.hold {
      stroke: var(--accent, var(--text-accent));
      filter: drop-shadow(0 0 4px var(--accent, var(--text-accent)));
    }
    @keyframes flow {
      from { stroke-dashoffset: 28; }
      to { stroke-dashoffset: 0; }
    }

    /* Zone labels — Telegram zone (top), Vercel zone (middle), External
       services zone (bottom). */
    text.zone {
      fill: #3d3d55;
      font-size: 10px;
      letter-spacing: 0.42em;
      text-transform: uppercase;
      text-anchor: start;
      pointer-events: none;
      opacity: 0.7;
    }

    footer { display: flex; justify-content: space-between; align-items: center; width: 100%; max-width: 920px; font-size: 0.7rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--label); }
    .status { color: var(--label); }
    .status.connected { color: var(--text-accent); }
    .status.connected::before { content: "● "; }
    .legend { display: flex; gap: 1.5rem; }
    .legend-item { display: flex; align-items: center; gap: 0.4rem; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; }
    .swatch-text { background: var(--text-accent); box-shadow: 0 0 6px var(--text-accent); }
    .swatch-photo { background: var(--photo-accent); box-shadow: 0 0 6px var(--photo-accent); }
    .swatch-callback { background: var(--callback-accent); box-shadow: 0 0 6px var(--callback-accent); }
  </style>
</head>
<body>
  <h1>DropMate · live diagram</h1>
  <div class="stage">
    <svg viewBox="0 0 920 640" role="img" aria-label="trace pipeline" preserveAspectRatio="xMidYMid meet">
      <!-- Zone labels -->
      <text class="zone" x="20" y="40">Telegram</text>
      <text class="zone" x="20" y="200">Vercel</text>
      <text class="zone" x="20" y="500">External</text>

      <!-- Cables: drawn BEFORE boxes so boxes overlay cable endpoints cleanly. -->
      <!-- TELEGRAM → WEBHOOK -->
      <path class="cable" id="cable-telegram-webhook" d="M460 80 L460 170" />
      <!-- WEBHOOK → ORCHESTRATOR -->
      <path class="cable" id="cable-webhook-orchestrator" d="M460 230 L460 290" />
      <!-- ORCHESTRATOR → PARSE_LABEL (left branch) -->
      <path class="cable" id="cable-orchestrator-parse" d="M380 320 L240 320 L240 380" />
      <!-- ORCHESTRATOR → ASH_SESSION (right branch) -->
      <path class="cable" id="cable-orchestrator-ash" d="M540 320 L680 320 L680 380" />
      <!-- ASH_SESSION → TOOLS -->
      <path class="cable" id="cable-ash-tools" d="M680 440 L680 470 L460 470 L460 500" />
      <!-- TOOLS → AI GATEWAY -->
      <path class="cable" id="cable-tools-gateway" d="M540 530 L760 530 L760 570" />
      <!-- TOOLS → REDIS -->
      <path class="cable" id="cable-tools-redis" d="M380 530 L160 530 L160 570" />
      <!-- ASH_SESSION → WEBHOOK (outbound return path) -->
      <path class="cable" id="cable-ash-outbound" d="M680 410 L840 410 L840 200 L520 200" />

      <!-- Boxes -->
      <!-- Telegram (edge, top) -->
      <rect class="box edge heartbeat" id="box-telegram" x="380" y="30" width="160" height="50" rx="6" />
      <text class="label" id="label-telegram" x="460" y="60">Telegram</text>

      <!-- Webhook -->
      <rect class="box heartbeat" id="box-webhook" x="380" y="170" width="160" height="60" rx="6" />
      <text class="label" id="label-webhook" x="460" y="205">Webhook</text>
      <text class="sub" id="sub-webhook" x="460" y="222">/api/telegram</text>

      <!-- Orchestrator -->
      <rect class="box heartbeat" id="box-orchestrator" x="380" y="290" width="160" height="60" rx="6" />
      <text class="label" id="label-orchestrator" x="460" y="325">Orchestrator</text>
      <text class="sub" id="sub-orchestrator" x="460" y="342">process-update</text>

      <!-- Parse Label (left branch) -->
      <rect class="box heartbeat" id="box-parse_label" x="160" y="380" width="160" height="60" rx="6" />
      <text class="label" id="label-parse_label" x="240" y="415">parse_label</text>
      <text class="sub" id="sub-parse_label" x="240" y="432">vision · ai gateway</text>

      <!-- Ash Session (right branch) -->
      <rect class="box heartbeat" id="box-ash_send" x="600" y="380" width="160" height="60" rx="6" />
      <text class="label" id="label-ash_send" x="680" y="415">Ash Session</text>
      <text class="sub" id="sub-ash_send" x="680" y="432">turn loop</text>

      <!-- Tools (single block; sub-cells in #61) -->
      <rect class="box heartbeat" id="box-tool" x="380" y="500" width="160" height="60" rx="6" />
      <text class="label" id="label-tool" x="460" y="535">Tools</text>
      <text class="sub" id="sub-tool" x="460" y="552">5 surfaces</text>

      <!-- AI Gateway (edge, bottom-right) -->
      <rect class="box edge heartbeat" id="box-gateway" x="680" y="570" width="160" height="50" rx="6" />
      <text class="label" id="label-gateway" x="760" y="600">AI Gateway</text>

      <!-- Redis (edge, bottom-left) -->
      <rect class="box edge heartbeat" id="box-redis" x="80" y="570" width="160" height="50" rx="6" />
      <text class="label" id="label-redis" x="160" y="600">Upstash · Redis</text>
    </svg>
  </div>
  <footer>
    <div class="status" id="status">connecting…</div>
    <div class="legend">
      <div class="legend-item"><span class="swatch swatch-text"></span> text</div>
      <div class="legend-item"><span class="swatch swatch-photo"></span> photo</div>
      <div class="legend-item"><span class="swatch swatch-callback"></span> callback</div>
    </div>
    <div id="trace-id" class="status">—</div>
  </footer>
  <script>
    (() => {
      "use strict";

      const MIN_HOP_MS = 600;
      const MAX_HOP_MS = 4000;
      const INTER_HOP_MS = 200;
      const POST_HOLD_MS = 2000;
      const POST_FADE_MS = 2000;

      // Map each emitted stage to (a) the box it ignites and (b) the
      // cable that runs into that box. Stages emitted twice (start +
      // end + occasionally error) only re-ignite on \`start\` — the box
      // stays in hold state between start and end, then transitions
      // to fade when the trace completes.
      const STAGE_PLAN = {
        webhook:      { box: "webhook",      cable: "cable-telegram-webhook" },
        orchestrator: { box: "orchestrator", cable: "cable-webhook-orchestrator" },
        parse_label:  { box: "parse_label",  cable: "cable-orchestrator-parse" },
        ash_send:     { box: "ash_send",     cable: "cable-orchestrator-ash" },
        tool:         { box: "tool",         cable: "cable-ash-tools" },
        drain:        { box: "ash_send",     cable: null },
        outbound:     { box: "webhook",      cable: "cable-ash-outbound" },
      };

      // Accent CSS variable per trace kind. Read on each event so a
      // trace's color survives mid-stream stage changes.
      const ACCENT_VAR = {
        text:     "var(--text-accent)",
        photo:    "var(--photo-accent)",
        callback: "var(--callback-accent)",
      };

      const $ = (id) => document.getElementById(id);
      const statusEl = $("status");
      const traceIdEl = $("trace-id");
      const allBoxes = Array.from(document.querySelectorAll("rect.box"));
      const allCables = Array.from(document.querySelectorAll("path.cable"));

      function setIdle() {
        for (const b of allBoxes) {
          b.classList.remove("ignite", "hold");
          b.classList.add("heartbeat");
          b.style.removeProperty("--accent");
        }
        for (const c of allCables) {
          c.classList.remove("run", "hold");
          c.style.removeProperty("--accent");
        }
        const labels = document.querySelectorAll("text.label");
        for (const l of labels) l.classList.remove("ignite", "hold");
      }

      // Per-trace runtime state. The engine queues events for one trace
      // until the trace terminates (POST_HOLD_MS + POST_FADE_MS later)
      // and only then drains the next trace's events.
      const traceQueue = [];
      let activeTrace = null;

      function enqueue(event) {
        // Group events by traceId so a noisy second trace doesn't
        // interleave with the first.
        if (activeTrace && activeTrace.traceId === event.traceId) {
          activeTrace.events.push(event);
          maybeStep();
          return;
        }
        let tail = traceQueue[traceQueue.length - 1];
        if (!tail || tail.traceId !== event.traceId) {
          tail = { traceId: event.traceId, kind: event.kind, events: [] };
          traceQueue.push(tail);
        }
        tail.events.push(event);
        if (!activeTrace) {
          activeTrace = traceQueue.shift();
          maybeStep();
        }
      }

      let lastHopAt = 0;
      let scheduled = false;

      function maybeStep() {
        if (scheduled) return;
        if (!activeTrace || activeTrace.events.length === 0) return;
        const wait = Math.max(0, lastHopAt + INTER_HOP_MS - Date.now());
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          if (!activeTrace) return;
          const next = activeTrace.events.shift();
          if (!next) return;
          step(next);
          lastHopAt = Date.now();
          if (activeTrace.events.length > 0) maybeStep();
          else scheduleTraceEnd();
        }, wait);
      }

      let traceEndTimer = null;
      function scheduleTraceEnd() {
        if (traceEndTimer) clearTimeout(traceEndTimer);
        traceEndTimer = setTimeout(() => {
          // If new events landed in the meantime, keep going.
          if (activeTrace && activeTrace.events.length > 0) {
            traceEndTimer = null;
            maybeStep();
            return;
          }
          beginPostTrace();
        }, MAX_HOP_MS);
      }

      function beginPostTrace() {
        traceEndTimer = null;
        // Hold the completed path bright, then fade.
        const holdBoxes = allBoxes.filter((b) => b.classList.contains("ignite") || b.classList.contains("hold"));
        const holdCables = allCables.filter((c) => c.classList.contains("run") || c.classList.contains("hold"));
        for (const b of holdBoxes) {
          b.classList.remove("ignite");
          b.classList.add("hold");
        }
        for (const c of holdCables) {
          c.classList.remove("run");
          c.classList.add("hold");
        }
        setTimeout(() => {
          // Fade — drop the hold class and let CSS transition back to idle.
          for (const b of holdBoxes) b.classList.remove("hold");
          for (const c of holdCables) c.classList.remove("hold");
          setTimeout(() => {
            // Restore idle heartbeats once the fade has finished.
            for (const b of holdBoxes) b.classList.add("heartbeat");
            activeTrace = null;
            traceIdEl.textContent = "—";
            if (traceQueue.length > 0) {
              activeTrace = traceQueue.shift();
              maybeStep();
            }
          }, POST_FADE_MS);
        }, POST_HOLD_MS);
      }

      function step(event) {
        if (!activeTrace) return;
        // Update header trace badge so visitors see the current id.
        traceIdEl.textContent = "trace=" + event.traceId.slice(0, 8) + " · kind=" + event.kind;
        const plan = STAGE_PLAN[event.stage];
        if (!plan) return;
        const accent = ACCENT_VAR[event.kind] || ACCENT_VAR.text;
        const box = $("box-" + plan.box);
        const label = $("label-" + plan.box);
        const cable = plan.cable ? $(plan.cable) : null;
        if (!box) return;
        // Set the accent on the box + cable so CSS reads it.
        box.style.setProperty("--accent", accent);
        if (cable) cable.style.setProperty("--accent", accent);
        if (event.phase === "start") {
          if (cable) {
            // Reset animation by removing + reapplying the class.
            cable.classList.remove("run", "hold");
            // Force reflow so the keyframe restarts.
            void cable.getBoundingClientRect();
            cable.classList.add("run");
            setTimeout(() => cable.classList.replace("run", "hold"), MIN_HOP_MS);
          }
          box.classList.remove("heartbeat");
          box.classList.remove("hold");
          box.classList.add("ignite");
          if (label) label.classList.add("ignite");
          // Auto-downgrade to "hold" after MIN_HOP_MS so subsequent boxes
          // can stand out against this one. The .end event keeps it in
          // hold state; absent an .end (e.g. drain.start without
          // drain.end yet) the box still settles into hold.
          setTimeout(() => {
            if (box.classList.contains("ignite")) {
              box.classList.replace("ignite", "hold");
              if (label) label.classList.replace("ignite", "hold");
            }
          }, MIN_HOP_MS);
        } else if (event.phase === "end") {
          // The box is already in ignite or hold; just make sure the
          // hold class is set so it stays bright through the post-trace
          // fade window.
          if (!box.classList.contains("ignite") && !box.classList.contains("hold")) {
            box.classList.add("hold");
            if (label) label.classList.add("hold");
          }
          if (cable && !cable.classList.contains("run")) {
            cable.classList.add("hold");
          }
        } else if (event.phase === "error") {
          // For #59 we don't yet ship the red-flash terminal-failure
          // visual (#60 does). Treat error like end so the trace
          // doesn't stall waiting for a phase that never arrives.
          if (!box.classList.contains("ignite") && !box.classList.contains("hold")) {
            box.classList.add("hold");
            if (label) label.classList.add("hold");
          }
        }
      }

      const source = new EventSource("/api/trace");
      source.addEventListener("open", () => {
        statusEl.textContent = "live";
        statusEl.classList.add("connected");
      });
      source.addEventListener("error", () => {
        statusEl.textContent = "reconnecting…";
        statusEl.classList.remove("connected");
      });
      source.addEventListener("message", (e) => {
        let event;
        try { event = JSON.parse(e.data); } catch { return; }
        if (!event || typeof event.stage !== "string") return;
        enqueue(event);
      });

      setIdle();
    })();
  </script>
</body>
</html>
`;

export function handleFirstLightPageRequest(): Response {
  return new Response(LIVE_DIAGRAM_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
