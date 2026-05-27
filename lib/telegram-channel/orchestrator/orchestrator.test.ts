import { describe, expect, it, vi } from "vitest";

import type { Resident } from "../../redis.js";
import { emitTrace, runWithTrace, subscribe } from "../../trace.js";
import { Action } from "./action.js";
import type { State } from "./state.js";
import { match } from "./match.js";
import { runActions } from "./run-actions.js";
import type { RunActionsDeps } from "./run-actions.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const resident: Resident = {
  id: "res_1",
  name: "Diego Demo",
  street: "Teststraße",
  houseNumber: "42",
  platformId: "11111",
  platform: "telegram",
  language: "de",
  availabilityPatterns: [],
  registeredAt: 1700000000,
  source: "explicit",
  confirmed: true,
};

function makeDeps(overrides: Partial<RunActionsDeps> = {}): RunActionsDeps {
  return {
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    registerPackage: vi.fn().mockResolvedValue({ package: {}, holder: {}, recipientResolution: { kind: "unknown" }, receptionRequestFulfilled: null }),
    registerResident: vi.fn().mockResolvedValue({ resident }),
    createReceptionRequest: vi.fn().mockResolvedValue({ receptionRequest: {} }),
    acceptReceptionRequest: vi.fn().mockResolvedValue({ receptionRequest: {}, volunteer: resident }),
    confirmPickup: vi.fn().mockResolvedValue({ package: {}, holder: resident, recipient: resident }),
    editGroupCard: vi.fn().mockResolvedValue(undefined),
    answerCallback: vi.fn().mockResolvedValue(undefined),
    stripKeyboard: vi.fn().mockResolvedValue(undefined),
    sendToAsh: vi.fn().mockResolvedValue({ sessionId: "sess_1" }),
    drainSession: vi.fn().mockResolvedValue(undefined),
    waitUntil: vi.fn(),
    setTriggerAttribute: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// match — exhaustiveness
// ---------------------------------------------------------------------------

describe("match", () => {
  const states: Array<{ label: string; state: State; sliceRef: string }> = [
    {
      label: "dm-registration",
      state: { kind: "dm-registration", inbound: { chatId: 1, text: "/register", isGroup: false, fromUserId: 1, fromLanguageCode: null, fromFirstName: null, fromLastName: null, fromUsername: null, photoFileId: null } },
      sliceRef: "Slice 3 (#134)",
    },
    {
      label: "dm-photo",
      state: { kind: "dm-photo", inbound: { chatId: 3, text: "", isGroup: false, fromUserId: 1, fromLanguageCode: null, fromFirstName: null, fromLastName: null, fromUsername: null, photoFileId: "file_1" }, resident, vision: { kind: "unknown", confidence: "low", reason: "test" } },
      sliceRef: "Slice 5 (#136)",
    },
    {
      label: "dm-text",
      state: { kind: "dm-text", inbound: { chatId: 4, text: "hello", isGroup: false, fromUserId: 1, fromLanguageCode: null, fromFirstName: null, fromLastName: null, fromUsername: null, photoFileId: null }, resident, classifier: { kind: "other", absenceSignal: false, confidence: "low", reason: "test" } },
      sliceRef: "Slice 5 (#136)",
    },
    {
      label: "dm-receive-cmd",
      state: { kind: "dm-receive-cmd", inbound: { chatId: 5, text: "/receive", isGroup: false, fromUserId: 1, fromLanguageCode: null, fromFirstName: null, fromLastName: null, fromUsername: null, photoFileId: null }, resident: null },
      sliceRef: "Slice 5 (#136)",
    },
    {
      label: "group-photo",
      state: { kind: "group-photo", inbound: { chatId: 6, text: "", isGroup: true, fromUserId: 1, fromLanguageCode: null, fromFirstName: null, fromLastName: null, fromUsername: null, photoFileId: "file_2" }, resident: null, vision: { kind: "unknown", confidence: "low", reason: "test" } },
      sliceRef: "Slice 6 (#137)",
    },
    {
      label: "group-text",
      state: { kind: "group-text", inbound: { chatId: 7, text: "paket", isGroup: true, fromUserId: 1, fromLanguageCode: null, fromFirstName: null, fromLastName: null, fromUsername: null, photoFileId: null }, resident: null, classifier: { isPackageRegistration: false, recipients: [], confidence: "low", reason: "test" } },
      sliceRef: "Slice 6 (#137)",
    },
  ];

  for (const { label, state, sliceRef } of states) {
    it(`throws "not yet migrated" for ${label}`, () => {
      expect(() => match(state)).toThrow(/not yet migrated/);
      expect(() => match(state)).toThrow(sliceRef);
    });
  }

  it("covers all 6 unmigrated state variants (exhaustiveness regression)", () => {
    // Slice 4 (#135) migrated callback-pickup and callback-accept families
    // (success + 4 error variants each + callback-agent) so they were
    // removed from this list. Slices 3, 5, 6 still have unmigrated kinds.
    expect(states).toHaveLength(6);
  });

  it("throws on unknown state kind (never branch)", () => {
    // Cast through unknown to bypass TS checks — we're testing the runtime guard.
    expect(() => match({ kind: "non-existent" } as unknown as State)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runActions — every Action.kind runner branch
// ---------------------------------------------------------------------------

describe("runActions", () => {
  describe("send-direct-message", () => {
    it("calls sendDirectMessage and emits trace start/end", async () => {
      const deps = makeDeps();
      const events: Array<{ stage: string; phase: string }> = [];
      const unsub = subscribe((e) => events.push({ stage: e.stage, phase: e.phase }));

      await runWithTrace({ traceId: "t1", kind: "text" }, () =>
        runActions(
          [Action.sendDirectMessage(42, "hello", { traceStage: "dm", traceExtras: { kind: "test" } })],
          deps,
        ),
      );

      unsub();
      expect(deps.sendDirectMessage).toHaveBeenCalledWith(42, "hello", undefined, undefined);
      expect(events).toEqual([
        { stage: "dm", phase: "start" },
        { stage: "dm", phase: "end" },
      ]);
    });

    it("emits error trace and swallows the error so the rest of the action list keeps running", async () => {
      // Communication side effects (DM/card/ack/strip) follow the
      // legacy dispatcher tolerance contract — a failed DM never
      // bails a multi-DM flow. The runner emits `<stage>.error` and
      // continues; the next action still runs.
      const err = new Error("Bot API down");
      const deps = makeDeps({ sendDirectMessage: vi.fn().mockRejectedValue(err) });
      const events: Array<{ stage: string; phase: string }> = [];
      const unsub = subscribe((e) => events.push({ stage: e.stage, phase: e.phase }));

      await runWithTrace({ traceId: "t1", kind: "text" }, () =>
        runActions(
          [
            Action.sendDirectMessage(42, "hello", { traceStage: "dm" }),
            // The follow-up emit-trace must still fire — tolerance proof.
            Action.emitTrace("after", "ran"),
          ],
          deps,
        ),
      );

      unsub();
      expect(events.map((e) => e.phase)).toContain("error");
      expect(events.some((e) => e.stage === "after" && e.phase === "ran")).toBe(true);
    });
  });

  describe("register-package", () => {
    it("calls registerPackage and emits trace start/end", async () => {
      const deps = makeDeps();
      const events: string[] = [];
      const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

      await runWithTrace({ traceId: "t1", kind: "text" }, () =>
        runActions(
          [Action.registerPackage(resident, { recipientName: "A", recipientHouseNumber: "1" }, { traceStage: "flow1.register" })],
          deps,
        ),
      );

      unsub();
      expect(deps.registerPackage).toHaveBeenCalledWith(resident, { recipientName: "A", recipientHouseNumber: "1" });
      expect(events).toEqual(["flow1.register.start", "flow1.register.end"]);
    });
  });

  describe("register-resident", () => {
    it("calls registerResident and emits trace", async () => {
      const deps = makeDeps();
      const events: string[] = [];
      const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

      await runWithTrace({ traceId: "t1", kind: "text" }, () =>
        runActions(
          [Action.registerResident({ platformId: "11111", name: "A", houseNumber: "1", street: "x" }, { traceStage: "registration" })],
          deps,
        ),
      );

      unsub();
      expect(deps.registerResident).toHaveBeenCalled();
      expect(events).toEqual(["registration.start", "registration.end"]);
    });
  });

  describe("create-reception-request", () => {
    it("calls createReceptionRequest and emits trace", async () => {
      const deps = makeDeps();
      const events: string[] = [];
      const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

      const input = { carrier: "Amazon" as const };

      await runWithTrace({ traceId: "t1", kind: "text" }, () =>
        runActions(
          [Action.createReceptionRequest(resident, input, { traceStage: "flow2.create" })],
          deps,
        ),
      );

      unsub();
      expect(deps.createReceptionRequest).toHaveBeenCalledWith(resident, input);
      expect(events).toEqual(["flow2.create.start", "flow2.create.end"]);
    });
  });

  describe("accept-reception-request", () => {
    it("calls acceptReceptionRequest and emits trace", async () => {
      const deps = makeDeps();
      const events: string[] = [];
      const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

      const input = { requestId: "rr_1" };

      await runWithTrace({ traceId: "t1", kind: "text" }, () =>
        runActions(
          [Action.acceptReceptionRequest(resident, input, { traceStage: "flow2.accept" })],
          deps,
        ),
      );

      unsub();
      expect(deps.acceptReceptionRequest).toHaveBeenCalledWith(resident, input);
      expect(events).toEqual(["flow2.accept.start", "flow2.accept.end"]);
    });
  });

  describe("confirm-pickup", () => {
    it("calls confirmPickup and emits trace", async () => {
      const deps = makeDeps();
      const events: string[] = [];
      const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

      await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
        runActions(
          [Action.confirmPickup(resident, "pkg_1", { traceStage: "flow1.pickup" })],
          deps,
        ),
      );

      unsub();
      expect(deps.confirmPickup).toHaveBeenCalledWith(resident, "pkg_1");
      expect(events).toEqual(["flow1.pickup.start", "flow1.pickup.end"]);
    });
  });

  describe("edit-group-card", () => {
    it("calls editGroupCard and emits trace", async () => {
      const deps = makeDeps();
      await runActions(
        [Action.editGroupCard(100, 55, "✅ accepted", { traceStage: "flow2.edit" })],
        deps,
      );
      expect(deps.editGroupCard).toHaveBeenCalledWith(100, 55, "✅ accepted");
    });
  });

  describe("answer-callback", () => {
    it("calls answerCallback with text", async () => {
      const deps = makeDeps();
      await runActions([Action.answerCallback("cb_1", "toast")], deps);
      expect(deps.answerCallback).toHaveBeenCalledWith("cb_1", "toast");
    });

    it("calls answerCallback without text — single-arg form", async () => {
      // Matches the legacy `deps.answerCallback(cb.callbackId)` call
      // sites — preserves single-arg `toHaveBeenCalledWith("cb_id")`
      // assertions in callback-handler tests.
      const deps = makeDeps();
      await runActions([Action.answerCallback("cb_1")], deps);
      expect(deps.answerCallback).toHaveBeenCalledWith("cb_1");
    });
  });

  describe("strip-keyboard", () => {
    it("calls stripKeyboard", async () => {
      const deps = makeDeps();
      await runActions([Action.stripKeyboard(42, 10)], deps);
      expect(deps.stripKeyboard).toHaveBeenCalledWith(42, 10);
    });
  });

  describe("send-to-ash", () => {
    it("calls sendToAsh and drains session via waitUntil", async () => {
      const fakeSession = { sessionId: "sess_1" };
      const deps = makeDeps({
        sendToAsh: vi.fn().mockResolvedValue(fakeSession),
        drainSession: vi.fn().mockResolvedValue(undefined),
        waitUntil: vi.fn(),
      });

      const auth = null;
      const state = { chatId: 42, isGroup: false, fromUserId: 1, fromLanguageCode: null };

      await runActions(
        [Action.sendToAsh("hello agent", auth, "tg:42", state)],
        deps,
      );

      expect(deps.sendToAsh).toHaveBeenCalledWith("hello agent", {
        auth: null,
        continuationToken: "tg:42",
        state,
      });
      expect(deps.waitUntil).toHaveBeenCalledTimes(1);
    });
  });

  describe("emit-trace", () => {
    it("publishes an event on the trace bus", async () => {
      const deps = makeDeps();
      const events: Array<{ stage: string; phase: string }> = [];
      const unsub = subscribe((e) => events.push({ stage: e.stage, phase: e.phase }));

      await runWithTrace({ traceId: "t1", kind: "text" }, () =>
        runActions([Action.emitTrace("flow1", "fallthrough", { reason: "low-conf" })], deps),
      );

      unsub();
      expect(events).toEqual([{ stage: "flow1", phase: "fallthrough" }]);
    });

    it("is a no-op outside a runWithTrace scope", async () => {
      const deps = makeDeps();
      const events: unknown[] = [];
      const unsub = subscribe((e) => events.push(e));
      await runActions([Action.emitTrace("x", "y")], deps);
      unsub();
      expect(events).toHaveLength(0);
    });
  });

  describe("log-error", () => {
    it("logs to console.error", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const deps = makeDeps();
      await runActions([Action.logError("boom", { ctx: "test" })], deps);
      expect(spy).toHaveBeenCalledWith("[orchestrator]", "boom", { ctx: "test" });
      spy.mockRestore();
    });
  });

  describe("parallel", () => {
    it("executes nested actions concurrently", async () => {
      const order: number[] = [];
      const deps = makeDeps({
        sendDirectMessage: vi.fn().mockImplementation(async (chatId: number) => {
          order.push(chatId);
        }),
      });

      await runActions(
        [
          Action.parallel([
            Action.sendDirectMessage(1, "a", { traceStage: "dm" }),
            Action.sendDirectMessage(2, "b", { traceStage: "dm" }),
          ]),
        ],
        deps,
      );

      expect(deps.sendDirectMessage).toHaveBeenCalledTimes(2);
      expect(order).toContain(1);
      expect(order).toContain(2);
    });
  });

  describe("sequential ordering", () => {
    it("executes actions in array order", async () => {
      const order: string[] = [];
      const deps = makeDeps({
        sendDirectMessage: vi.fn().mockImplementation(async (chatId: number) => {
          order.push(`dm:${chatId}`);
        }),
        answerCallback: vi.fn().mockImplementation(async () => {
          order.push("callback");
        }),
      });

      await runActions(
        [
          Action.sendDirectMessage(1, "first", { traceStage: "dm" }),
          Action.answerCallback("cb"),
          Action.sendDirectMessage(2, "second", { traceStage: "dm" }),
        ],
        deps,
      );

      expect(order).toEqual(["dm:1", "callback", "dm:2"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Action helper constructors
// ---------------------------------------------------------------------------

describe("Action constructors", () => {
  it("Action.sendDirectMessage includes keyboard and entities when provided", () => {
    const kb = { inline_keyboard: [] };
    const ents = [{ type: "text_mention" as const, offset: 0, length: 3, user: { id: 1 } }];
    const a = Action.sendDirectMessage(1, "hi", { traceStage: "dm", keyboard: kb, entities: ents });
    expect(a).toMatchObject({ kind: "send-direct-message", keyboard: kb, entities: ents });
  });

  it("Action.parallel wraps actions array", () => {
    const inner = [Action.emitTrace("x", "y")];
    const a = Action.parallel(inner);
    expect(a).toEqual({ kind: "parallel", actions: inner });
  });

  it("Action.emitTrace omits extras when not provided", () => {
    const a = Action.emitTrace("s", "p");
    expect(a).not.toHaveProperty("extras");
  });

  it("Action.logError omits meta when not provided", () => {
    const a = Action.logError("msg");
    expect(a).not.toHaveProperty("meta");
  });
});
