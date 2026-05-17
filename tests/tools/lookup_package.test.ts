import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Package, Resident } from "../../lib/redis.js";

interface HolderSummary {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly floor: string | null;
  readonly buzzerName: string | null;
  readonly availabilityPatterns: readonly string[];
}

interface LookupMatch {
  readonly package: Package;
  readonly holder: HolderSummary | null;
}

const sessionMock = vi.hoisted(() => ({ value: null as unknown }));
const residentStore = vi.hoisted(() => new Map<string, Resident>());
const packageStore = vi.hoisted(() => new Map<string, Package>());
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
    async listPackagesForStreet(streetId: string) {
      const ids = streetIndex.get(streetId);
      if (!ids) return [];
      const out: Package[] = [];
      for (const id of ids) {
        const p = packageStore.get(id);
        if (p) out.push(p);
      }
      return out;
    },
    async listHeldPackagesForStreet(streetId: string) {
      const ids = streetIndex.get(streetId);
      if (!ids) return [];
      const out: Package[] = [];
      for (const id of ids) {
        const p = packageStore.get(id);
        if (p && p.status === "held") out.push(p);
      }
      return out;
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/lookup_package.js");
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
    name: overrides.name ?? "Anna-Sophie Meyer",
    street: overrides.street ?? "Methfesselstraße",
    houseNumber: overrides.houseNumber ?? "92",
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

function seedPackage(overrides: Partial<Package> & { id: string; streetId: string }): Package {
  const p: Package = {
    id: overrides.id,
    streetId: overrides.streetId,
    recipientResidentId: overrides.recipientResidentId ?? null,
    recipientName: overrides.recipientName ?? "Anna-Sophie Meyer",
    recipientHouseNumber: overrides.recipientHouseNumber ?? "92",
    holderResidentId: overrides.holderResidentId ?? "holder-1",
    carrier: overrides.carrier ?? "Hermes",
    trackingNumber: overrides.trackingNumber,
    status: overrides.status ?? "held",
    receivedAt: overrides.receivedAt ?? Date.now(),
    pickedUpAt: overrides.pickedUpAt ?? null,
    reminded: overrides.reminded ?? false,
  };
  packageStore.set(p.id, p);
  if (!streetIndex.has(p.streetId)) streetIndex.set(p.streetId, new Set());
  streetIndex.get(p.streetId)!.add(p.id);
  return p;
}

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("lookup_package", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
    streetIndex.clear();
    sessionMock.value = null;
  });

  it("returns the single held package matching name + house", async () => {
    seedResident({ platformId: "caller-1", name: "Anna-Sophie Meyer", houseNumber: "92" });
    seedPackage({
      id: "pkg-1",
      streetId: "Methfesselstraße",
      recipientName: "Anna-Sophie Meyer",
      recipientHouseNumber: "92",
      carrier: "Hermes",
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    })) as { matches: LookupMatch[]; count: number };

    expect(result.count).toBe(1);
    expect(result.matches[0].package.id).toBe("pkg-1");
  });

  it("ignores packages that are already picked up", async () => {
    seedResident({ platformId: "caller-1", houseNumber: "92" });
    seedPackage({
      id: "pkg-old",
      streetId: "Methfesselstraße",
      recipientName: "Meyer",
      recipientHouseNumber: "92",
      status: "picked_up",
      pickedUpAt: 1,
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    })) as { count: number };

    expect(result.count).toBe(0);
  });

  it("ignores packages on a different street", async () => {
    seedResident({
      platformId: "caller-1",
      street: "Methfesselstraße",
      houseNumber: "92",
    });
    seedPackage({
      id: "pkg-elsewhere",
      streetId: "Bismarckstraße",
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    })) as { count: number };

    expect(result.count).toBe(0);
  });

  it("returns multiple matches when several held packages fit", async () => {
    seedResident({ platformId: "caller-1", houseNumber: "92" });
    seedPackage({
      id: "pkg-a",
      streetId: "Methfesselstraße",
      recipientName: "Anna-Sophie Meyer",
      recipientHouseNumber: "92",
      carrier: "DHL",
    });
    seedPackage({
      id: "pkg-b",
      streetId: "Methfesselstraße",
      recipientName: "Anna-Sophie Meyer",
      recipientHouseNumber: "92",
      carrier: "Amazon",
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    })) as { count: number };

    expect(result.count).toBe(2);
  });

  it("narrows by carrier when provided", async () => {
    seedResident({ platformId: "caller-1", houseNumber: "92" });
    seedPackage({
      id: "pkg-a",
      streetId: "Methfesselstraße",
      recipientName: "Meyer",
      recipientHouseNumber: "92",
      carrier: "DHL",
    });
    seedPackage({
      id: "pkg-b",
      streetId: "Methfesselstraße",
      recipientName: "Meyer",
      recipientHouseNumber: "92",
      carrier: "Amazon",
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
      carrier: "DHL",
    })) as { matches: LookupMatch[]; count: number };

    expect(result.count).toBe(1);
    expect(result.matches[0].package.id).toBe("pkg-a");
  });

  it("throws when caller is not a registered resident", async () => {
    withTelegramSession("ghost");
    await expect(
      runExecute({ recipientName: "Meyer", recipientHouseNumber: "92" }),
    ).rejects.toThrow(/not a registered resident/);
  });

  it("enriches each match with a summary of the holder Resident", async () => {
    seedResident({
      platformId: "caller-1",
      name: "Anna-Sophie Meyer",
      houseNumber: "92",
    });
    seedResident({
      platformId: "holder-1",
      name: "Annemarie Bremer",
      houseNumber: "92",
      floor: "V. Etage",
      buzzerName: "Bremer",
      availabilityPatterns: ["weekdays before 14:00", "after 20:00"],
    });
    seedPackage({
      id: "pkg-1",
      streetId: "Methfesselstraße",
      recipientName: "Anna-Sophie Meyer",
      recipientHouseNumber: "92",
      holderResidentId: "holder-1",
      carrier: "Hermes",
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    })) as { matches: LookupMatch[]; count: number };

    expect(result.count).toBe(1);
    const match = result.matches[0];
    expect(match.package.id).toBe("pkg-1");
    expect(match.holder).toEqual({
      id: "holder-1",
      name: "Annemarie Bremer",
      houseNumber: "92",
      floor: "V. Etage",
      buzzerName: "Bremer",
      availabilityPatterns: ["weekdays before 14:00", "after 20:00"],
    });
  });

  it("returns holder: null when the holder Resident is missing from Redis", async () => {
    seedResident({ platformId: "caller-1", houseNumber: "92" });
    seedPackage({
      id: "pkg-1",
      streetId: "Methfesselstraße",
      recipientName: "Meyer",
      recipientHouseNumber: "92",
      holderResidentId: "ghost-holder",
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    })) as { matches: LookupMatch[]; count: number };

    expect(result.count).toBe(1);
    expect(result.matches[0].holder).toBeNull();
  });

  it("returns holder: null when holderResidentId is null (expected delivery edge case)", async () => {
    seedResident({ platformId: "caller-1", houseNumber: "92" });
    // status remains "held" — exercises the null-holderResidentId guard
    // without crossing the "expected"-status filter inside the tool.
    seedPackage({
      id: "pkg-1",
      streetId: "Methfesselstraße",
      recipientName: "Meyer",
      recipientHouseNumber: "92",
      holderResidentId: null,
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    })) as { matches: LookupMatch[]; count: number };

    expect(result.count).toBe(1);
    expect(result.matches[0].holder).toBeNull();
  });

  it("defaults missing floor and buzzer to null in the holder summary", async () => {
    seedResident({
      platformId: "caller-1",
      name: "Anna-Sophie Meyer",
      houseNumber: "92",
    });
    seedResident({
      platformId: "holder-1",
      name: "Annemarie Bremer",
      houseNumber: "92",
      // floor + buzzerName intentionally omitted — exercises the
      // `holder.floor ?? null` and `holder.buzzerName ?? null` fallbacks.
    });
    seedPackage({
      id: "pkg-1",
      streetId: "Methfesselstraße",
      recipientName: "Anna-Sophie Meyer",
      recipientHouseNumber: "92",
      holderResidentId: "holder-1",
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
    })) as { matches: LookupMatch[]; count: number };

    expect(result.count).toBe(1);
    expect(result.matches[0].holder).toEqual({
      id: "holder-1",
      name: "Annemarie Bremer",
      houseNumber: "92",
      floor: null,
      buzzerName: null,
      availabilityPatterns: [],
    });
  });
});
