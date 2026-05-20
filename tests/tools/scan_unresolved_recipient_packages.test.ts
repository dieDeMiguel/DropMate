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
  const mod = await import(
    "../../agent/tools/scan_unresolved_recipient_packages.js"
  );
  return mod.default;
}

function seedResident(
  overrides: Partial<Resident> & { platformId: string },
): Resident {
  const r: Resident = {
    id: overrides.id ?? overrides.platformId,
    name: overrides.name ?? "Holder",
    street: overrides.street ?? "Eichenweg",
    houseNumber: overrides.houseNumber ?? "12",
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
    recipientName: overrides.recipientName ?? "Unknown Name",
    recipientHouseNumber: overrides.recipientHouseNumber ?? "12",
    holderResidentId: overrides.holderResidentId ?? "holder-1",
    carrier: overrides.carrier ?? "DHL",
    trackingNumber: overrides.trackingNumber,
    status: overrides.status ?? "held",
    receivedAt: overrides.receivedAt ?? Date.now(),
    pickedUpAt: overrides.pickedUpAt ?? null,
    reminded: overrides.reminded ?? false,
    recipientResolutionDeadline: overrides.recipientResolutionDeadline,
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

const NOW = new Date("2026-05-19T12:00:00Z").getTime();
const D3 = 3 * 24 * 60 * 60 * 1000;

describe("scan_unresolved_recipient_packages", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("returns a held + unknown-recipient package whose 3d deadline has elapsed, with holder summary", async () => {
    seedResident({
      platformId: "holder-1",
      name: "Diego de Miguel",
      houseNumber: "69",
      floor: "II",
      buzzerName: "de Miguel",
      language: "es",
    });
    seedPackage({
      id: "pkg-1",
      streetId: "Eichenweg",
      status: "held",
      recipientResidentId: null,
      recipientName: "Natascha Elter",
      recipientHouseNumber: "71",
      holderResidentId: "holder-1",
      carrier: "DHL",
      receivedAt: NOW - D3 - 1000,
      recipientResolutionDeadline: NOW - 1000,
    });

    const result = (await runExecute()) as {
      entries: Array<{
        packageId: string;
        carrier: string;
        recipientName: string;
        recipientResolutionDeadline: number;
        holder: {
          id: string;
          name: string;
          houseNumber: string;
          floor: string | null;
          buzzerName: string | null;
          language: string | null;
        } | null;
      }>;
      now: number;
    };

    expect(result.now).toBe(NOW);
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0];
    expect(e.packageId).toBe("pkg-1");
    expect(e.carrier).toBe("DHL");
    expect(e.recipientName).toBe("Natascha Elter");
    expect(e.recipientResolutionDeadline).toBe(NOW - 1000);
    expect(e.holder).toEqual({
      id: "holder-1",
      name: "Diego de Miguel",
      houseNumber: "69",
      floor: "II",
      buzzerName: "de Miguel",
      language: "es",
    });
  });

  it("does not return a package whose recipient was identified (recipientResidentId set)", async () => {
    seedPackage({
      id: "pkg-1",
      streetId: "Eichenweg",
      status: "held",
      recipientResidentId: "recipient-1",
      recipientResolutionDeadline: NOW - 1000,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return a package whose deadline has not yet elapsed", async () => {
    seedPackage({
      id: "pkg-1",
      streetId: "Eichenweg",
      status: "held",
      recipientResidentId: null,
      recipientResolutionDeadline: NOW + 60_000,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return a package with no deadline set (pre-#46 records)", async () => {
    seedPackage({
      id: "pkg-1",
      streetId: "Eichenweg",
      status: "held",
      recipientResidentId: null,
      // recipientResolutionDeadline left undefined
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return packages in non-held statuses", async () => {
    for (const status of [
      "expected",
      "pickup_scheduled",
      "picked_up",
      "expired",
    ] as const) {
      seedPackage({
        id: `pkg-${status}`,
        streetId: "Eichenweg",
        status,
        recipientResidentId: null,
        recipientResolutionDeadline: NOW - 1000,
      });
    }
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("returns holder: null when the holder resident record is missing", async () => {
    seedPackage({
      id: "pkg-1",
      streetId: "Eichenweg",
      status: "held",
      recipientResidentId: null,
      holderResidentId: "ghost-holder",
      recipientResolutionDeadline: NOW - 1000,
    });
    const result = (await runExecute()) as {
      entries: Array<{ holder: unknown }>;
    };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].holder).toBeNull();
  });

  it("returns multiple due entries across different streets", async () => {
    seedPackage({
      id: "pkg-a",
      streetId: "StreetA",
      status: "held",
      recipientResidentId: null,
      recipientResolutionDeadline: NOW - 1000,
    });
    seedPackage({
      id: "pkg-b",
      streetId: "StreetB",
      status: "held",
      recipientResidentId: null,
      recipientResolutionDeadline: NOW - 5_000,
    });
    const result = (await runExecute()) as {
      entries: Array<{ packageId: string }>;
    };
    const ids = result.entries.map((e) => e.packageId).sort();
    expect(ids).toEqual(["pkg-a", "pkg-b"]);
  });

  it("returns an empty list when nothing is due", async () => {
    const result = (await runExecute()) as {
      entries: unknown[];
      now: number;
    };
    expect(result.entries).toEqual([]);
    expect(result.now).toBe(NOW);
  });
});
