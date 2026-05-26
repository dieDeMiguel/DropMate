/**
 * Smoke test for the live-diagram engine (#102 / #124).
 *
 * The engine in `public/diagram.js` consumes SSE trace events emitted by
 * `lib/trace.ts` and lights matching SVG boxes/cables. This test verifies:
 *
 *   1. The stage→box mapping covers every v2.1 channel emit site
 *      (channel, registration, classifier, vision, flow1, flow2, agent, dm)
 *      and the forward-looking pickup/redis/schedule slots.
 *   2. The log-line formatter produces the booth-readable shape.
 *   3. End-to-end: queueing synthetic events lights the right primitive
 *      boxes; a deterministic Flow 2 path (channel → flow2 → dm → telegram)
 *      leaves the AGENT box unlit — the booth-demo narrative the page
 *      exists to tell.
 *   4. The two AI Gateway model badges (gemini-2.5-flash, claude-opus-4.7)
 *      ignite INDEPENDENTLY — gemini on classifier/vision, claude on agent,
 *      with the outer Vercel AI Gateway frame lit whenever either fires.
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
      // "rect.box", "rect.box, rect.badge", "path.cable", "text.sub",
      // "text.label", "text.label, text.badge-label".
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
 * looks up. Matches the v2.1 #124 SVG layout in public/index.html.
 */
function makeDiagramDoc() {
  // Primary boxes (rect.box).
  const boxes = [
    "telegram",
    "channel",
    "tools",
    "agent",
    "ai-gateway",
    "schedules",
    "redis",
  ];
  // AI Gateway child badges (rect.badge — separate class so they
  // light + heartbeat independently).
  const badges = [
    "ai-gateway-gemini",
    "ai-gateway-claude",
  ];
  // Cables (path.cable).
  const cables = [
    "cable-telegram-channel",
    "cable-channel-tools",
    "cable-channel-agent",
    "cable-channel-gateway",
    "cable-channel-schedules",
    "cable-channel-telegram",
    "cable-tools-redis",
    "cable-agent-redis",
    "cable-schedules-redis",
  ];
  const elements: StubElement[] = [];
  for (const id of boxes) {
    elements.push(makeStubElement("box-" + id, "rect", "box heartbeat"));
    elements.push(makeStubElement("label-" + id, "text", "label"));
    elements.push(makeStubElement("sub-" + id, "text", "sub"));
  }
  for (const id of badges) {
    elements.push(makeStubElement("box-" + id, "rect", "badge"));
    elements.push(makeStubElement("label-" + id, "text", "badge-label"));
  }
  for (const id of cables) {
    elements.push(makeStubElement(id, "path", "cable"));
  }
  elements.push(makeStubElement("trace-id", "div", "status"));
  return makeStubDoc(elements);
}

function planBoxes(plan: unknown): readonly string[] {
  const p = plan as { box: string | readonly string[] };
  return Array.isArray(p.box) ? p.box : [p.box];
}

