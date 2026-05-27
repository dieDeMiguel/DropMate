import { describe, expect, it, vi } from "vitest";

import type { Package, ReceptionRequest, Resident } from "../../redis.js";
import {
  ACCEPT_DIFFERENT_STREET_ERROR_CODE,
  ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE,
  AcceptReceptionRequestError,
  type AcceptReceptionRequestResult,
} from "../../reception-request.js";
import {
  ConfirmPickupError,
  PICKUP_ALREADY_DONE_ERROR_CODE,
  PICKUP_NOT_RECIPIENT_ERROR_CODE,
  type ConfirmPickupResult,
} from "../../pickup.js";
import type { TelegramInboundCallback } from "../inbound.js";
import { emitTrace, runWithTrace, subscribe } from "../../trace.js";
import { Action } from "./action.js";
import type { State } from "./state.js";
import { match } from "./match.js";
import { buildState } from "./build-state.js";
import type { BuildStateDeps } from "./build-state.js";
import { runActions } from "./run-actions.js";
import type { RunActionsDeps } from "./run-actions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDmRegistrationInbound(overrides: {
  text: string;
  fromUserId?: number | null;
  chatId?: number;
  fromLanguageCode?: string | null;
}) {
  return {
    chatId: overrides.chatId ?? 99,
    text: overrides.text,
    isGroup: false,
    fromUserId: overrides.fromUserId ?? 99,
    fromLanguageCode: overrides.fromLanguageCode ?? "de",
    fromFirstName: "Test",
    fromLastName: null,
    fromUsername: null,
    photoFileId: null,
  };
}

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

  it("covers all 5 unmigrated state variants (exhaustiveness regression)", () => {
    // Slices 3 (#134) and 4 (#135) migrated dm-registration + callback-*
    // arms; only Slices 5 (#136) and 6 (#137) still have unmigrated kinds:
    // dm-photo, dm-text, dm-receive-cmd, group-photo, group-text.
    expect(states).toHaveLength(5);
  });

  it("throws on unknown state kind (never branch)", () => {
    // Cast through unknown to bypass TS checks — we're testing the runtime guard.
    expect(() => match({ kind: "non-existent" } as unknown as State)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// match — dm-registration (Slice 3 / #134)
// ---------------------------------------------------------------------------

describe("match — dm-registration", () => {
  it("/start → usage-hint DM actions, no registerResident action", () => {
    const state: State = {
      kind: "dm-registration",
      inbound: makeDmRegistrationInbound({ text: "/start", fromLanguageCode: "de" }),
    };
    const { actions } = match(state);
    // Three actions: emitTrace registration.start, sendDirectMessage, emitTrace registration.end
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({ kind: "emit-trace", stage: "registration", phase: "start" });
    expect(actions[1]).toMatchObject({ kind: "send-direct-message", chatId: 99 });
    const dmText = (actions[1] as Extract<typeof actions[1], { kind: "send-direct-message" }>).text;
    expect(dmText).toContain("/register");
    expect(dmText).toContain("<Name>");
    expect(actions[2]).toMatchObject({ kind: "emit-trace", stage: "registration", phase: "end" });
  });

  it("/start with deeplink token → same usage-hint", () => {
    const state: State = {
      kind: "dm-registration",
      inbound: makeDmRegistrationInbound({ text: "/start ref_abc123", fromLanguageCode: "en" }),
    };
    const { actions } = match(state);
    expect(actions[1]).toMatchObject({ kind: "send-direct-message" });
    const dmText = (actions[1] as Extract<typeof actions[1], { kind: "send-direct-message" }>).text;
    expect(dmText).toContain("Please write: /register");
  });

  it("bare /register → usage-hint DM, no registerResident action", () => {
    const state: State = {
      kind: "dm-registration",
      inbound: makeDmRegistrationInbound({ text: "/register", fromLanguageCode: "de" }),
    };
    const { actions } = match(state);
    expect(actions).toHaveLength(3);
    expect(actions[1]).toMatchObject({ kind: "send-direct-message" });
    const dmText = (actions[1] as Extract<typeof actions[1], { kind: "send-direct-message" }>).text;
    expect(dmText).toContain("/register");
  });

  it("/register with full args → register-and-confirm-resident action", () => {
    const state: State = {
      kind: "dm-registration",
      inbound: makeDmRegistrationInbound({
        text: "/register Diego de Miguel Lutterothstrasse 69 Erdgeschoss Links",
        fromUserId: 42,
        fromLanguageCode: "de",
      }),
    };
    const { actions } = match(state);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "register-and-confirm-resident",
      chatId: 99,
      fallbackLanguageCode: "de",
      input: {
        name: "Diego de Miguel",
        street: "Lutterothstrasse",
        houseNumber: "69",
        floor: "Erdgeschoss",
        buzzerName: "Links",
        platformId: "42",
        telegramLanguageCode: "de",
      },
    });
  });

  it("free-text registration → register-and-confirm-resident action", () => {
    const state: State = {
      kind: "dm-registration",
      inbound: makeDmRegistrationInbound({
        text: "Diego de Miguel, Lutterothstrasse 69",
        fromUserId: 7,
        fromLanguageCode: null,
      }),
    };
    const { actions } = match(state);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "register-and-confirm-resident",
      input: expect.objectContaining({ name: "Diego de Miguel", platformId: "7" }),
    });
  });

  it("usage hint uses English for en language code", () => {
    const state: State = {
      kind: "dm-registration",
      inbound: makeDmRegistrationInbound({ text: "/start", fromLanguageCode: "en" }),
    };
    const { actions } = match(state);
    const dmText = (actions[1] as Extract<typeof actions[1], { kind: "send-direct-message" }>).text;
    expect(dmText).toContain("Please write: /register");
  });
});

