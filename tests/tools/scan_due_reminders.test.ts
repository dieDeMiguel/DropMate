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
  const mod = await import("../../agent/tools/scan_due_reminders.js");
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
const H48 = 48 * 60 * 60 * 1000;

describe("scan_due_reminders", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("returns a held + !reminded package received > 48h ago, with holder + recipient summaries", async () => {
    seedResident({
      platformId: "holder-1",
      name: "Marlene Hartmann",
      houseNumber: "88",
      floor: "II",
      buzzerName: "Hartmann",
      language: "de",
    });
    seedResident({
      platformId: "recipient-1",
      name: "Patricia Höfer",
      houseNumber: "90",
      language: "en",
    });
    seedPackage({
      id: "pkg-1",
      streetId: "Methfesselstraße",
      status: "held",
      reminded: false,
      receivedAt: NOW - H48 - 1000,
      holderResidentId: "holder-1",
      recipientResidentId: "recipient-1",
      recipientName: "Patricia Höfer",
      recipientHouseNumber: "90",
      carrier: "DHL",
    });

    const result = (await runExecute()) as {
      entries: Array<{
        packageId: string;
        carrier: string;
        holder: { id: string; name: string; floor: string | null; buzzerName: string | null; language: string | null } | null;
        recipient: { id: string; name: string; language: string | null } | null;
      }>;
      now: number;
    };

    expect(result.now).toBe(NOW);
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0];
    expect(e.packageId).toBe("pkg-1");
    expect(e.carrier).toBe("DHL");
    expect(e.holder).toEqual({
      id: "holder-1",
      name: "Marlene Hartmann",
      houseNumber: "88",
      floor: "II",
      buzzerName: "Hartmann",
      language: "de",
    });
    expect(e.recipient).toEqual({
      id: "recipient-1",
      name: "Patricia Höfer",
      houseNumber: "90",
      floor: null,
      buzzerName: null,
      language: "en",
    });
  });

  it("does not return a package already reminded", async () => {
    seedPackage({
      id: "pkg-1",
      streetId: "S",
      status: "held",
      reminded: true,
      receivedAt: NOW - H48 - 1000,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return a package received less than 48h ago", async () => {
    seedPackage({
      id: "pkg-1",
      streetId: "S",
      status: "held",
      reminded: false,
      receivedAt: NOW - H48 + 5_000,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return packages in non-held statuses", async () => {
    for (const status of ["expected", "pickup_scheduled", "picked_up", "expired"] as const) {
      seedPackage({
        id: `pkg-${status}`,
        streetId: "S",
        status,
        reminded: false,
        receivedAt: NOW - H48 - 1000,
      });
    }
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("returns recipient: null when the package's recipient is not registered", async () => {
    seedResident({ platformId: "holder-1" });
    seedPackage({
      id: "pkg-1",
      streetId: "S",
      status: "held",
      reminded: false,
      receivedAt: NOW - H48 - 1000,
      holderResidentId: "holder-1",
      recipientResidentId: null,
    });
    const result = (await runExecute()) as { entries: Array<{ recipient: unknown }> };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].recipient).toBeNull();
  });

  it("returns holder: null when the holder resident record is missing", async () => {
    seedPackage({
      id: "pkg-1",
      streetId: "S",
      status: "held",
      reminded: false,
      receivedAt: NOW - H48 - 1000,
      holderResidentId: "ghost-holder",
      recipientResidentId: null,
    });
    const result = (await runExecute()) as { entries: Array<{ holder: unknown }> };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].holder).toBeNull();
  });

  it("returns multiple due entries across different streets", async () => {
    seedPackage({
      id: "pkg-a",
      streetId: "StreetA",
      status: "held",
      reminded: false,
      receivedAt: NOW - H48 - 1000,
      holderResidentId: null as unknown as string,
      recipientResidentId: null,
    });
    seedPackage({
      id: "pkg-b",
      streetId: "StreetB",
      status: "held",
      reminded: false,
      receivedAt: NOW - H48 - 5_000,
      holderResidentId: null as unknown as string,
      recipientResidentId: null,
    });
    const result = (await runExecute()) as { entries: Array<{ packageId: string }> };
    const ids = result.entries.map((e) => e.packageId).sort();
    expect(ids).toEqual(["pkg-a", "pkg-b"]);
  });

  it("returns an empty list when nothing is due", async () => {
    const result = (await runExecute()) as { entries: unknown[]; now: number };
    expect(result.entries).toEqual([]);
    expect(result.now).toBe(NOW);
  });
});
