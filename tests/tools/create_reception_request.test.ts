import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceptionRequest, Resident } from "../../lib/redis.js";

const sessionMock = vi.hoisted(() => ({ value: null as unknown }));
const residentStore = vi.hoisted(() => new Map<string, Resident>());
const requestStore = vi.hoisted(() => new Map<string, ReceptionRequest>());
const streetIndex = vi.hoisted(() => new Map<string, Set<string>>());

vi.mock("experimental-ash/context", () => ({
  getSession: () => sessionMock.value,
}));

vi.mock("../../lib/redis.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/redis.js")>(
    "../../lib/redis.js",
  );
  return {
    ...actual,
    async getResident(platformId: string) {
      return residentStore.get(platformId) ?? null;
    },
    async setReceptionRequest(req: ReceptionRequest) {
      requestStore.set(req.id, req);
      if (!streetIndex.has(req.streetId))
        streetIndex.set(req.streetId, new Set());
      streetIndex.get(req.streetId)!.add(req.id);
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/create_reception_request.js");
  return mod.default;
}

function withTelegramSession(principalId: string): void {
  sessionMock.value = {
    sessionId: "sess-test",
    turn: { id: "turn-1", index: 0 },
    auth: {
      current: {
        attributes: {},
        authenticator: "telegram",
        principalId,
        principalType: "user",
      },
      initiator: {
        attributes: {},
        authenticator: "telegram",
        principalId,
        principalType: "user",
      },
    },
  };
}

function seedResident(overrides: Partial<Resident> & { platformId: string }): Resident {
  const r: Resident = {
    id: overrides.id ?? overrides.platformId,
    name: overrides.name ?? "Test Resident",
    street: overrides.street ?? "Examplestraße",
    houseNumber: overrides.houseNumber ?? "10",
    floor: overrides.floor,
    buzzerName: overrides.buzzerName,
    platformId: overrides.platformId,
    platform: "telegram",
    language: overrides.language ?? "de",
    availabilityPatterns: overrides.availabilityPatterns ?? [],
    registeredAt: overrides.registeredAt ?? Date.now(),
    source: overrides.source ?? "explicit",
    confirmed: overrides.confirmed ?? true,
  };
  residentStore.set(r.platformId, r);
  return r;
}

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

const TEST_TOKEN = "111222:abcdef";
const TEST_GROUP_ID = "-1001234567890";

describe("create_reception_request", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    residentStore.clear();
    requestStore.clear();
    streetIndex.clear();
    sessionMock.value = null;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 4242 } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = TEST_TOKEN;
    process.env.TELEGRAM_GROUP_CHAT_ID = TEST_GROUP_ID;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_GROUP_CHAT_ID;
  });

  describe("group-card path (default)", () => {
    it("writes an 'open' ReceptionRequest, posts a neutral group card, patches messageId", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");

      // 2026-05-19T12:00:00Z → 14:00 Berlin (CEST), 2026-05-19T14:00:00Z → 16:00 Berlin
      const start = Date.UTC(2026, 4, 19, 12, 0);
      const end = Date.UTC(2026, 4, 19, 14, 0);

      const result = (await runExecute({
        carrier: "DHL",
        trackingNumber: "AB123CD",
        expectedWindowStart: start,
        expectedWindowEnd: end,
        parseConfidence: "high",
      })) as { request: ReceptionRequest; groupCardPosted: boolean };

      expect(result.groupCardPosted).toBe(true);
      expect(result.request.status).toBe("open");
      expect(result.request.requesterResidentId).toBe("alice");
      expect(result.request.candidateResidentIds).toEqual([]);
      expect(result.request.carrier).toBe("DHL");
      expect(result.request.trackingNumber).toBe("AB123CD");
      expect(result.request.expectedWindowStartAt).toBe(start);
      expect(result.request.expectedWindowEndAt).toBe(end);
      expect(result.request.parseConfidence).toBe("high");
      expect(result.request.groupCardChatId).toBe(Number(TEST_GROUP_ID));
      expect(result.request.groupCardMessageId).toBe(4242);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`);
      const body = JSON.parse(init?.body as string);
      expect(body.chat_id).toBe(Number(TEST_GROUP_ID));
      expect(body.text).toContain("DHL-Paket");
      // The reference clock pins "today in Berlin" to 19.05 — start=14:00 end=16:00
      expect(body.text).toContain("14:00");
      expect(body.text).toContain("16:00");
      expect(body.text).toContain("Tracking AB123CD");
      expect(body.text).toContain("Kann jemand annehmen?");
      // Privacy: the requester is NOT named on the card.
      expect(body.text).not.toContain("alice");
      expect(body.text).not.toContain("Test Resident");
      expect(body.reply_markup.inline_keyboard).toEqual([
        [
          {
            text: "Ich kann helfen",
            callback_data: `accept_reception_group:${result.request.id}`,
          },
        ],
      ]);
    });

    it("renders 'heute' for a single-point ETA today (start === end)", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");

      // 2026-05-17T13:00:00Z → 15:00 Berlin (clock pinned to 10:00Z = 12:00 Berlin same day)
      const ts = Date.UTC(2026, 4, 17, 13, 0);

      await runExecute({
        carrier: "Hermes",
        expectedWindowStart: ts,
        expectedWindowEnd: ts,
      });

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect(body.text).toContain("heute 15:00");
    });

    it("falls back to expectedDate-only relative day when no window is supplied", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");

      await runExecute({
        carrier: "Amazon",
        expectedDate: "2026-05-18", // tomorrow relative to the pinned clock
      });

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect(body.text).toContain("Amazon-Paket");
      expect(body.text).toContain("morgen");
    });

    it("renders 'Paket' (no carrier label) when carrier is unknown", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");

      await runExecute({});

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect(body.text).toMatch(/^📦 Paket erwartet/);
      expect(body.text).not.toContain("unknown-Paket");
    });

    it("omits tracking line when no tracking number is supplied", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");

      await runExecute({ carrier: "DHL" });

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect(body.text).not.toContain("Tracking");
    });

    it("survives a Bot API response without a message_id (leaves the patch fields unset)", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const result = (await runExecute({
        carrier: "DHL",
      })) as { request: ReceptionRequest; groupCardPosted: boolean };

      expect(result.groupCardPosted).toBe(true);
      expect(result.request.groupCardMessageId).toBeUndefined();
      expect(result.request.groupCardChatId).toBeUndefined();
    });

    it("throws when TELEGRAM_BOT_TOKEN is unset", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");
      delete process.env.TELEGRAM_BOT_TOKEN;

      await expect(runExecute({ carrier: "DHL" })).rejects.toThrow(
        /TELEGRAM_BOT_TOKEN is not set/,
      );
    });

    it("throws when TELEGRAM_GROUP_CHAT_ID is unset", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");
      delete process.env.TELEGRAM_GROUP_CHAT_ID;

      await expect(runExecute({ carrier: "DHL" })).rejects.toThrow(
        /TELEGRAM_GROUP_CHAT_ID is not set/,
      );
    });

    it("refuses to record a window with only the start endpoint", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");

      await expect(
        runExecute({
          carrier: "DHL",
          expectedWindowStart: Date.UTC(2026, 4, 19, 12, 0),
        }),
      ).rejects.toThrow(/must be supplied together/);
    });

    it("refuses a window where start > end", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      withTelegramSession("alice");

      await expect(
        runExecute({
          carrier: "DHL",
          expectedWindowStart: Date.UTC(2026, 4, 19, 14, 0),
          expectedWindowEnd: Date.UTC(2026, 4, 19, 12, 0),
        }),
      ).rejects.toThrow(/<= expectedWindowEnd/);
    });
  });

  describe("DM-3-candidates path (soft-deprecated)", () => {
    it("writes the snapshot record and DOES NOT post a group card when postGroupCard: false", async () => {
      seedResident({ platformId: "alice", houseNumber: "10" });
      seedResident({ platformId: "candidate-1", houseNumber: "12" });
      withTelegramSession("alice");

      const result = (await runExecute({
        expectedDate: "2026-05-19",
        carrier: "DHL",
        notes: "DHL package, signature required",
        candidateResidentIds: ["candidate-1"],
        postGroupCard: false,
      })) as { request: ReceptionRequest; groupCardPosted: boolean };

      expect(result.groupCardPosted).toBe(false);
      expect(result.request.candidateResidentIds).toEqual(["candidate-1"]);
      expect(result.request.expectedAt).toBe(Date.parse("2026-05-19"));
      expect(result.request.groupCardMessageId).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falls back to the group-card path when candidateResidentIds is supplied without postGroupCard", async () => {
      // Backwards-compat: an old caller that passes candidateResidentIds but
      // doesn't know about postGroupCard still gets the new default
      // behaviour. That's safe — the candidates field is preserved on the
      // record either way.
      seedResident({ platformId: "alice", houseNumber: "10" });
      seedResident({ platformId: "candidate-1", houseNumber: "12" });
      withTelegramSession("alice");

      const result = (await runExecute({
        carrier: "DHL",
        candidateResidentIds: ["candidate-1"],
        postGroupCard: true,
      })) as { request: ReceptionRequest; groupCardPosted: boolean };

      expect(result.groupCardPosted).toBe(true);
      expect(result.request.candidateResidentIds).toEqual(["candidate-1"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("schema rejects an empty candidate list", async () => {
      const tool = await loadTool();
      const schema = tool.inputSchema as { safeParse: (input: unknown) => { success: boolean } };
      expect(schema.safeParse({ candidateResidentIds: [] }).success).toBe(false);
    });

    it("schema rejects more than 3 candidates", async () => {
      const tool = await loadTool();
      const schema = tool.inputSchema as { safeParse: (input: unknown) => { success: boolean } };
      expect(
        schema.safeParse({ candidateResidentIds: ["a", "b", "c", "d"] })
          .success,
      ).toBe(false);
    });
  });

  it("throws when the caller is not a registered resident", async () => {
    withTelegramSession("ghost");
    await expect(
      runExecute({ candidateResidentIds: ["alice"], postGroupCard: false }),
    ).rejects.toThrow(/not a registered resident/);
  });
});
