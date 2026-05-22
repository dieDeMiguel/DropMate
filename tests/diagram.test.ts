/**
 * Smoke test for the live-diagram engine (#102).
 *
 * The engine in `public/diagram.js` consumes SSE trace events emitted by
 * `lib/trace.ts` and lights matching SVG boxes/cables. This test verifies:
 *
 *   1. The stage→box mapping covers every v2.1 channel emit site
 *      (channel, registration, classifier, vision, flow2, agent, dm).
 *   2. The log-line formatter produces the booth-readable shape.
 *   3. End-to-end: queueing synthetic events lights the right boxes
 *      and a Flow 2 path (channel → flow2 → dm → telegram) leaves the
 *      AGENT box unlit — the v2.1 narrative the page exists to tell.
 *
 * No jsdom dependency: a hand-rolled DOM stub backs the engine with
 * just enough surface (getElementById, querySelectorAll, classList,
 * style.setProperty, getBoundingClientRect) to exercise the renderer.
 */

// @ts-expect-error — JS module, no .d.ts; vitest resolves it at runtime.
import { createEngine, STAGE_PLAN, formatLogLine } from "../public/diagram.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StubElement {
  id: string;
  tagName: string;
  className: string;
  textContent: string;
  classList: {
    _set: Set<string>;
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
    replace(oldName: string, newName: string): void;
    toggle(name: string): void;
  };
  style: {
    _props: Record<string, string>;
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

function makeStubElement(id: string, tagName: string, className: string): StubElement {
  const classes = new Set<string>(
    className
      .split(/\s+/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0),
  );
  const styleProps: Record<string, string> = {};
  return {
    id,
    tagName,
    className,
    textContent: "",
    classList: {
      _set: classes,
      add(...names) {
        for (const n of names) classes.add(n);
      },
      remove(...names) {
        for (const n of names) classes.delete(n);
      },
      contains(name) {
        return classes.has(name);
      },
      replace(oldName, newName) {
        if (classes.has(oldName)) {
          classes.delete(oldName);
          classes.add(newName);
        }
      },
      toggle(name) {
        if (classes.has(name)) classes.delete(name);
        else classes.add(name);
      },
    },
    style: {
      _props: styleProps,
      setProperty(name, value) {
        styleProps[name] = value;
      },
      removeProperty(name) {
        delete styleProps[name];
      },
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 100, height: 100 };
    },
  };
}

function makeStubDoc(elements: ReadonlyArray<StubElement>) {
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  return {
    getElementById(id: string): StubElement | null {
      return byId.get(id) ?? null;
    },
    querySelectorAll(selector: string): StubElement[] {
      // Tiny selector engine — enough for the engine's usage:
      // "rect.box", "path.cable", "text.sub", "text.label".
      const parts = selector.split(",").map((s) => s.trim());
      const out: StubElement[] = [];
      for (const part of parts) {
        const dot = part.indexOf(".");
        if (dot < 0) continue;
        const tag = part.slice(0, dot);
        const cls = part.slice(dot + 1);
        for (const el of elements) {
          if (
            el.tagName.toLowerCase() === tag.toLowerCase() &&
            el.classList.contains(cls)
          ) {
            out.push(el);
          }
        }
      }
      return out;
    },
  };
}

/**
 * Build a stub document populated with every box/cable id the engine
 * looks up. Matches the SVG layout in public/index.html.
 */
function makeDiagramDoc() {
  const boxes = [
    "telegram",
    "channel",
    "registration",
    "classifier",
    "vision",
    "flow2",
    "agent",
    "redis",
    "ai-gateway",
  ];
  const cables = [
    "cable-telegram-channel",
    "cable-channel-registration",
    "cable-channel-classifier",
    "cable-channel-vision",
    "cable-channel-flow2",
    "cable-channel-agent",
    "cable-channel-telegram",
    "cable-agent-telegram",
    "cable-vision-gateway",
    "cable-agent-gateway",
    "cable-flow2-redis",
    "cable-registration-redis",
  ];
  const elements: StubElement[] = [];
  for (const id of boxes) {
    elements.push(makeStubElement("box-" + id, "rect", "box heartbeat"));
    elements.push(makeStubElement("label-" + id, "text", "label"));
    elements.push(makeStubElement("sub-" + id, "text", "sub"));
  }
  for (const id of cables) {
    elements.push(makeStubElement(id, "path", "cable"));
  }
  elements.push(makeStubElement("trace-id", "div", "status"));
  return makeStubDoc(elements);
}