// ---------------------------------------------------------------------------
// runActions — register-and-confirm-resident
// ---------------------------------------------------------------------------

describe("runActions — register-and-confirm-resident", () => {
  const mockResident: Resident = {
    id: "99",
    name: "Diego de Miguel",
    street: "Lutterothstrasse",
    houseNumber: "69",
    floor: "Erdgeschoss",
    platformId: "99",
    platform: "telegram",
    language: "de",
    availabilityPatterns: [],
    registeredAt: 1716000000000,
    source: "explicit",
    confirmed: true,
  };

  it("calls registerResident then sendDirectMessage with confirmation, emits traces", async () => {
    const deps = makeDeps({
      registerResident: vi.fn().mockResolvedValue({ resident: mockResident, updated: false }),
    });
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    await runWithTrace({ traceId: "t1", kind: "text" }, () =>
      runActions(
        [Action.registerAndConfirmResident(99, {
          name: "Diego de Miguel",
          street: "Lutterothstrasse",
          houseNumber: "69",
          platformId: "99",
          telegramLanguageCode: "de",
        }, "de")],
        deps,
      ),
    );

    unsub();
    expect(deps.registerResident).toHaveBeenCalledTimes(1);
    expect(deps.sendDirectMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = (deps.sendDirectMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe(99);
    expect(text).toContain("Vielen Dank");
    expect(text).toContain("Diego de Miguel");
    expect(events).toEqual([
      "registration.start",
      "dm.start",
      "dm.end",
      "registration.end",
    ]);
  });

  it("uses resident.language for confirmation DM, not fallbackLanguageCode", async () => {
    const englishResident: Resident = { ...mockResident, language: "en" };
    const deps = makeDeps({
      registerResident: vi.fn().mockResolvedValue({ resident: englishResident, updated: true }),
    });

    await runActions(
      [Action.registerAndConfirmResident(99, {
        name: "Diego de Miguel",
        street: "Lutterothstrasse",
        houseNumber: "69",
        platformId: "99",
        telegramLanguageCode: "de",
      }, "de")],
      deps,
    );

    const [, text] = (deps.sendDirectMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(text).toContain("Thanks");
    expect(text).not.toContain("Vielen Dank");
  });

  it("rethrows when registerResident fails (caller falls through to agent)", async () => {
    const deps = makeDeps({
      registerResident: vi.fn().mockRejectedValue(new Error("redis down")),
    });

    await expect(
      runActions(
        [Action.registerAndConfirmResident(99, {
          name: "Diego de Miguel",
          street: "Lutterothstrasse",
          houseNumber: "69",
          platformId: "99",
          telegramLanguageCode: "de",
        }, "de")],
        deps,
      ),
    ).rejects.toThrow("redis down");

    expect(deps.sendDirectMessage).not.toHaveBeenCalled();
  });

  it("does not rethrow when sendDirectMessage fails (registration already landed)", async () => {
    const deps = makeDeps({
      registerResident: vi.fn().mockResolvedValue({ resident: mockResident, updated: false }),
      sendDirectMessage: vi.fn().mockRejectedValue(new Error("Telegram down")),
    });

    await expect(
      runActions(
        [Action.registerAndConfirmResident(99, {
          name: "Diego de Miguel",
          street: "Lutterothstrasse",
          houseNumber: "69",
          platformId: "99",
          telegramLanguageCode: "de",
        }, "de")],
        deps,
      ),
    ).resolves.toBeUndefined();
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

// ---------------------------------------------------------------------------
// Slice 4 callback variants — fixtures + helpers
// ---------------------------------------------------------------------------

function makeCallback(
  overrides: Partial<TelegramInboundCallback> = {},
): TelegramInboundCallback {
  return {
    callbackId: "cb_1",
    chatId: 555,
    messageId: 99,
    fromUserId: 11111,
    fromLanguageCode: "de",
    fromFirstName: null,
    fromLastName: null,
    fromUsername: null,
    isGroup: false,
    data: "noop",
    ...overrides,
  };
}

const holderResident: Resident = {
  ...resident,
  id: "res_holder",
  platformId: "22222",
  name: "Holder Hannes",
  language: "en",
};

const requesterResident: Resident = {
  ...resident,
  // Resident id == platformId in production (registration.ts:254). The
  // match arm derives the requester DM chat id via `Number(requester.id)`,
  // so the fixture has to round-trip cleanly through Number().
  id: "33333",
  platformId: "33333",
  name: "Requester Rita",
  houseNumber: "7",
  language: "es",
};

const samplePackage: Package = {
  id: "pkg_1",
  streetId: "street_1",
  recipientResidentId: "res_1",
  recipientName: "Diego Demo",
  recipientHouseNumber: "42",
  holderResidentId: "res_holder",
  carrier: "DHL",
  status: "picked_up",
  receivedAt: 1700000000,
  pickedUpAt: 1700001000,
  reminded: false,
};

const pickupSuccessResult: ConfirmPickupResult = {
  package: samplePackage,
  holder: {
    id: holderResident.id,
    platformId: holderResident.platformId,
    name: holderResident.name,
    houseNumber: holderResident.houseNumber,
    language: holderResident.language ?? null,
  },
  recipient: {
    id: resident.id,
    name: resident.name,
    houseNumber: resident.houseNumber,
    language: resident.language ?? null,
  },
};

const sampleRequest: ReceptionRequest = {
  id: "rr_1",
  streetId: "street_1",
  requesterResidentId: requesterResident.id,
  requesterName: requesterResident.name,
  requesterHouseNumber: requesterResident.houseNumber,
  carrier: "DHL",
  expectedAt: null,
  volunteerResidentId: resident.id,
  volunteerAvailability: null,
  status: "matched",
  createdAt: 1700000000,
  respondedAt: 1700001000,
};

const acceptSuccessResult: AcceptReceptionRequestResult = {
  request: sampleRequest,
  requester: {
    id: requesterResident.id,
    name: requesterResident.name,
    houseNumber: requesterResident.houseNumber,
    language: requesterResident.language ?? null,
    floor: null,
    buzzerName: null,
  },
  volunteer: {
    id: resident.id,
    name: resident.name,
    houseNumber: resident.houseNumber,
    language: resident.language ?? null,
    floor: null,
    buzzerName: null,
    platformId: resident.platformId,
  },
  groupCardChatId: -100100,
  groupCardMessageId: 77,
};

function makeBuildDeps(overrides: Partial<BuildStateDeps> = {}): BuildStateDeps {
  return {
    getRegisteredResident: vi.fn().mockResolvedValue(resident),
    isRegisteredResident: vi.fn().mockResolvedValue(true),
    confirmPickup: vi.fn().mockResolvedValue(pickupSuccessResult),
    acceptReceptionRequest: vi.fn().mockResolvedValue(acceptSuccessResult),
    parsePackagePhoto: vi
      .fn()
      .mockResolvedValue({ kind: "unknown", confidence: "low", reason: "test" }),
    getFileUrl: vi.fn().mockResolvedValue("https://example.test/file"),
    classifyDmIntent: vi
      .fn()
      .mockResolvedValue({ kind: "other", absenceSignal: false, confidence: "low", reason: "test" }),
    classifyGroupMessage: vi.fn().mockResolvedValue({
      isPackageRegistration: false,
      recipients: [],
      confidence: "low",
      reason: "test",
    }),
    ...overrides,
  };
}

function pickupErrorWithCode(
  code: typeof PICKUP_NOT_RECIPIENT_ERROR_CODE | typeof PICKUP_ALREADY_DONE_ERROR_CODE,
): ConfirmPickupError {
  return new ConfirmPickupError(code, `lib threw ${code}`);
}

function acceptErrorWithCode(
  code:
    | typeof ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE
    | typeof ACCEPT_DIFFERENT_STREET_ERROR_CODE,
): AcceptReceptionRequestError {
  return new AcceptReceptionRequestError(code, `lib threw ${code}`);
}

// ---------------------------------------------------------------------------
// match — callback-pickup* family (Slice 4 #135)
// ---------------------------------------------------------------------------

describe("match: callback-pickup family", () => {
  it("callback-pickup (success) emits ack → strip → recipient DM → holder DM", () => {
    const cb = makeCallback({ data: "confirm_pickup:pkg_1" });
    const state: State = {
      kind: "callback-pickup",
      inbound: cb,
      caller: resident,
      result: pickupSuccessResult,
    };

    const { actions } = match(state);

    // Recipient-confirm DM must come BEFORE holder-thanks DM (#580cdc7).
    expect(actions.map((a) => a.kind)).toEqual([
      "answer-callback",
      "strip-keyboard",
      "send-direct-message",
      "send-direct-message",
    ]);
    expect(actions[0]).toMatchObject({ callbackId: "cb_1" });
    expect(actions[0]).not.toHaveProperty("text");
    expect(actions[1]).toMatchObject({ chatId: cb.chatId, messageId: cb.messageId });
    expect(actions[2]).toMatchObject({ chatId: cb.chatId, text: "Hab notiert — danke!" });
    expect(actions[3]).toMatchObject({ chatId: Number(holderResident.platformId) });
  });

  it("callback-pickup logs an error and skips holder DM when holder.platformId is not finite", () => {
    const result: ConfirmPickupResult = {
      ...pickupSuccessResult,
      holder: { ...pickupSuccessResult.holder!, platformId: "not-a-number" },
    };
    const { actions } = match({
      kind: "callback-pickup",
      inbound: makeCallback({ data: "confirm_pickup:pkg_1" }),
      caller: resident,
      result,
    });

    expect(actions.map((a) => a.kind)).toEqual([
      "answer-callback",
      "strip-keyboard",
      "send-direct-message",
      "log-error",
    ]);
  });

  it("callback-pickup-not-recipient emits a localised toast and leaves the keyboard live", () => {
    const cb = makeCallback({ data: "confirm_pickup:pkg_1", fromLanguageCode: "en" });
    const { actions } = match({
      kind: "callback-pickup-not-recipient",
      inbound: cb,
      caller: { ...resident, language: undefined },
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "answer-callback",
      callbackId: "cb_1",
      text: "You are not the recipient of this package.",
    });
  });

  it("callback-pickup-already-done emits the already-done toast (no keyboard action)", () => {
    const { actions } = match({
      kind: "callback-pickup-already-done",
      inbound: makeCallback({ data: "confirm_pickup:pkg_1" }),
      caller: resident,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "answer-callback",
      text: "Dieses Paket wurde schon abgeholt.",
    });
  });

  it("callback-pickup-error emits the retry toast (keyboard stays live)", () => {
    const { actions } = match({
      kind: "callback-pickup-error",
      inbound: makeCallback({ data: "confirm_pickup:pkg_1" }),
      language: resident.language ?? null,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "answer-callback",
      text: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
    });
  });

  it("callback-pickup-unregistered emits the not-recipient toast off cb.fromLanguageCode", () => {
    // Unregistered means there is no `caller.language` to consult.
    const cb = makeCallback({ data: "confirm_pickup:pkg_1", fromLanguageCode: "es" });
    const { actions } = match({ kind: "callback-pickup-unregistered", inbound: cb });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "answer-callback",
      text: "No eres el destinatario de este paquete.",
    });
  });
});

// ---------------------------------------------------------------------------
// match — callback-accept* family (Slice 4 #135)
// ---------------------------------------------------------------------------

describe("match: callback-accept family", () => {
  it("callback-accept emits ack → strip → group edit → volunteer DM → requester DM with mention entity", () => {
    const cb = makeCallback({ data: "accept_reception_group:rr_1" });
    const { actions } = match({
      kind: "callback-accept",
      inbound: cb,
      volunteer: resident,
      result: acceptSuccessResult,
    });

    expect(actions.map((a) => a.kind)).toEqual([
      "answer-callback",
      "strip-keyboard",
      "edit-group-card",
      "send-direct-message",
      "send-direct-message",
    ]);

    expect(actions[2]).toMatchObject({
      kind: "edit-group-card",
      chatId: acceptSuccessResult.groupCardChatId,
      messageId: acceptSuccessResult.groupCardMessageId,
      text: `✅ angenommen von ${acceptSuccessResult.volunteer.name}`,
    });

    expect(actions[3]).toMatchObject({
      kind: "send-direct-message",
      chatId: Number(acceptSuccessResult.volunteer.platformId),
    });

    const requesterDm = actions[4];
    expect(requesterDm).toMatchObject({
      kind: "send-direct-message",
      chatId: Number(acceptSuccessResult.requester.id),
    });
    if (requesterDm?.kind === "send-direct-message") {
      expect(requesterDm.entities).toBeDefined();
      expect(requesterDm.entities?.[0]).toMatchObject({ type: "text_mention" });
    }
  });

  it("callback-accept skips the group-card edit when groupCard ids are null", () => {
    const result: AcceptReceptionRequestResult = {
      ...acceptSuccessResult,
      groupCardChatId: null,
      groupCardMessageId: null,
    };
    const { actions } = match({
      kind: "callback-accept",
      inbound: makeCallback({ data: "accept_reception_group:rr_1" }),
      volunteer: resident,
      result,
    });

    expect(actions.map((a) => a.kind)).toEqual([
      "answer-callback",
      "strip-keyboard",
      "send-direct-message",
      "send-direct-message",
    ]);
  });

  it("callback-accept-self emits the self-tap toast and leaves the keyboard live (#101)", () => {
    const { actions } = match({
      kind: "callback-accept-self",
      inbound: makeCallback({ data: "accept_reception_group:rr_1" }),
      volunteer: resident,
    });

    expect(actions).toHaveLength(1);
    expect(actions.some((a) => a.kind === "strip-keyboard")).toBe(false);
    expect(actions[0]).toMatchObject({
      kind: "answer-callback",
      text: "Du kannst dein eigenes Paket nicht selbst annehmen.",
    });
  });

  it("callback-accept-cross-street emits the cross-street toast AND strips the keyboard (#96 Part B)", () => {
    const cb = makeCallback({ data: "accept_reception_group:rr_1" });
    const { actions } = match({
      kind: "callback-accept-cross-street",
      inbound: cb,
      volunteer: resident,
    });

    expect(actions.map((a) => a.kind)).toEqual(["answer-callback", "strip-keyboard"]);
    expect(actions[0]).toMatchObject({
      kind: "answer-callback",
      text: "Du und dieser Nachbar müsst auf derselben Straße wohnen.",
    });
    expect(actions[1]).toMatchObject({ chatId: cb.chatId, messageId: cb.messageId });
  });

  it("callback-accept-error emits the generic retry toast (keyboard stays live)", () => {
    const { actions } = match({
      kind: "callback-accept-error",
      inbound: makeCallback({ data: "accept_reception_group:rr_1" }),
      language: resident.language ?? null,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "answer-callback",
      text: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
    });
  });

  it("callback-accept-unregistered emits the German /register nudge toast (keyboard stays live)", () => {
    // The nudge text is hard-coded German regardless of caller language;
    // a not-yet-registered user has no stored language anyway.
    const { actions } = match({
      kind: "callback-accept-unregistered",
      inbound: makeCallback({ data: "accept_reception_group:rr_1", fromLanguageCode: "en" }),
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "answer-callback",
      text: "Bitte zuerst /register, um Paketen zu helfen.",
    });
  });
});

// ---------------------------------------------------------------------------
// match — callback-agent (Slice 4 #135)
// ---------------------------------------------------------------------------

describe("match: callback-agent", () => {
  it("emits ack → strip → set-trigger → send-to-ash with auth derived from cb metadata", () => {
    const cb = makeCallback({
      data: "decline_reception_request:rr_1",
      fromLanguageCode: "es",
    });
    const synthetic = "[button-tap] declined";

    const { actions } = match({ kind: "callback-agent", inbound: cb, synthetic });

    expect(actions.map((a) => a.kind)).toEqual([
      "answer-callback",
      "strip-keyboard",
      "set-trigger-attribute",
      "send-to-ash",
    ]);

    expect(actions[2]).toMatchObject({
      kind: "set-trigger-attribute",
      trigger: "telegram.callback",
    });

    const ash = actions[3];
    expect(ash).toMatchObject({
      kind: "send-to-ash",
      message: synthetic,
      continuationToken: `tg:${cb.chatId}`,
    });
    if (ash?.kind === "send-to-ash") {
      expect(ash.auth).toMatchObject({
        principalId: String(cb.fromUserId),
        principalType: "user",
        authenticator: "telegram",
        attributes: { languageCode: "es" },
      });
      expect(ash.state).toMatchObject({
        chatId: cb.chatId,
        isGroup: cb.isGroup,
        fromUserId: cb.fromUserId,
        fromLanguageCode: cb.fromLanguageCode,
      });
    }
  });

  it("omits the languageCode attribute when cb.fromLanguageCode is null", () => {
    const cb = makeCallback({ data: "remind_later:pkg_1", fromLanguageCode: null });
    const { actions } = match({
      kind: "callback-agent",
      inbound: cb,
      synthetic: "[button-tap] remind",
    });
    const ash = actions[3];
    if (ash?.kind === "send-to-ash") {
      expect(ash.auth?.attributes).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// buildState — callback-pickup* family (Slice 4 #135)
// ---------------------------------------------------------------------------

describe("buildState: callback-pickup family", () => {
  it("returns callback-pickup on confirmPickup success and emits flow1.pickup.start/end", async () => {
    const deps = makeBuildDeps();
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    const cb = makeCallback({ data: "confirm_pickup:pkg_1" });
    const state = await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
      buildState({ kind: "callback", callback: cb }, deps),
    );
    unsub();

    expect(state).toMatchObject({
      kind: "callback-pickup",
      caller: resident,
      result: pickupSuccessResult,
    });
    expect(deps.confirmPickup).toHaveBeenCalledWith(resident, "pkg_1");
    expect(events).toEqual(["flow1.pickup.start", "flow1.pickup.end"]);
  });

  it("returns callback-pickup-not-recipient on PICKUP_NOT_RECIPIENT and emits the reject.not-recipient trace", async () => {
    const deps = makeBuildDeps({
      confirmPickup: vi
        .fn()
        .mockRejectedValue(pickupErrorWithCode(PICKUP_NOT_RECIPIENT_ERROR_CODE)),
    });
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    const state = await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
      buildState(
        { kind: "callback", callback: makeCallback({ data: "confirm_pickup:pkg_1" }) },
        deps,
      ),
    );
    unsub();

    expect(state.kind).toBe("callback-pickup-not-recipient");
    expect(events).toEqual(["flow1.pickup.start", "flow1.pickup.reject.not-recipient"]);
  });

  it("returns callback-pickup-already-done on PICKUP_ALREADY_DONE", async () => {
    const deps = makeBuildDeps({
      confirmPickup: vi
        .fn()
        .mockRejectedValue(pickupErrorWithCode(PICKUP_ALREADY_DONE_ERROR_CODE)),
    });
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    const state = await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
      buildState(
        { kind: "callback", callback: makeCallback({ data: "confirm_pickup:pkg_1" }) },
        deps,
      ),
    );
    unsub();

    expect(state.kind).toBe("callback-pickup-already-done");
    expect(events).toEqual(["flow1.pickup.start", "flow1.pickup.reject.already-done"]);
  });

  it("returns callback-pickup-error on any other confirmPickup throw and emits reject.redis-hiccup", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeBuildDeps({
      confirmPickup: vi.fn().mockRejectedValue(new Error("Redis down")),
    });
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    const state = await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
      buildState(
        { kind: "callback", callback: makeCallback({ data: "confirm_pickup:pkg_1" }) },
        deps,
      ),
    );
    unsub();
    errorSpy.mockRestore();

    expect(state.kind).toBe("callback-pickup-error");
    expect(events).toEqual(["flow1.pickup.start", "flow1.pickup.reject.redis-hiccup"]);
  });

  it("returns callback-pickup-error when getRegisteredResident throws (Redis hiccup pre-pickup)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeBuildDeps({
      getRegisteredResident: vi.fn().mockRejectedValue(new Error("Redis down")),
    });

    const state = await buildState(
      { kind: "callback", callback: makeCallback({ data: "confirm_pickup:pkg_1" }) },
      deps,
    );
    errorSpy.mockRestore();

    expect(state.kind).toBe("callback-pickup-error");
    expect(deps.confirmPickup).not.toHaveBeenCalled();
  });

  it("returns callback-pickup-unregistered when getRegisteredResident resolves null", async () => {
    const deps = makeBuildDeps({
      getRegisteredResident: vi.fn().mockResolvedValue(null),
    });

    const state = await buildState(
      { kind: "callback", callback: makeCallback({ data: "confirm_pickup:pkg_1" }) },
      deps,
    );

    expect(state.kind).toBe("callback-pickup-unregistered");
    expect(deps.confirmPickup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildState — callback-accept* family (Slice 4 #135)
// ---------------------------------------------------------------------------

describe("buildState: callback-accept family", () => {
  it("returns callback-accept on success and emits flow2.accept.start/end", async () => {
    const deps = makeBuildDeps();
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    const state = await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
      buildState(
        { kind: "callback", callback: makeCallback({ data: "accept_reception_group:rr_1" }) },
        deps,
      ),
    );
    unsub();

    expect(state).toMatchObject({
      kind: "callback-accept",
      volunteer: resident,
      result: acceptSuccessResult,
    });
    expect(deps.acceptReceptionRequest).toHaveBeenCalledWith(resident, { requestId: "rr_1" });
    expect(events).toEqual(["flow2.accept.start", "flow2.accept.end"]);
  });

  it("returns callback-accept-self on ACCEPT_RECEPTION_SELF_NOT_ALLOWED and emits flow2.reject.self", async () => {
    const deps = makeBuildDeps({
      acceptReceptionRequest: vi
        .fn()
        .mockRejectedValue(acceptErrorWithCode(ACCEPT_SELF_NOT_ALLOWED_ERROR_CODE)),
    });
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    const state = await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
      buildState(
        { kind: "callback", callback: makeCallback({ data: "accept_reception_group:rr_1" }) },
        deps,
      ),
    );
    unsub();

    expect(state.kind).toBe("callback-accept-self");
    expect(events).toEqual(["flow2.accept.start", "flow2.reject.self"]);
  });

  it("returns callback-accept-cross-street on ACCEPT_DIFFERENT_STREET and emits flow2.reject.cross-street", async () => {
    const deps = makeBuildDeps({
      acceptReceptionRequest: vi
        .fn()
        .mockRejectedValue(acceptErrorWithCode(ACCEPT_DIFFERENT_STREET_ERROR_CODE)),
    });
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    const state = await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
      buildState(
        { kind: "callback", callback: makeCallback({ data: "accept_reception_group:rr_1" }) },
        deps,
      ),
    );
    unsub();

    expect(state.kind).toBe("callback-accept-cross-street");
    expect(events).toEqual(["flow2.accept.start", "flow2.reject.cross-street"]);
  });

  it("returns callback-accept-error on any other acceptReceptionRequest throw and emits flow2.reject.redis-hiccup", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeBuildDeps({
      acceptReceptionRequest: vi.fn().mockRejectedValue(new Error("Bot API blew up")),
    });
    const events: string[] = [];
    const unsub = subscribe((e) => events.push(`${e.stage}.${e.phase}`));

    const state = await runWithTrace({ traceId: "t1", kind: "callback" }, () =>
      buildState(
        { kind: "callback", callback: makeCallback({ data: "accept_reception_group:rr_1" }) },
        deps,
      ),
    );
    unsub();
    errorSpy.mockRestore();

    expect(state.kind).toBe("callback-accept-error");
    expect(events).toEqual(["flow2.accept.start", "flow2.reject.redis-hiccup"]);
  });

  it("returns callback-accept-unregistered when isRegisteredResident resolves false", async () => {
    const deps = makeBuildDeps({
      isRegisteredResident: vi.fn().mockResolvedValue(false),
    });

    const state = await buildState(
      { kind: "callback", callback: makeCallback({ data: "accept_reception_group:rr_1" }) },
      deps,
    );

    expect(state.kind).toBe("callback-accept-unregistered");
    expect(deps.getRegisteredResident).not.toHaveBeenCalled();
    expect(deps.acceptReceptionRequest).not.toHaveBeenCalled();
  });

  it("returns callback-accept-unregistered when isRegisteredResident throws (treated as unregistered)", async () => {
    const deps = makeBuildDeps({
      isRegisteredResident: vi.fn().mockRejectedValue(new Error("Redis hiccup")),
    });

    const state = await buildState(
      { kind: "callback", callback: makeCallback({ data: "accept_reception_group:rr_1" }) },
      deps,
    );

    expect(state.kind).toBe("callback-accept-unregistered");
    expect(deps.acceptReceptionRequest).not.toHaveBeenCalled();
  });

  it("returns callback-accept-error when getRegisteredResident throws after the registered-gate", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeBuildDeps({
      isRegisteredResident: vi.fn().mockResolvedValue(true),
      getRegisteredResident: vi.fn().mockRejectedValue(new Error("Redis down")),
    });

    const state = await buildState(
      { kind: "callback", callback: makeCallback({ data: "accept_reception_group:rr_1" }) },
      deps,
    );
    errorSpy.mockRestore();

    expect(state.kind).toBe("callback-accept-error");
    expect(deps.acceptReceptionRequest).not.toHaveBeenCalled();
  });

  it("returns callback-accept-error when getRegisteredResident resolves null after the registered-gate (race)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeBuildDeps({
      isRegisteredResident: vi.fn().mockResolvedValue(true),
      getRegisteredResident: vi.fn().mockResolvedValue(null),
    });

    const state = await buildState(
      { kind: "callback", callback: makeCallback({ data: "accept_reception_group:rr_1" }) },
      deps,
    );
    errorSpy.mockRestore();

    expect(state.kind).toBe("callback-accept-error");
    expect(deps.acceptReceptionRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildState — callback-agent fallthrough (Slice 4 #135)
// ---------------------------------------------------------------------------

describe("buildState: callback-agent fallthrough", () => {
  const cases: Array<{ data: string; matches: RegExp }> = [
    {
      // Legacy v2 DM-3 button — channel never wires it now; surfaces an apology synthetic.
      data: "accept_reception_request:rr_old",
      matches: /old 'I can help' button/i,
    },
    {
      // Malformed `accept_reception_group` (no id) — falls through to agent.
      data: "accept_reception_group:",
      matches: /no request id was attached/i,
    },
    {
      data: "decline_reception_request:rr_2",
      matches: /declining the reception request rr_2/i,
    },
    {
      data: "remind_later:pkg_2",
      matches: /reminded about package pkg_2/i,
    },
    {
      data: "totally_unknown_action:hello",
      matches: /action=totally_unknown_action id=hello/i,
    },
    {
      data: "totally_unknown_action",
      matches: /action=totally_unknown_action/i,
    },
  ];

  for (const { data, matches } of cases) {
    it(`produces a callback-agent state with the expected synthetic for "${data}"`, async () => {
      const deps = makeBuildDeps();
      const state = await buildState(
        { kind: "callback", callback: makeCallback({ data }) },
        deps,
      );

      expect(state.kind).toBe("callback-agent");
      if (state.kind === "callback-agent") {
        expect(state.synthetic).toMatch(matches);
      }
      // None of the dispatched lib calls should fire for fallthrough paths.
      expect(deps.confirmPickup).not.toHaveBeenCalled();
      expect(deps.acceptReceptionRequest).not.toHaveBeenCalled();
      expect(deps.isRegisteredResident).not.toHaveBeenCalled();
      expect(deps.getRegisteredResident).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-cutting assertions — toast localisation + trace topology
// ---------------------------------------------------------------------------

describe("toast localisation: caller.language preferred over cb.fromLanguageCode", () => {
  it("callback-pickup-not-recipient uses caller.language when set", () => {
    const { actions } = match({
      kind: "callback-pickup-not-recipient",
      inbound: makeCallback({ fromLanguageCode: "tr" }),
      caller: { ...resident, language: "en" },
    });
    expect(actions[0]).toMatchObject({
      text: "You are not the recipient of this package.",
    });
  });

  it("callback-pickup-not-recipient falls back to cb.fromLanguageCode when caller.language is null", () => {
    const { actions } = match({
      kind: "callback-pickup-not-recipient",
      inbound: makeCallback({ fromLanguageCode: "es" }),
      caller: { ...resident, language: undefined },
    });
    expect(actions[0]).toMatchObject({
      text: "No eres el destinatario de este paquete.",
    });
  });

  it("callback-accept-cross-street uses volunteer.language when set", () => {
    const { actions } = match({
      kind: "callback-accept-cross-street",
      inbound: makeCallback({ fromLanguageCode: "tr" }),
      volunteer: { ...resident, language: "en" },
    });
    expect(actions[0]).toMatchObject({
      text: "You and this neighbor must live on the same street.",
    });
  });

  it("callback-accept-self falls back to cb.fromLanguageCode when volunteer.language is null", () => {
    const { actions } = match({
      kind: "callback-accept-self",
      inbound: makeCallback({ fromLanguageCode: "en" }),
      volunteer: { ...resident, language: undefined },
    });
    expect(actions[0]).toMatchObject({
      text: "You can't volunteer for your own package.",
    });
  });
});

describe("keyboard tolerance per variant", () => {
  // Re-asserts the per-variant keyboard rules in one place so a future
  // change that accidentally strips a "live keyboard" branch is caught
  // by a dedicated regression test rather than only via the per-variant
  // shape tests above.
  it.each([
    {
      label: "callback-pickup (success) strips",
      state: {
        kind: "callback-pickup" as const,
        inbound: makeCallback({ data: "confirm_pickup:pkg_1" }),
        caller: resident,
        result: pickupSuccessResult,
      },
      strips: true,
    },
    {
      label: "callback-pickup-not-recipient leaves live",
      state: {
        kind: "callback-pickup-not-recipient" as const,
        inbound: makeCallback({ data: "confirm_pickup:pkg_1" }),
        caller: resident,
      },
      strips: false,
    },
    {
      label: "callback-pickup-already-done leaves live",
      state: {
        kind: "callback-pickup-already-done" as const,
        inbound: makeCallback({ data: "confirm_pickup:pkg_1" }),
        caller: resident,
      },
      strips: false,
    },
    {
      label: "callback-pickup-error leaves live",
      state: {
        kind: "callback-pickup-error" as const,
        inbound: makeCallback({ data: "confirm_pickup:pkg_1" }),
        caller: resident,
      },
      strips: false,
    },
    {
      label: "callback-pickup-unregistered leaves live",
      state: {
        kind: "callback-pickup-unregistered" as const,
        inbound: makeCallback({ data: "confirm_pickup:pkg_1" }),
      },
      strips: false,
    },
    {
      label: "callback-accept (success) strips",
      state: {
        kind: "callback-accept" as const,
        inbound: makeCallback({ data: "accept_reception_group:rr_1" }),
        volunteer: resident,
        result: acceptSuccessResult,
      },
      strips: true,
    },
    {
      label: "callback-accept-self leaves live (#101)",
      state: {
        kind: "callback-accept-self" as const,
        inbound: makeCallback({ data: "accept_reception_group:rr_1" }),
        volunteer: resident,
      },
      strips: false,
    },
    {
      label: "callback-accept-cross-street strips (#96 Part B)",
      state: {
        kind: "callback-accept-cross-street" as const,
        inbound: makeCallback({ data: "accept_reception_group:rr_1" }),
        volunteer: resident,
      },
      strips: true,
    },
    {
      label: "callback-accept-error leaves live",
      state: {
        kind: "callback-accept-error" as const,
        inbound: makeCallback({ data: "accept_reception_group:rr_1" }),
        volunteer: resident,
      },
      strips: false,
    },
    {
      label: "callback-accept-unregistered leaves live",
      state: {
        kind: "callback-accept-unregistered" as const,
        inbound: makeCallback({ data: "accept_reception_group:rr_1" }),
      },
      strips: false,
    },
  ])("$label", ({ state, strips }) => {
    const { actions } = match(state as State);
    expect(actions.some((a) => a.kind === "strip-keyboard")).toBe(strips);
  });
});
