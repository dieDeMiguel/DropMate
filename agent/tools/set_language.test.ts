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
    // Drop the real implementation so we don't accidentally hit the
    // mocked Redis getResident through the unwrapped helper.
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

async function loadTool() {
  const mod = await import("./set_language.js");
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

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("set_language", () => {
  beforeEach(() => {
    residentStore.clear();
    sessionMock.value = null;
  });

  it("writes the new language to the caller's Resident record", async () => {
    seedResident({ platformId: "caller-1", language: "de" });
    withTelegramSession("caller-1");

    const result = (await runExecute({ language: "en" })) as {
      language: string;
      residentId: string;
    };

    expect(result.language).toBe("en");
    expect(residentStore.get("caller-1")?.language).toBe("en");
  });

  it("overrides even when the existing language was set by passive detection", async () => {
    // Simulates the hook having already backfilled `de` from Telegram's
    // language_code attribute. /language tr must still win.
    seedResident({ platformId: "caller-1", language: "de" });
    withTelegramSession("caller-1");

    const result = (await runExecute({ language: "tr" })) as {
      language: string;
    };

    expect(result.language).toBe("tr");
    expect(residentStore.get("caller-1")?.language).toBe("tr");
  });

  it("rejects unregistered callers", async () => {
    withTelegramSession("ghost");
    await expect(runExecute({ language: "en" })).rejects.toThrow(
      /not a registered resident/,
    );
  });

  it("rejects non-Telegram authenticators", async () => {
    sessionMock.value = {
      sessionId: "sess-test",
      turn: { id: "turn-1", index: 0 },
      auth: { current: null, initiator: null },
    };
    await expect(runExecute({ language: "en" })).rejects.toThrow(
      /Telegram-authenticated caller/,
    );
  });
});