describe("STAGE_PLAN", () => {
  // The diagram's central contract: every emit site in production
  // (lib/telegram-channel/process-update.ts) names a stage; this
  // table tells the engine where to ignite. If a new stage shows up
  // in production without a STAGE_PLAN entry, the event silently
  // no-ops in the browser — that's a regression class worth pinning.
  it("covers every v2.1 channel emit site", () => {
    expect(Object.keys(STAGE_PLAN).sort()).toEqual([
      "agent",
      "channel",
      "classifier",
      "dm",
      "flow2",
      "registration",
      "vision",
    ]);
  });

  it("maps each stage to a real box + cable id pair", () => {
    for (const [stage, plan] of Object.entries(STAGE_PLAN) as [
      string,
      { box: string; cable: string },
    ][]) {
      expect(plan.box, `stage ${stage} → box`).toBeTypeOf("string");
      expect(plan.cable, `stage ${stage} → cable`).toMatch(/^cable-/);
    }
  });

  it("routes the dm stage at the TELEGRAM destination box", () => {
    // Outbound DMs (Flow 2 ack/vlc, registration confirmation,
    // volunteer-accept pair) light TELEGRAM as a destination — the
    // diagram uses one box for both inbound source and outbound
    // sink, matching the chat-platform reality.
    expect(STAGE_PLAN.dm.box).toBe("telegram");
    expect(STAGE_PLAN.dm.cable).toBe("cable-channel-telegram");
  });
});

describe("formatLogLine", () => {
  // Fixed timestamp for deterministic assertions: 2026-05-22 09:08:07.123 UTC.
  const FROZEN = Date.UTC(2026, 4, 22, 9, 8, 7, 123);

  it("renders stage.phase, trace id (8 chars), kind, and scalar extras", () => {
    const line = formatLogLine(
      {
        traceId: "abcdef1234567890",
        kind: "text",
        stage: "channel",
        phase: "start",
        ts: FROZEN,
        extras: { trigger: "telegram.text-dm", retries: 0 },
      },
      FROZEN,
    );
    expect(line).toContain("channel.start");
    expect(line).toContain("trace=abcdef12");
    expect(line).toContain("text");
    expect(line).toContain("trigger=telegram.text-dm");
    expect(line).toContain("retries=0");
  });

  it("omits object-valued extras", () => {
    const line = formatLogLine(
      {
        traceId: "trace0001",
        kind: "callback",
        stage: "flow2",
        phase: "accept.start",
        ts: FROZEN,
        extras: { nested: { not: "rendered" } },
      },
      FROZEN,
    );
    expect(line).toContain("flow2.accept.start");
    expect(line).not.toContain("rendered");
  });
});

