/**
 * DropMate live-diagram engine (v2.1 #102).
 *
 * Consumes the SSE feed at `/api/trace` (lib/telegram-channel/trace-routes.ts)
 * and renders each trace event by lighting the matching SVG box + cable
 * defined in public/index.html.
 *
 * The v2.1 story this diagram tells:
 *
 *   - CHANNEL is the star — every inbound passes through it.
 *   - REGISTRATION / CLASSIFIER / VISION / FLOW 2 LIB are the
 *     channel-deterministic branches. Each lights up without
 *     invoking the agent.
 *   - AGENT only lights when the channel falls through (Flow 1,
 *     Flow 3, language/pickup/delete, cron synthetics).
 *
 * Exported as both an IIFE (auto-boots when loaded in a browser with
 * a real `EventSource` + `document`) and a small set of named exports
 * for unit tests (`createEngine`, `STAGE_PLAN`). The engine is the
 * pure-function core; the IIFE is the DOM-attaching boot wrapper.
 *
 * Same shape as the pre-v2.1 diagram (preserved at tag
 * main-pre-v2.1-promotion). The change is what STAGES exist and which
 * boxes/cables they map to.
 */

const MIN_HOP_MS = 600;
const MAX_HOP_MS = 4000;
const INTER_HOP_MS = 200;
const POST_HOLD_MS = 2000;
const POST_FADE_MS = 2000;
// Origin (Telegram) doesn't emit its own event — the delivery from
// Telegram → Vercel is effectively instant. Hold ignite longer so a
// visitor sees the trace started from Telegram before it cascades
// to the channel.
const ORIGIN_IGNITE_MS = 1500;

/**
 * Stage → box + cable map. Each emitTrace call in production code
 * (lib/telegram-channel/process-update.ts) names a stage; the engine
 * looks up where to ignite the box and which cable to run.
 *
 * Stages emitted as `<stage>.start` re-ignite + run the cable; stages
 * emitted as `<stage>.end` lock the box in hold state; `.error` /
 * `.vlc` flash red briefly.
 *
 * Outbound paths (CHANNEL→TELEGRAM, AGENT→TELEGRAM) are routed via
 * the `dm` and `agent` stages respectively; both light the TELEGRAM
 * destination box too (the diagram has one box for both inbound
 * source and outbound destination — same chat platform).
 */
export const STAGE_PLAN = Object.freeze({
  channel:      { box: "channel",      cable: "cable-telegram-channel" },
  registration: { box: "registration", cable: "cable-channel-registration" },
  classifier:   { box: "classifier",   cable: "cable-channel-classifier" },
  vision:       { box: "vision",       cable: "cable-channel-vision" },
  flow2:        { box: "flow2",        cable: "cable-channel-flow2" },
  agent:        { box: "agent",        cable: "cable-channel-agent" },
  // `dm` events fire when the channel sends a deterministic outbound
  // DM (Flow 2 ack/vlc, registration confirmation, volunteer-accept
  // pair). Light TELEGRAM as the destination and run the return cable.
  dm:           { box: "telegram",     cable: "cable-channel-telegram" },
});

const ACCENT_VAR = Object.freeze({
  text:     "var(--text-accent)",
  photo:    "var(--photo-accent)",
  callback: "var(--callback-accent)",
});

/**
 * Create an engine that drives a DOM. The default boot wraps this
 * with `document` and a real `EventSource`. Tests pass a jsdom-backed
 * document and call `engine.enqueue(event)` directly.
 *
 * The engine intentionally does NOT manage the EventSource — that
 * keeps it framework-agnostic and trivially testable. The boot
 * wrapper handles the network plumbing.
 */
export function createEngine(doc) {
  const $ = (id) => doc.getElementById(id);
  const allBoxes = Array.from(doc.querySelectorAll("rect.box"));
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
    for (const l of doc.querySelectorAll("text.label")) {
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
    const box = $("box-" + plan.box);
    const label = $("label-" + plan.box);
    const cable = plan.cable ? $(plan.cable) : null;
    if (!box) return;
    box.style.setProperty("--accent", accent);
    if (cable) cable.style.setProperty("--accent", accent);

    // Phase: "start" → ignite + run cable; "end" → lock in hold;
    // "error" / "vlc" / "reject.*" → flash red briefly.
    if (
      event.phase === "error" ||
      event.phase === "vlc" ||
      (typeof event.phase === "string" && event.phase.startsWith("reject"))
    ) {
      flashError(box, label);
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
      box.classList.remove("heartbeat", "hold");
      box.classList.add("ignite");
      if (label) label.classList.add("ignite");
      setTimeout(() => {
        if (box.classList.contains("ignite")) {
          box.classList.replace("ignite", "hold");
          if (label) label.classList.replace("ignite", "hold");
        }
      }, MIN_HOP_MS);
    } else if (
      event.phase === "end" ||
      (typeof event.phase === "string" && event.phase.endsWith(".end"))
    ) {
      if (!box.classList.contains("ignite") && !box.classList.contains("hold")) {
        box.classList.add("hold");
        if (label) label.classList.add("hold");
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

  const source = new EventSource("/api/trace");
  source.addEventListener("open", () => {
    if (statusEl) {
      statusEl.textContent = "live";
      statusEl.classList.add("connected");
    }
  });
  source.addEventListener("error", () => {
    if (statusEl) {
      statusEl.textContent = "reconnecting…";
      statusEl.classList.remove("connected");
    }
  });
  source.addEventListener("message", (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    if (!event || typeof event.stage !== "string") return;
    appendLog(event);
    engine.enqueue(event);
  });
}