describe("STAGE_PLAN", () => {
  // The diagram's central contract: every emit site in production
  // (lib/telegram-channel/process-update.ts) names a stage; this
  // table tells the engine where to ignite. If a new stage shows up
  // in production without a STAGE_PLAN entry, the event silently
  // no-ops in the browser — that's a regression class worth pinning.
  it("covers every v2.1 channel emit site + forward-looking slots", () => {
    expect(Object.keys(STAGE_PLAN).sort()).toEqual([
      "agent",
      "channel",
      "classifier",
      "dm",
      "flow1",
      "flow2",
      "pickup",
      "redis",
      "registration",
      "schedule",
      "vision",
    ]);
  });

  it("maps each stage to a real box (string or array) + cable id pair", () => {
    for (const [stage, plan] of Object.entries(STAGE_PLAN) as [
      string,
      { box: string | readonly string[]; cable: string },
    ][]) {
      const boxes = planBoxes(plan);
      expect(boxes.length, `stage ${stage} → boxes`).toBeGreaterThan(0);
      for (const id of boxes) {
        expect(id, `stage ${stage} → box id`).toBeTypeOf("string");
      }
      expect(plan.cable, `stage ${stage} → cable`).toMatch(/^cable-/);
    }
  });

  it("routes the dm stage at the TELEGRAM destination box", () => {
    // Outbound DMs (Flow 2 ack/vlc, registration confirmation,
    // volunteer-accept pair) light TELEGRAM as a destination — the
    // diagram uses one box for both inbound source and outbound
    // sink, matching the chat-platform reality.
    const boxes = planBoxes(STAGE_PLAN.dm);
    expect(boxes).toEqual(["telegram"]);
    expect(STAGE_PLAN.dm.cable).toBe("cable-channel-telegram");
  });

  it("routes classifier/vision at the gemini badge + AI Gateway frame", () => {
    // Per #124 acceptance criteria: gemini-2.5-flash lights on
    // classifier and vision stages; the outer Vercel AI Gateway
    // frame lights when either fires. Pin the ordering — primary
    // (gemini badge) first so error flashes target it.
    expect(planBoxes(STAGE_PLAN.classifier)).toEqual([
      "ai-gateway-gemini",
      "ai-gateway",
    ]);
    expect(planBoxes(STAGE_PLAN.vision)).toEqual([
      "ai-gateway-gemini",
      "ai-gateway",
    ]);
  });

  it("routes agent at ASH AGENT + claude badge + AI Gateway frame", () => {
    // Per #124: claude-opus-4.7 lights on agent stage independently
    // of the gemini badge. ASH AGENT is the primary target.
    expect(planBoxes(STAGE_PLAN.agent)).toEqual([
      "agent",
      "ai-gateway-claude",
      "ai-gateway",
    ]);
  });

  it("routes flow1/flow2/registration/pickup at ASH TOOLS", () => {
    // Per #124: all channel-deterministic tool calls land on the
    // ASH TOOLS box.
    expect(planBoxes(STAGE_PLAN.flow1)).toEqual(["tools"]);
    expect(planBoxes(STAGE_PLAN.flow2)).toEqual(["tools"]);
    expect(planBoxes(STAGE_PLAN.registration)).toEqual(["tools"]);
    expect(planBoxes(STAGE_PLAN.pickup)).toEqual(["tools"]);
  });

  it("routes schedule at ASH SCHEDULES (forward-looking for Slice 2)", () => {
    expect(planBoxes(STAGE_PLAN.schedule)).toEqual(["schedules"]);
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

  it("lights ASH CHANNEL on channel.start, then ignites AI GATEWAY on classifier.start", async () => {
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
    // classifier lights the gemini badge AND the AI Gateway frame —
    // both primary AND secondary boxes ignite together. The claude
    // badge stays dark (independent badge contract per #124).
    const geminiBadge = doc.getElementById("box-ai-gateway-gemini")!;
    const gatewayFrame = doc.getElementById("box-ai-gateway")!;
    const claudeBadge = doc.getElementById("box-ai-gateway-claude")!;
    expect(geminiBadge.classList.contains("ignite")).toBe(true);
    expect(gatewayFrame.classList.contains("ignite")).toBe(true);
    expect(claudeBadge.classList.contains("ignite")).toBe(false);
  });

  it("agent.start lights ASH AGENT + claude badge + AI Gateway frame, leaves gemini dark", async () => {
    // The other half of the independent-badge contract: claude
    // ignites on agent, gemini stays dark. The outer frame lights
    // whenever either badge fires.
    const doc = makeDiagramDoc();
    const engine = createEngine(doc);

    engine.enqueue({
      traceId: "tagent",
      kind: "text",
      stage: "agent",
      phase: "start",
      ts: 0,
    });
    await vi.advanceTimersByTimeAsync(250);

    const agentBox = doc.getElementById("box-agent")!;
    const claudeBadge = doc.getElementById("box-ai-gateway-claude")!;
    const gatewayFrame = doc.getElementById("box-ai-gateway")!;
    const geminiBadge = doc.getElementById("box-ai-gateway-gemini")!;

    expect(agentBox.classList.contains("ignite")).toBe(true);
    expect(claudeBadge.classList.contains("ignite")).toBe(true);
    expect(gatewayFrame.classList.contains("ignite")).toBe(true);
    expect(geminiBadge.classList.contains("ignite")).toBe(false);
  });

  it("flashes the ASH TOOLS box on a flow2 reject.self event (the #98 / #101 path)", async () => {
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

    // Per #124: flow2 now maps to the consolidated ASH TOOLS box.
    const toolsBox = doc.getElementById("box-tools")!;
    expect(toolsBox.classList.contains("flash-error")).toBe(true);
  });

  it("leaves AGENT unlit on a fully channel-deterministic Flow 2 path (the booth narrative)", async () => {
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
    const toolsBox = doc.getElementById("box-tools")!;
    const telegramBox = doc.getElementById("box-telegram")!;
    const agentBox = doc.getElementById("box-agent")!;
    const claudeBadge = doc.getElementById("box-ai-gateway-claude")!;

    // Channel + Tools + Telegram (as DM destination) all lit.
    expect(channelBox.classList.contains("ignite") || channelBox.classList.contains("hold")).toBe(true);
    expect(toolsBox.classList.contains("ignite") || toolsBox.classList.contains("hold")).toBe(true);
    expect(telegramBox.classList.contains("ignite") || telegramBox.classList.contains("hold")).toBe(true);

    // Agent + claude badge: never lit. This is the booth-demo's
    // punchline — the agent isn't invoked on the Flow 2 deterministic
    // path, so the expensive claude-opus model stays cold.
    expect(agentBox.classList.contains("ignite")).toBe(false);
    expect(agentBox.classList.contains("hold")).toBe(false);
    expect(claudeBadge.classList.contains("ignite")).toBe(false);
    expect(claudeBadge.classList.contains("hold")).toBe(false);
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

  it("registration.start lights ASH TOOLS (not a dedicated registration box anymore)", async () => {
    // Pre-#124, registration had its own box. Post-#124 it folds
    // into ASH TOOLS along with flow1/flow2/pickup. Pin so the
    // collapse doesn't silently regress.
    const doc = makeDiagramDoc();
    const engine = createEngine(doc);

    engine.enqueue({
      traceId: "treg",
      kind: "text",
      stage: "registration",
      phase: "start",
      ts: 0,
    });
    await vi.advanceTimersByTimeAsync(250);

    const toolsBox = doc.getElementById("box-tools")!;
    expect(toolsBox.classList.contains("ignite")).toBe(true);
  });
});
