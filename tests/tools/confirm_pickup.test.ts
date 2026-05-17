import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Package, Resident } from "../../lib/redis.js";

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
    async getPackage(id: string) {
      return packageStore.get(id) ?? null;
    },
    async setPackage(pkg: Package) {
      packageStore.set(pkg.id, pkg);
      if (!streetIndex.has(pkg.streetId)) streetIndex.set(pkg.streetId, new Set());
      streetIndex.get(pkg.streetId)!.add(pkg.id);
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
  const mod = await import("../../agent/tools/confirm_pickup.js");
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

describe("confirm_pickup", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
    streetIndex.clear();
    sessionMock.value = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T14:00:00Z"));
  });

  it("flips a held package to picked_up and records the timestamp", async () => {
    seedResident({ platformId: "caller-1" });
    seedPackage({
      id: "pkg-1",
      streetId: "Methfesselstraße",
      status: "held",
      pickedUpAt: null,
    });
    withTelegramSession("caller-1");

    const result = (await runExecute({ packageId: "pkg-1" })) as {
      package: Package;
      alreadyPickedUp: boolean;
      remainingHeldOnStreet: number;
    };

    expect(result.alreadyPickedUp).toBe(false);
    expect(result.package.status).toBe("picked_up");
    expect(result.package.pickedUpAt).toBe(
      new Date("2026-05-17T14:00:00Z").getTime(),
    );
    expect(packageStore.get("pkg-1")?.status).toBe("picked_up");
  });

  it("returns remaining held count on the same street", async () => {
    seedResident({ platformId: "caller-1" });
    seedPackage({ id: "pkg-1", streetId: "Methfesselstraße", status: "held" });
    seedPackage({ id: "pkg-2", streetId: "Methfesselstraße", status: "held" });
    seedPackage({ id: "pkg-3", streetId: "Methfesselstraße", status: "held" });
    withTelegramSession("caller-1");

    const result = (await runExecute({ packageId: "pkg-1" })) as {
      remainingHeldOnStreet: number;
    };

    expect(result.remainingHeldOnStreet).toBe(2);
  });

  it("is idempotent — second call returns alreadyPickedUp without bumping timestamp", async () => {
    seedResident({ platformId: "caller-1" });
    seedPackage({
      id: "pkg-1",
      streetId: "Methfesselstraße",
      status: "held",
    });
    withTelegramSession("caller-1");

    const first = (await runExecute({ packageId: "pkg-1" })) as {
      package: Package;
      alreadyPickedUp: boolean;
    };
    expect(first.alreadyPickedUp).toBe(false);
    const stampedAt = first.package.pickedUpAt;

    // Advance time so we'd notice a stomp
    vi.setSystemTime(new Date("2026-05-17T15:00:00Z"));

    const second = (await runExecute({ packageId: "pkg-1" })) as {
      package: Package;
      alreadyPickedUp: boolean;
    };
    expect(second.alreadyPickedUp).toBe(true);
    expect(second.package.pickedUpAt).toBe(stampedAt);
  });

  it("throws when the package id does not exist", async () => {
    seedResident({ platformId: "caller-1" });
    withTelegramSession("caller-1");
    await expect(runExecute({ packageId: "pkg-missing" })).rejects.toThrow(
      /no package with id=pkg-missing/,
    );
  });

  it("throws when caller is not a registered resident", async () => {
    seedPackage({ id: "pkg-1", streetId: "Methfesselstraße", status: "held" });
    withTelegramSession("ghost");
    await expect(runExecute({ packageId: "pkg-1" })).rejects.toThrow(
      /not a registered resident/,
    );
  });

  it("throws when there is no Telegram-authenticated caller", async () => {
    sessionMock.value = {
      sessionId: "sess-test",
      turn: { id: "turn-1", index: 0 },
      auth: { current: null, initiator: null },
    };
    await expect(runExecute({ packageId: "pkg-1" })).rejects.toThrow(
      /Telegram-authenticated caller/,
    );
  });
});
