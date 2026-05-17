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
    async listResidentsForStreet(street: string) {
      return [...residentStore.values()].filter((r) => r.street === street);
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/find_available_neighbors.js");
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
    name: overrides.name ?? "Neighbor",
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

interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly availabilityPatterns: readonly string[];
}

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("find_available_neighbors", () => {
  beforeEach(() => {
    residentStore.clear();
    sessionMock.value = null;
  });

  it("excludes the caller from the candidate list", async () => {
    seedResident({ platformId: "patricia", name: "Patricia", houseNumber: "90" });
    seedResident({ platformId: "marlene", name: "Marlene", houseNumber: "88" });
    withTelegramSession("patricia");

    const result = (await runExecute({})) as {
      candidates: Candidate[];
      count: number;
    };

    expect(result.candidates.map((c) => c.id)).toEqual(["marlene"]);
    expect(result.count).toBe(1);
  });

  it("ignores residents on a different street", async () => {
    seedResident({
      platformId: "patricia",
      street: "Methfesselstraße",
      houseNumber: "90",
    });
    seedResident({
      platformId: "stranger",
      name: "Stranger",
      street: "Bismarckstraße",
      houseNumber: "1",
    });
    withTelegramSession("patricia");

    const result = (await runExecute({})) as { count: number };
    expect(result.count).toBe(0);
  });

  it("ranks closest house numbers first and caps the result at 3 by default", async () => {
    seedResident({ platformId: "patricia", houseNumber: "90" });
    // Distances from Hs.90: 88→2, 86→4, 100→10, 80→10, 70→20, 92→2.
    // Adjacent (distance ≤ 2): marlene (88), bremer (92). Then 86, then 100/80 (tie — sort by id).
    seedResident({ platformId: "marlene", name: "Marlene", houseNumber: "88" });
    seedResident({ platformId: "anton", name: "Anton", houseNumber: "86" });
    seedResident({ platformId: "kai", name: "Kai", houseNumber: "100" });
    seedResident({ platformId: "ulf", name: "Ulf", houseNumber: "80" });
    seedResident({ platformId: "bremer", name: "Annemarie Bremer", houseNumber: "92" });
    seedResident({ platformId: "old", name: "Old", houseNumber: "70" });
    withTelegramSession("patricia");

    const result = (await runExecute({})) as {
      candidates: Candidate[];
      count: number;
    };

    expect(result.count).toBe(3);
    // Top three: marlene (88, d=2), bremer (92, d=2), anton (86, d=4)
    const ids = result.candidates.map((c) => c.id);
    expect(ids[2]).toBe("anton");
    expect(ids.slice(0, 2).sort()).toEqual(["bremer", "marlene"]);
  });

  it("respects the `max` override (clamped to 1..3)", async () => {
    seedResident({ platformId: "patricia", houseNumber: "90" });
    seedResident({ platformId: "marlene", houseNumber: "88" });
    seedResident({ platformId: "bremer", houseNumber: "92" });
    seedResident({ platformId: "anton", houseNumber: "86" });
    withTelegramSession("patricia");

    const result = (await runExecute({ max: 1 })) as { count: number };
    expect(result.count).toBe(1);
  });

  it("handles non-numeric house numbers without throwing (treated as infinite distance)", async () => {
    seedResident({ platformId: "patricia", houseNumber: "90" });
    seedResident({ platformId: "letter", houseNumber: "12B" });
    seedResident({ platformId: "marlene", houseNumber: "88" });
    withTelegramSession("patricia");

    const result = (await runExecute({})) as {
      candidates: Candidate[];
      count: number;
    };

    // Marlene's distance is 2 (parsable). Letter's "12B" parses to 12 → distance 78.
    // Marlene must come first.
    expect(result.count).toBe(2);
    expect(result.candidates[0].id).toBe("marlene");
  });

  it("returns an empty list with count: 0 when the caller is alone on the street", async () => {
    seedResident({ platformId: "patricia", houseNumber: "90" });
    withTelegramSession("patricia");

    const result = (await runExecute({})) as {
      candidates: Candidate[];
      count: number;
    };

    expect(result.count).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("exposes name + houseNumber + availabilityPatterns per candidate (no platform-id leakage)", async () => {
    seedResident({ platformId: "patricia", houseNumber: "90" });
    seedResident({
      platformId: "marlene",
      name: "Marlene Hartmann",
      houseNumber: "88",
      availabilityPatterns: ["weekdays until 15:00"],
    });
    withTelegramSession("patricia");

    const result = (await runExecute({})) as {
      candidates: Candidate[];
    };

    expect(result.candidates[0]).toEqual({
      id: "marlene",
      name: "Marlene Hartmann",
      houseNumber: "88",
      availabilityPatterns: ["weekdays until 15:00"],
    });
  });

  it("throws when the caller is not a registered resident", async () => {
    withTelegramSession("ghost");
    await expect(runExecute({})).rejects.toThrow(/not a registered resident/);
  });
});