describe("createEngine — synthetic trace stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lights CHANNEL on channel.start, then ignites the matching branch box", async () => {
    const doc = makeDiagramDoc();
    const engine = createEngine(doc);

    const traceId = "t0000001";
    engine.enqueue({
      traceId,
      kind: "text",
      stage: "channel",
      phase: "start",
      ts: 0,
    });
    // INTER_HOP_MS (200) drains the first event.
    await vi.advanceTimersByTimeAsync(250);
    const channelBox = doc.getElementById("box-channel")!;
    expect(channelBox.classList.contains("ignite")).toBe(true);

    engine.enqueue({
      traceId,
      kind: "text",
      stage: "classifier",
      phase: "start",
      ts: 0,
    });
    await vi.advanceTimersByTimeAsync(250);
    const classifierBox = doc.getElementById("box-classifier")!;
    expect(classifierBox.classList.contains("ignite")).toBe(true);
  });

  it("flashes the FLOW 2 box on a reject.self event (the #98 / #101 path)", async () => {
    const doc = makeDiagramDoc();
    const engine = createEngine(doc);

    engine.enqueue({
      traceId: "tselfaccept",
      kind: "callback",
      stage: "channel",
      phase: "start",
      ts: 0,
    });
    engine.enqueue({
      traceId: "tselfaccept",
      kind: "callback",
      stage: "flow2",
      phase: "reject.self",
      ts: 0,
    });
    await vi.advanceTimersByTimeAsync(500);

    const flow2Box = doc.getElementById("box-flow2")!;
    expect(flow2Box.classList.contains("flash-error")).toBe(true);
  });

  it("leaves AGENT unlit on a fully channel-deterministic Flow 2 path (the v2.1 narrative)", async () => {
    const doc = makeDiagramDoc();
    const engine = createEngine(doc);

    // Simulate a /receive DM end-to-end:
    //   channel.start → flow2.create.start → flow2.create.end → dm.start → dm.end
    const traceId = "tflow2receive";
    const kind = "text";
    const events = [
      { stage: "channel", phase: "start" },
      { stage: "flow2", phase: "create.start", extras: { source: "slash-receive" } },
      { stage: "flow2", phase: "create.end", extras: { source: "slash-receive" } },
      { stage: "dm", phase: "start", extras: { kind: "flow2-ack" } },
      { stage: "dm", phase: "end", extras: { kind: "flow2-ack" } },
    ];
    for (const ev of events) {
      engine.enqueue({ traceId, kind, ts: 0, ...ev });
    }
    await vi.advanceTimersByTimeAsync(1500);

    const channelBox = doc.getElementById("box-channel")!;
    const flow2Box = doc.getElementById("box-flow2")!;
    const telegramBox = doc.getElementById("box-telegram")!;
    const agentBox = doc.getElementById("box-agent")!;

    // Channel + Flow 2 + Telegram (as DM destination) all lit.
    expect(channelBox.classList.contains("ignite") || channelBox.classList.contains("hold")).toBe(true);
    expect(flow2Box.classList.contains("ignite") || flow2Box.classList.contains("hold")).toBe(true);
    expect(telegramBox.classList.contains("ignite") || telegramBox.classList.contains("hold")).toBe(true);

    // Agent: never lit. This is the booth-demo's punchline — the
    // agent isn't invoked on the Flow 2 deterministic path.
    expect(agentBox.classList.contains("ignite")).toBe(false);
    expect(agentBox.classList.contains("hold")).toBe(false);
  });

  it("lights AGENT only on a fallthrough path (Flow 1 / Flow 3 / cron)", async () => {
    const doc = makeDiagramDoc();
    const engine = createEngine(doc);

    engine.enqueue({
      traceId: "tflow1",
      kind: "photo",
      stage: "channel",
      phase: "start",
      ts: 0,
    });
    engine.enqueue({
      traceId: "tflow1",
      kind: "photo",
      stage: "vision",
      phase: "start",
      extras: { tool: "parse_label" },
      ts: 0,
    });
    engine.enqueue({
      traceId: "tflow1",
      kind: "photo",
      stage: "vision",
      phase: "end",
      extras: { tool: "parse_label", confidence: "high" },
      ts: 0,
    });
    engine.enqueue({
      traceId: "tflow1",
      kind: "photo",
      stage: "agent",
      phase: "start",
      extras: { trigger: "telegram.photo" },
      ts: 0,
    });
    await vi.advanceTimersByTimeAsync(1500);

    const agentBox = doc.getElementById("box-agent")!;
    expect(agentBox.classList.contains("ignite") || agentBox.classList.contains("hold")).toBe(true);
  });
});
