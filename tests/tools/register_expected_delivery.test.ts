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
    async setResident(resident: Resident) {
      residentStore.set(resident.platformId, resident);
    },
    async getPackage(id: string) {
      return packageStore.get(id) ?? null;
    },
    async setPackage(pkg: Package) {
      packageStore.set(pkg.id, pkg);
      if (!streetIndex.has(pkg.streetId)) streetIndex.set(pkg.streetId, new Set());
      streetIndex.get(pkg.streetId)!.add(pkg.id);
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/register_expected_delivery.js");
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

describe("register_expected_delivery", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
    streetIndex.clear();
    sessionMock.value = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));
  });

  it("writes an 'expected' Package keyed to the caller with all fields populated", async () => {
    seedResident({
      platformId: "patricia-1",
      name: "Patricia Höfer",
      houseNumber: "90",
    });
    withTelegramSession("patricia-1");

    const result = (await runExecute({
      expectedDate: "2026-05-19",
      carrier: "DHL",
      trackingNumber: "JD0123456789",
      notes: "Birthday gift from Zalando",
    })) as { package: Package };

    expect(result.package.status).toBe("expected");
    expect(result.package.holderResidentId).toBeNull();
    expect(result.package.recipientResidentId).toBe("patricia-1");
    expect(result.package.recipientName).toBe("Patricia Höfer");
    expect(result.package.recipientHouseNumber).toBe("90");
    expect(result.package.streetId).toBe("Methfesselstraße");
    expect(result.package.carrier).toBe("DHL");
    expect(result.package.trackingNumber).toBe("JD0123456789");
    expect(result.package.notes).toBe("Birthday gift from Zalando");
    expect(result.package.receivedAt).toBe(
      new Date("2026-05-17T10:00:00Z").getTime(),
    );
    expect(result.package.pickedUpAt).toBeNull();
    expect(result.package.reminded).toBe(false);
    expect(result.package.expectedAt).toBe(Date.parse("2026-05-19"));
    // street index populated
    expect(streetIndex.get("Methfesselstraße")?.has(result.package.id)).toBe(true);
    // store contains the record
    expect(packageStore.get(result.package.id)?.status).toBe("expected");
  });

  it("defaults expectedAt to null when no date is provided and carrier to 'unknown'", async () => {
    seedResident({ platformId: "patricia-1" });
    withTelegramSession("patricia-1");

    const result = (await runExecute({})) as { package: Package };

    expect(result.package.expectedAt).toBeNull();
    expect(result.package.carrier).toBe("unknown");
    expect(result.package.trackingNumber).toBeUndefined();
    expect(result.package.notes).toBeUndefined();
    expect(result.package.status).toBe("expected");
  });

  it("throws when the caller is not a registered resident", async () => {
    withTelegramSession("ghost");
    await expect(
      runExecute({ expectedDate: "2026-05-19" }),
    ).rejects.toThrow(/not a registered resident/);
  });

  it("throws when there is no Telegram-authenticated caller", async () => {
    sessionMock.value = {
      sessionId: "sess-test",
      turn: { id: "turn-1", index: 0 },
      auth: { current: null, initiator: null },
    };
    await expect(runExecute({})).rejects.toThrow(
      /Telegram-authenticated caller/,
    );
  });
});
