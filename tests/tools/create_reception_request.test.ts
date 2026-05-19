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
    name: overrides.name ?? "Patricia Höfer",
    street: overrides.street ?? "Methfesselstraße",
    houseNumber: overrides.houseNumber ?? "90",
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
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = TEST_TOKEN;
    process.env.TELEGRAM_GROUP_CHAT_ID = TEST_GROUP_ID;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_GROUP_CHAT_ID;
    vi.useRealTimers();
  });

  describe("DM-3 path (legacy, candidateResidentIds present)", () => {
    it("writes an 'open' ReceptionRequest with the caller as requester and SKIPS the group card", async () => {
      seedResident({
        platformId: "patricia",
        name: "Patricia Höfer",
        houseNumber: "90",
      });
      seedResident({ platformId: "marlene", name: "Marlene Hartmann", houseNumber: "88" });
      seedResident({ platformId: "bremer", name: "Annemarie Bremer", houseNumber: "92" });
      withTelegramSession("patricia");

      const result = (await runExecute({
        expectedDate: "2026-05-19",
        carrier: "DHL",
        notes: "DHL package, signature required",
        candidateResidentIds: ["marlene", "bremer"],
      })) as { request: ReceptionRequest; groupCard?: unknown };

      expect(result.request.status).toBe("open");
      expect(result.request.requesterResidentId).toBe("patricia");
      expect(result.request.requesterName).toBe("Patricia Höfer");
      expect(result.request.requesterHouseNumber).toBe("90");
      expect(result.request.streetId).toBe("Methfesselstraße");
      expect(result.request.carrier).toBe("DHL");
      expect(result.request.expectedAt).toBe(Date.parse("2026-05-19"));
      expect(result.request.notes).toBe("DHL package, signature required");
      expect(result.request.candidateResidentIds).toEqual(["marlene", "bremer"]);
      expect(result.request.volunteerResidentId).toBeNull();
      expect(result.request.volunteerAvailability).toBeNull();
      expect(result.request.respondedAt).toBeNull();
      expect(result.request.groupCardChatId).toBeUndefined();
      expect(result.request.groupCardMessageId).toBeUndefined();
      expect(result.request.createdAt).toBe(
        new Date("2026-05-17T10:00:00Z").getTime(),
      );
      expect(streetIndex.get("Methfesselstraße")?.has(result.request.id)).toBe(true);
      expect(result.groupCard).toBeUndefined();
      // No HTTP call should have happened — DM-3 path skips the group card.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("defaults expectedAt to null, carrier to 'unknown', notes to undefined", async () => {
      seedResident({ platformId: "patricia" });
      seedResident({ platformId: "marlene", houseNumber: "88" });
      withTelegramSession("patricia");

      const result = (await runExecute({
        candidateResidentIds: ["marlene"],
      })) as { request: ReceptionRequest };

      expect(result.request.expectedAt).toBeNull();
      expect(result.request.carrier).toBe("unknown");
      expect(result.request.notes).toBeUndefined();
      expect(result.request.status).toBe("open");
    });

    it("schema rejects more than 3 candidates", async () => {
      const tool = await loadTool();
      const schema = tool.inputSchema as { safeParse: (input: unknown) => { success: boolean } };
      expect(
        schema.safeParse({ candidateResidentIds: ["a", "b", "c", "d"] }).success,
      ).toBe(false);
    });
  });

  describe("Flow 2 v2 group-card path (one-shot, candidateResidentIds omitted)", () => {
    beforeEach(() => {
      // Default success response with a fresh message id; individual
      // cases override with mockResolvedValueOnce when needed.
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 42 } }),
          { status: 200 },
        ),
      );
    });

    it("posts a neutral group card with [Ich kann helfen] when no candidates are supplied", async () => {
      seedResident({
        platformId: "patricia",
        name: "Patricia Höfer",
        houseNumber: "90",
      });
      withTelegramSession("patricia");

      const start = Date.parse("2026-05-18T12:00:00Z");
      const end = Date.parse("2026-05-18T14:00:00Z");
      const result = (await runExecute({
        carrier: "DHL",
        expectedWindowStartAt: start,
        expectedWindowEndAt: end,
      })) as {
        request: ReceptionRequest;
        groupCard: { chatId: number; messageId?: number };
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`);
      const body = JSON.parse(init?.body as string);
      expect(body.chat_id).toBe(Number(TEST_GROUP_ID));
      // Card NEVER names the requester or states absence (PRD §9 privacy).
      expect(body.text).not.toContain("Patricia");
      expect(body.text).not.toContain("Höfer");
      expect(body.text).not.toMatch(/nicht (zu Hause|da)/i);
      // Card DOES include the carrier + window we extracted.
      expect(body.text).toContain("DHL");
      // Button row.
      expect(body.reply_markup.inline_keyboard).toEqual([
        [
          {
            text: "Ich kann helfen",
            callback_data: `accept_reception_group:${result.request.id}`,
          },
        ],
      ]);

      expect(result.request.candidateResidentIds).toEqual([]);
      expect(result.request.expectedWindowStartAt).toBe(start);
      expect(result.request.expectedWindowEndAt).toBe(end);
      expect(result.request.groupCardChatId).toBe(Number(TEST_GROUP_ID));
      expect(result.request.groupCardMessageId).toBe(42);
      expect(result.groupCard.chatId).toBe(Number(TEST_GROUP_ID));
      expect(result.groupCard.messageId).toBe(42);
    });

    it("posts the card even when no carrier or window was extracted (post with whatever we have)", async () => {
      seedResident({ platformId: "patricia" });
      withTelegramSession("patricia");

      const result = (await runExecute({})) as {
        request: ReceptionRequest;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect(body.text).toMatch(/^📦 Paket erwartet\./);
      expect(body.text).toContain("Kann jemand annehmen?");
      // Still asks for help with no extra info — privacy-respecting.
      expect(body.text).not.toContain("Patricia");
      expect(result.request.carrier).toBe("unknown");
      expect(result.request.candidateResidentIds).toEqual([]);
    });

    it("takes the group-card path when an explicit empty candidates array is passed", async () => {
      seedResident({ platformId: "patricia" });
      withTelegramSession("patricia");

      await runExecute({ candidateResidentIds: [] });

      // [] should be treated identically to omitted — group card fires.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("persists the request before posting, and patches it after", async () => {
      seedResident({ platformId: "patricia" });
      withTelegramSession("patricia");

      const result = (await runExecute({})) as {
        request: ReceptionRequest;
      };

      // Two writes: initial set + post-send patch with groupCardMessageId.
      const stored = requestStore.get(result.request.id);
      expect(stored?.groupCardChatId).toBe(Number(TEST_GROUP_ID));
      expect(stored?.groupCardMessageId).toBe(42);
    });

    it("schema requires window endpoints to be supplied as a pair", async () => {
      const tool = await loadTool();
      const schema = tool.inputSchema as { safeParse: (input: unknown) => { success: boolean } };
      expect(
        schema.safeParse({ expectedWindowStartAt: 1_700_000_000_000 }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ expectedWindowEndAt: 1_700_000_000_000 }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          expectedWindowStartAt: 1_700_000_000_000,
          expectedWindowEndAt: 1_700_001_000_000,
        }).success,
      ).toBe(true);
    });

    it("schema rejects end-before-start windows", async () => {
      const tool = await loadTool();
      const schema = tool.inputSchema as { safeParse: (input: unknown) => { success: boolean } };
      expect(
        schema.safeParse({
          expectedWindowStartAt: 1_700_001_000_000,
          expectedWindowEndAt: 1_700_000_000_000,
        }).success,
      ).toBe(false);
    });

    it("throws when TELEGRAM_BOT_TOKEN is missing on the group-card path", async () => {
      seedResident({ platformId: "patricia" });
      withTelegramSession("patricia");
      delete process.env.TELEGRAM_BOT_TOKEN;

      await expect(runExecute({})).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
    });

    it("throws when TELEGRAM_GROUP_CHAT_ID is missing on the group-card path", async () => {
      seedResident({ platformId: "patricia" });
      withTelegramSession("patricia");
      delete process.env.TELEGRAM_GROUP_CHAT_ID;

      await expect(runExecute({})).rejects.toThrow(/TELEGRAM_GROUP_CHAT_ID/);
    });

    it("tolerates a successful send that returns no message_id (keeps request without card ids)", async () => {
      seedResident({ platformId: "patricia" });
      withTelegramSession("patricia");
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const result = (await runExecute({})) as {
        request: ReceptionRequest;
        groupCard: { chatId: number; messageId?: number };
      };

      expect(result.request.groupCardChatId).toBeUndefined();
      expect(result.request.groupCardMessageId).toBeUndefined();
      expect(result.groupCard.chatId).toBe(Number(TEST_GROUP_ID));
      expect(result.groupCard.messageId).toBeUndefined();
    });
  });

  it("throws when the caller is not a registered resident", async () => {
    withTelegramSession("ghost");
    await expect(
      runExecute({ candidateResidentIds: ["marlene"] }),
    ).rejects.toThrow(/not a registered resident/);
  });
});
