/**
 * DropMate live-diagram engine (v2.1 #124 Vercel-primitives layout).
 *
 * Consumes the SSE feed at `/api/trace` (lib/telegram-channel/trace-routes.ts)
 * and renders each trace event by lighting the matching SVG boxes + cable
 * defined in public/index.html.
 *
 * The v2.1 #124 story this diagram tells:
 *
 *   - The whole pipeline runs on Vercel primitives. Box labels name
 *     primitives, not application-internal roles.
 *   - TELEGRAM (external) → ASH CHANNEL (telegram.ts) is the inbound.
 *   - ASH TOOLS / ASH AGENT / VERCEL AI GATEWAY / ASH SCHEDULES are
 *     the four primitives the channel can hand off to.
 *   - VERCEL AI GATEWAY has TWO model badges (gemini-2.5-flash and
 *     claude-opus-4.7) that ignite independently — gemini on
 *     classifier/vision tool calls, claude on agent turns.
 *   - UPSTASH REDIS (Vercel Marketplace) is the bottom state sink.
 *
 * Exported as both an IIFE (auto-boots when loaded in a browser with
 * a real `EventSource` + `document`) and a small set of named exports
 * for unit tests (`createEngine`, `STAGE_PLAN`).
 */

const MIN_HOP_MS = 600;
const MAX_HOP_MS = 4000;
const INTER_HOP_MS = 200;
const POST_HOLD_MS = 2000;
const POST_FADE_MS = 2000;
// Origin (Telegram) doesn't emit its own event — the delivery from
// Telegram → Vercel is effectively instant. Hold ignite longer so a
// visitor sees the trace started from Telegram before it cascades.
const ORIGIN_IGNITE_MS = 1500;

/**
 * Stage → boxes + cable map.
 *
 * `box` is either a string (single target) or an array (multi-target,
 * for stages that light a primary box AND a child badge — e.g. `agent`
 * lights both the ASH AGENT box and the claude-opus-4.7 badge inside
 * the VERCEL AI GATEWAY frame). The first id in the array is the
 * "primary" — error flashes target it.
 *
 * `cable` is the single cable that animates on `<stage>.start` events.
 * Multi-target stages still animate one cable (the primary path); the
 * other boxes light up via the ignite mechanism without their own
 * cable animation, which keeps the visual focused.
 *
 * Stage → primitive mapping (per #124 issue body):
 *
 *   channel       → ASH CHANNEL
 *   classifier    → AI GATEWAY (gemini-2.5-flash badge)
 *   vision        → AI GATEWAY (gemini-2.5-flash badge)
 *   agent         → ASH AGENT + AI GATEWAY (claude-opus-4.7 badge)
 *   flow1         → ASH TOOLS
 *   flow2         → ASH TOOLS
 *   dm            → TELEGRAM (return cable)
 *   registration  → ASH TOOLS
 *   pickup        → ASH TOOLS         (forward-looking; not emitted today)
 *   redis         → UPSTASH REDIS     (forward-looking; not emitted today)
 *   schedule      → ASH SCHEDULES     (wired in #125 Slice 2)
 */
export const STAGE_PLAN = Object.freeze({
  channel:      { box: "channel", cable: "cable-telegram-channel" },
  classifier:   { box: ["ai-gateway-gemini", "ai-gateway"], cable: "cable-channel-gateway" },
  vision:       { box: ["ai-gateway-gemini", "ai-gateway"], cable: "cable-channel-gateway" },
  agent:        { box: ["agent", "ai-gateway-claude", "ai-gateway"], cable: "cable-channel-agent" },
  flow1:        { box: "tools", cable: "cable-channel-tools" },
  flow2:        { box: "tools", cable: "cable-channel-tools" },
  dm:           { box: "telegram", cable: "cable-channel-telegram" },
  registration: { box: "tools", cable: "cable-channel-tools" },
  pickup:       { box: "tools", cable: "cable-channel-tools" },
  redis:        { box: "redis", cable: "cable-agent-redis" },
  schedule:     { box: "schedules", cable: "cable-channel-schedules" },
});

