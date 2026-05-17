import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Resident } from "../../lib/redis.js";

const sessionMock = vi.hoisted(() => ({ value: null as unknown }));
const residentStore = vi.hoisted(() => new Map<string, Resident>());

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
    async setResident(resident: Resident) {
      residentStore.set(resident.platformId, resident);
    },
    async updateResidentLanguage(
      platformId: string,
      language: string,
      options: { onlyIfUnset?: boolean } = {},
    ) {
      const existing = residentStore.get(platformId);
      if (!existing) return null;
      if (options.onlyIfUnset && existing.language) return existing;
      if (existing.language === language) return existing;
      const updated: Resident = { ...existing, language };
      residentStore.set(platformId, updated);
      return updated;
    },
  };
});

async function loadHook() {
  const mod = await import("../../agent/hooks/language_detection.js");
  return { hook: mod.default };
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

function seedResident(
  overrides: Partial<Resident> & { platformId: string },
): Resident {
  const r: Resident = {
    id: overrides.id ?? overrides.platformId,
    name: overrides.name ?? "Anna-Sophie Meyer",
    street: overrides.street ?? "Methfesselstraße",
    houseNumber: overrides.houseNumber ?? "92",
    floor: overrides.floor,
    buzzerName: overrides.buzzerName,
    platformId: overrides.platformId,
    platform: "telegram",
    language: overrides.language,
    availabilityPatterns: overrides.availabilityPatterns ?? [],
    registeredAt: overrides.registeredAt ?? Date.now(),
    source: overrides.source ?? "explicit",
    confirmed: overrides.confirmed ?? true,
  };
  residentStore.set(r.platformId, r);
  return r;
}

interface HookResult {
  modelContext?: ReadonlyArray<{ role: string; content: string }>;
}

async function runTurn(): Promise<HookResult | undefined> {
  const { hook } = await loadHook();
  const turn = hook.lifecycle?.turn;
  if (!turn) throw new Error("hook has no lifecycle.turn");
  const result = await turn(
    { session: { sessionId: "sess-test" }, turn: { sequence: 0, turnId: "t-0" } },
    {
      agent: { name: "dropmate" },
      channel: { kind: "telegram", continuationToken: "tg:1" },
      session: { sessionId: "sess-test" },
      ash: {} as never,
    },
  );
  return result as HookResult | undefined;
}

describe("language_detection", () => {
  beforeEach(() => {
    residentStore.clear();
    sessionMock.value = null;
  });

  it("uses Telegram attribute when no Resident exists yet (unregistered caller)", async () => {
    withTelegramSession("ghost", { languageCode: "en" });
    const result = await runTurn();
    expect(residentStore.size).toBe(0);
    expect(result?.modelContext?.[0].role).toBe("system");
    expect(result?.modelContext?.[0].content).toContain('"en"');
  });

  it("backfills Resident.language when the field is unset and Telegram has a code", async () => {
    seedResident({ platformId: "caller-1", language: undefined });
    withTelegramSession("caller-1", { languageCode: "tr" });

    const result = await runTurn();
    expect(residentStore.get("caller-1")?.language).toBe("tr");
    expect(result?.modelContext?.[0].content).toContain('"tr"');
  });

  it("Resident.language is authoritative — Telegram attribute does NOT override it", async () => {
    // User ran `/language en`; Telegram client is still set to German.
    // The hook must tell the model "en" AND must not flip the record.
    seedResident({ platformId: "caller-1", language: "en" });
    withTelegramSession("caller-1", { languageCode: "de" });

    const result = await runTurn();
    expect(residentStore.get("caller-1")?.language).toBe("en");
    expect(result?.modelContext?.[0].content).toContain('"en"');
    expect(result?.modelContext?.[0].content).not.toContain('"de"');
  });

  it("uses Resident.language when Telegram omits language_code entirely", async () => {
    seedResident({ platformId: "caller-1", language: "tr" });
    withTelegramSession("caller-1", {});

    const result = await runTurn();
    expect(result?.modelContext?.[0].content).toContain('"tr"');
  });

  it("normalises Telegram BCP-47 codes before persisting (de-AT → de)", async () => {
    seedResident({ platformId: "caller-1", language: undefined });
    withTelegramSession("caller-1", { languageCode: "de-AT" });

    await runTurn();
    expect(residentStore.get("caller-1")?.language).toBe("de");
  });

  it("returns undefined when there is no Telegram principal at all", async () => {
    sessionMock.value = {
      sessionId: "sess-test",
      turn: { id: "turn-1", index: 0 },
      auth: { current: null, initiator: null },
    };
    const result = await runTurn();
    expect(result).toBeUndefined();
  });

  it("returns undefined when neither Resident.language nor Telegram language_code is available", async () => {
    seedResident({ platformId: "caller-1", language: undefined });
    withTelegramSession("caller-1", {});

    const result = await runTurn();
    expect(result).toBeUndefined();
  });
});
