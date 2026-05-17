import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Resident } from "../../lib/redis.js";

const sessionMock = vi.hoisted(() => ({ value: null as unknown }));
const residentStore = vi.hoisted(() => new Map<string, Resident>());

vi.mock("experimental-ash/context", () => ({
  getSession: () => sessionMock.value,
}));

vi.mock("../../lib/redis.js", () => ({
  async getResident(platformId: string) {
    return residentStore.get(platformId) ?? null;
  },
  async setResident(resident: Resident) {
    residentStore.set(resident.platformId, resident);
  },
}));

async function loadTool() {
  // Dynamically import so the mocks are applied first.
  const mod = await import("../../agent/tools/register_resident.js");
  return mod.default;
}

function withTelegramSession(
  principalId: string,
  attributes: Record<string, string | readonly string[]> = {},
): void {
  sessionMock.value = {
    sessionId: "sess-test",
    turn: { id: "turn-1", index: 0 },
    auth: {
      current: {
        attributes,
        authenticator: "telegram",
        principalId,
        principalType: "user",
      },
      initiator: {
        attributes,
        authenticator: "telegram",
        principalId,
        principalType: "user",
      },
    },
  };
}

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, {
    toolCallId: "call-1",
    messages: [],
  });
}

describe("register_resident", () => {
  beforeEach(() => {
    residentStore.clear();
    sessionMock.value = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));
  });

  it("writes a new Resident record for the calling Telegram user", async () => {
    withTelegramSession("123456", { languageCode: "de" });

    const result = (await runExecute({
      name: "Anna-Sophie Meyer",
      street: "Methfesselstraße",
      houseNumber: "92",
      floor: "III. Etage",
    })) as { resident: Resident; updated: boolean };

    expect(result.updated).toBe(false);
    expect(result.resident).toEqual({
      id: "123456",
      name: "Anna-Sophie Meyer",
      street: "Methfesselstraße",
      houseNumber: "92",
      floor: "III. Etage",
      buzzerName: undefined,
      platformId: "123456",
      platform: "telegram",
      language: "de",
      availabilityPatterns: [],
      registeredAt: new Date("2026-05-17T10:00:00Z").getTime(),
      source: "explicit",
      confirmed: true,
    });
    expect(residentStore.get("123456")?.name).toBe("Anna-Sophie Meyer");
  });

  it("is idempotent: re-running updates the existing record and preserves derived fields", async () => {
    withTelegramSession("123456", { languageCode: "de" });
    await runExecute({
      name: "Anna-Sophie Meyer",
      street: "Methfesselstraße",
      houseNumber: "92",
      floor: "III. Etage",
    });
    const original = residentStore.get("123456")!;
    // Simulate later learning: language updated, availability discovered.
    residentStore.set("123456", {
      ...original,
      language: "en",
      availabilityPatterns: ["mornings"],
    });

    vi.setSystemTime(new Date("2026-06-01T10:00:00Z"));
    const result = (await runExecute({
      name: "Anna-Sophie Meyer",
      street: "Methfesselstraße",
      houseNumber: "92",
      floor: "IV. Etage",
      buzzerName: "Meyer",
    })) as { resident: Resident; updated: boolean };

    expect(result.updated).toBe(true);
    expect(result.resident.floor).toBe("IV. Etage");
    expect(result.resident.buzzerName).toBe("Meyer");
    // Preserved across the update:
    expect(result.resident.language).toBe("en");
    expect(result.resident.availabilityPatterns).toEqual(["mornings"]);
    expect(result.resident.registeredAt).toBe(original.registeredAt);
  });

  it("accepts freeform-language input (Turkish) — the tool only sees structured fields", async () => {
    withTelegramSession("987654", { languageCode: "tr" });
    const result = (await runExecute({
      name: "Ali Demir",
      street: "Methfesselstraße",
      houseNumber: "92",
      floor: "2. OG",
    })) as { resident: Resident; updated: boolean };

    expect(result.resident.platformId).toBe("987654");
    expect(result.resident.language).toBe("tr");
    expect(result.resident.source).toBe("explicit");
    expect(result.resident.confirmed).toBe(true);
  });

  it("throws when there is no Telegram-authenticated caller", async () => {
    sessionMock.value = {
      sessionId: "sess-test",
      turn: { id: "turn-1", index: 0 },
      auth: { current: null, initiator: null },
    };
    await expect(
      runExecute({
        name: "Anna",
        street: "Methfesselstraße",
        houseNumber: "92",
      }),
    ).rejects.toThrow(/Telegram-authenticated caller/);
  });
});