const ACCENT_VAR = Object.freeze({
  text:     "var(--text-accent)",
  photo:    "var(--photo-accent)",
  callback: "var(--callback-accent)",
});

function targetBoxIds(plan) {
  return Array.isArray(plan.box) ? plan.box : [plan.box];
}

/**
 * Create an engine that drives a DOM. The default boot wraps this
 * with `document` and a real `EventSource`. Tests pass a hand-rolled
 * document stub and call `engine.enqueue(event)` directly.
 */
export function createEngine(doc) {
  const $ = (id) => doc.getElementById(id);
  const allBoxes = Array.from(doc.querySelectorAll("rect.box, rect.badge"));
  const allCables = Array.from(doc.querySelectorAll("path.cable"));
  const traceIdEl = $("trace-id");

  // Persisted at boot so we can restore sub-labels between traces.
  const idleSubText = new Map();
  for (const sub of doc.querySelectorAll("text.sub")) {
    idleSubText.set(sub.id, sub.textContent || "");
  }

  function setIdle() {
    for (const b of allBoxes) {
      b.classList.remove("ignite", "hold", "flash-error");
      b.classList.add("heartbeat");
      b.style.removeProperty("--accent");
    }
    for (const c of allCables) {
      c.classList.remove("run", "hold");
      c.style.removeProperty("--accent");
    }
    for (const l of doc.querySelectorAll("text.label, text.badge-label")) {
      l.classList.remove("ignite", "hold");
    }
    for (const [id, text] of idleSubText.entries()) {
      const sub = doc.getElementById(id);
      if (sub) sub.textContent = text;
    }
  }

  const traceQueue = [];
  let activeTrace = null;
  let lastHopAt = 0;
  let scheduled = false;
  let traceEndTimer = null;

  function enqueue(event) {
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

  function scheduleTraceEnd() {
    if (traceEndTimer) clearTimeout(traceEndTimer);
    traceEndTimer = setTimeout(() => {
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
      for (const b of holdBoxes) b.classList.remove("hold");
      for (const c of holdCables) c.classList.remove("hold");
      setTimeout(() => {
        for (const b of holdBoxes) b.classList.add("heartbeat");
        activeTrace = null;
        if (traceIdEl) traceIdEl.textContent = "—";
        if (traceQueue.length > 0) {
          activeTrace = traceQueue.shift();
          maybeStep();
        }
      }, POST_FADE_MS);
    }, POST_HOLD_MS);
  }

  function flashError(box, label) {
    box.classList.add("flash-error");
    setTimeout(() => {
      box.classList.remove("flash-error");
    }, 400);
    if (label) label.classList.add("ignite");
  }

  function igniteOriginBox(accent) {
    const box = $("box-telegram");
    const label = $("label-telegram");
    if (!box) return;
    box.style.setProperty("--accent", accent);
    box.classList.remove("heartbeat", "hold");
    void box.getBoundingClientRect();
    box.classList.add("ignite");
    if (label) label.classList.add("ignite");
    setTimeout(() => {
      if (box.classList.contains("ignite")) {
        box.classList.replace("ignite", "hold");
        if (label) label.classList.replace("ignite", "hold");
      }
    }, ORIGIN_IGNITE_MS);
  }

  function step(event) {
    if (!activeTrace) return;
    if (traceIdEl) {
      traceIdEl.textContent = "trace=" + event.traceId.slice(0, 8) + " · kind=" + event.kind;
    }
    const accent = ACCENT_VAR[event.kind] || ACCENT_VAR.text;
    if (!activeTrace.originIgnited) {
      activeTrace.originIgnited = true;
      igniteOriginBox(accent);
    }
    const plan = STAGE_PLAN[event.stage];
    if (!plan) return;

    const ids = targetBoxIds(plan);
    const targets = [];
    for (const id of ids) {
      const box = $("box-" + id);
      if (!box) continue;
      targets.push({ box, label: $("label-" + id) });
    }
    if (targets.length === 0) return;
    const primary = targets[0];

    const cable = plan.cable ? $(plan.cable) : null;
    for (const t of targets) t.box.style.setProperty("--accent", accent);
    if (cable) cable.style.setProperty("--accent", accent);

    // Phase: "start" / ".start" → ignite + run cable; "end" / ".end"
    // → lock in hold; "error" / "vlc" / "reject.*" → flash red on
    // the primary box.
    if (
      event.phase === "error" ||
      event.phase === "vlc" ||
      (typeof event.phase === "string" && event.phase.startsWith("reject"))
    ) {
      flashError(primary.box, primary.label);
      return;
    }
    if (
      event.phase === "start" ||
      (typeof event.phase === "string" && event.phase.endsWith(".start"))
    ) {
      if (cable) {
        cable.classList.remove("run", "hold");
        void cable.getBoundingClientRect();
        cable.classList.add("run");
        setTimeout(() => cable.classList.replace("run", "hold"), MIN_HOP_MS);
      }
      for (const t of targets) {
        t.box.classList.remove("heartbeat", "hold");
        t.box.classList.add("ignite");
        if (t.label) t.label.classList.add("ignite");
      }
      setTimeout(() => {
        for (const t of targets) {
          if (t.box.classList.contains("ignite")) {
            t.box.classList.replace("ignite", "hold");
            if (t.label) t.label.classList.replace("ignite", "hold");
          }
        }
      }, MIN_HOP_MS);
    } else if (
      event.phase === "end" ||
      (typeof event.phase === "string" && event.phase.endsWith(".end"))
    ) {
      for (const t of targets) {
        if (!t.box.classList.contains("ignite") && !t.box.classList.contains("hold")) {
          t.box.classList.add("hold");
          if (t.label) t.label.classList.add("hold");
        }
      }
      if (cable && !cable.classList.contains("run")) {
        cable.classList.add("hold");
      }
    }
  }

  setIdle();

  return {
    enqueue,
    setIdle,
    // Test-only seams. Production callers go through `enqueue`.
    _getActiveTrace: () => activeTrace,
    _getQueueLength: () => traceQueue.length,
  };
}

/**
 * Format a trace event into a log line for the right-side panel.
 * Pulled out as a pure function so tests can assert on the rendered
 * shape without touching the DOM.
 */
export function formatLogLine(event, now) {
  const d = new Date(now);
  const pad2 = (n) => (n < 10 ? "0" : "") + n;
  const pad3 = (n) => (n < 10 ? "00" : n < 100 ? "0" : "") + n;
  const ts =
    pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" +
    pad2(d.getSeconds()) + "." + pad3(d.getMilliseconds());
  const traceShort = typeof event.traceId === "string" ? event.traceId.slice(0, 8) : "";
  let extras = "";
  if (event.extras && typeof event.extras === "object") {
    const parts = [];
    for (const key of Object.keys(event.extras)) {
      const value = event.extras[key];
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue;
      parts.push(key + "=" + String(value));
    }
    if (parts.length > 0) extras = " " + parts.join(" ");
  }
  return ts + " " + event.stage + "." + event.phase + " trace=" + traceShort + " " + (event.kind || "text") + extras;
}

/**
 * SSE connector with manual exponential-backoff reconnect (#126).
 *
 * EventSource's built-in reconnect handles transient network blips, but
 * Vercel's edge can outright `close()` a streaming response (function
 * timeout, server restart, idle-tab throttling). Once the browser flips
 * to readyState=CLOSED we never recover — leaving the diagram tab dark
 * on the next live event.
 *
 * The fix: on every error we close the current source ourselves and
 * re-instantiate after a backoff delay (1s → 2s → 4s → 8s, cap 10s).
 * Each successful `message` or `heartbeat` resets the backoff counter,
 * so a stable session always retries from 1s on the next dropout.
 *
 * Exported for tests, which inject a fake `EventSource` constructor +
 * a synchronous `scheduleReconnect` to drive the state machine without
 * real timers.
 */
export function createSseConnector(options) {
  const {
    url,
    onEvent,
    onStatus,
    EventSource: ES,
    scheduleReconnect = (fn, delay) => setTimeout(fn, delay),
    cancelReconnect = (handle) => clearTimeout(handle),
  } = options;

  let attempts = 0;
  let closed = false;
  let source = null;
  let reconnectHandle = null;

  function resetBackoff() {
    attempts = 0;
  }

  function nextDelay() {
    // 2^attempts seconds, clamped at 10s. attempts=0 → 1s, =1 → 2s,
    // =2 → 4s, =3 → 8s, ≥4 → 10s.
    const raw = 1000 * Math.pow(2, attempts);
    return Math.min(10_000, raw);
  }

  function connect() {
    if (closed) return;
    if (typeof onStatus === "function") {
      onStatus(attempts === 0 ? "connecting" : "reconnecting");
    }
    const src = new ES(url);
    source = src;

    src.addEventListener("open", () => {
      if (closed) return;
      if (typeof onStatus === "function") onStatus("live");
    });

    src.addEventListener("message", (e) => {
      if (closed) return;
      // Any message-bearing event proves the connection is healthy.
      // Reset backoff so the NEXT dropout retries from 1s.
      resetBackoff();
      if (typeof onEvent === "function") onEvent(e);
    });

    src.addEventListener("heartbeat", () => {
      if (closed) return;
      // Server-side keep-alive (#126). The browser may not have fired
      // `open` if the connection was reconnecting in the background,
      // so flip status to live on first heartbeat too.
      resetBackoff();
      if (typeof onStatus === "function") onStatus("live");
    });

    src.addEventListener("error", () => {
      if (closed) return;
      try {
        src.close();
      } catch {
        /* already closed */
      }
      const delay = nextDelay();
      attempts++;
      if (typeof onStatus === "function") onStatus("reconnecting");
      reconnectHandle = scheduleReconnect(connect, delay);
    });
  }

  connect();

  return {
    close() {
      closed = true;
      if (reconnectHandle !== null) {
        cancelReconnect(reconnectHandle);
        reconnectHandle = null;
      }
      if (source) {
        try {
          source.close();
        } catch {
          /* already closed */
        }
      }
    },
    // Test-only seams.
    _getAttempts: () => attempts,
    _getSource: () => source,
  };
}

// Browser boot. Skipped under jsdom-with-no-EventSource (test env).
if (typeof window !== "undefined" && typeof EventSource !== "undefined") {
  const engine = createEngine(document);
  const statusEl = document.getElementById("status");
  const logBody = document.getElementById("trace-log-body");
  const LOG_MAX = 20;

  function appendLog(event) {
    if (!logBody) return;
    const entry = document.createElement("div");
    entry.className = "log-entry kind-" + (event.kind || "text");
    if (
      event.phase === "error" ||
      event.phase === "vlc" ||
      (typeof event.phase === "string" && event.phase.startsWith("reject"))
    ) {
      entry.classList.add("flash-error-line");
    }
    entry.textContent = formatLogLine(event, Date.now());
    logBody.appendChild(entry);
    while (logBody.childElementCount > LOG_MAX) {
      const first = logBody.firstElementChild;
      if (!first) break;
      logBody.removeChild(first);
    }
    logBody.scrollTop = logBody.scrollHeight;
  }

  function applyStatus(state) {
    if (!statusEl) return;
    if (state === "live") {
      statusEl.textContent = "live";
      statusEl.classList.add("connected");
    } else if (state === "reconnecting") {
      statusEl.textContent = "reconnecting…";
      statusEl.classList.remove("connected");
    } else {
      statusEl.textContent = "connecting…";
      statusEl.classList.remove("connected");
    }
  }

  createSseConnector({
    url: "/api/trace",
    EventSource,
    onStatus: applyStatus,
    onEvent: (e) => {
      let event;
      try { event = JSON.parse(e.data); } catch { return; }
      if (!event || typeof event.stage !== "string") return;
      appendLog(event);
      engine.enqueue(event);
    },
  });
}
