import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Package, Resident } from "../../lib/redis.js";

const residentStore = vi.hoisted(() => new Map<string, Resident>());
const packageStore = vi.hoisted(() => new Map<string, Package>());

vi.mock("../../lib/redis.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/redis.js")>(
    "../../lib/redis.js",
  );
  return {
    ...actual,
    async getResident(platformId: string) {
      return residentStore.get(platformId) ?? null;
    },
    async listAllPackages() {
      return Array.from(packageStore.values());
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/scan_due_escalations.js");
  return mod.default;
}

function seedResident(
  overrides: Partial<Resident> & { platformId: string },
): Resident {
  const r: Resident = {
    id: overrides.id ?? overrides.platformId,
    name: overrides.name ?? "Resident",
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

function seedPackage(
  overrides: Partial<Package> & { id: string; streetId: string },
): Package {
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
  return p;
}

async function runExecute() {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute({}, { toolCallId: "call-1", messages: [] });
}

const NOW = new Date("2026-05-17T14:00:00Z").getTime();
const D7 = 7 * 24 * 60 * 60 * 1000;

describe("scan_due_escalations", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("returns a held package received > 7d ago, ignoring reminded flag", async () => {
    seedResident({
      platformId: "holder-1",
      name: "Marlene",
      houseNumber: "88",
      language: "de",
    });
    seedPackage({
      id: "pkg-1",
      streetId: "S",
      status: "held",
      reminded: true,
      receivedAt: NOW - D7 - 1000,
      holderResidentId: "holder-1",
      recipientResidentId: null,
    });
    const result = (await runExecute()) as {
      entries: Array<{
        packageId: string;
        holder: { id: string; name: string; houseNumber: string; language: string | null } | null;
        recipient: unknown;
      }>;
      now: number;
    };
    expect(result.now).toBe(NOW);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].packageId).toBe("pkg-1");
    expect(result.entries[0].holder).toEqual({
      id: "holder-1",
      name: "Marlene",
      houseNumber: "88",
      language: "de",
    });
    expect(result.entries[0].recipient).toBeNull();
  });

  it("does not return packages received less than 7d ago", async () => {
    seedPackage({
      id: "pkg-1",
      streetId: "S",
      status: "held",
      receivedAt: NOW - D7 + 5_000,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return non-held packages", async () => {
    for (const status of ["expected", "pickup_scheduled", "picked_up", "expired"] as const) {
      seedPackage({
        id: `pkg-${status}`,
        streetId: "S",
        status,
        receivedAt: NOW - D7 - 1000,
      });
    }
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("includes recipient summary when recipient is registered", async () => {
    seedResident({
      platformId: "recipient-1",
      name: "Patricia",
      houseNumber: "90",
      language: "en",
    });
    seedPackage({
      id: "pkg-1",
      streetId: "S",
      status: "held",
      receivedAt: NOW - D7 - 1000,
      recipientResidentId: "recipient-1",
    });
    const result = (await runExecute()) as {
      entries: Array<{ recipient: { id: string; name: string; houseNumber: string; language: string | null } | null }>;
    };
    expect(result.entries[0].recipient).toEqual({
      id: "recipient-1",
      name: "Patricia",
      houseNumber: "90",
      language: "en",
    });
  });

  it("returns an empty list when nothing is due", async () => {
    const result = (await runExecute()) as { entries: unknown[]; now: number };
    expect(result.entries).toEqual([]);
    expect(result.now).toBe(NOW);
  });
});
