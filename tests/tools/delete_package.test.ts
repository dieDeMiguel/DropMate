import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Package } from "../../lib/redis.js";

const packageStore = vi.hoisted(() => new Map<string, Package>());
const streetIndex = vi.hoisted(() => new Map<string, Set<string>>());

vi.mock("../../lib/redis.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/redis.js")>(
    "../../lib/redis.js",
  );
  return {
    ...actual,
    async getPackage(id: string) {
      return packageStore.get(id) ?? null;
    },
    async deletePackage(id: string, streetId: string) {
      packageStore.delete(id);
      streetIndex.get(streetId)?.delete(id);
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/delete_package.js");
  return mod.default;
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

describe("delete_package", () => {
  beforeEach(() => {
    packageStore.clear();
    streetIndex.clear();
  });

  it("removes a held package from both the package record and the street index", async () => {
    seedPackage({ id: "pkg-1", streetId: "Eichenweg", status: "held" });
    expect(packageStore.has("pkg-1")).toBe(true);
    expect(streetIndex.get("Eichenweg")?.has("pkg-1")).toBe(true);

    const result = (await runExecute({ packageId: "pkg-1" })) as {
      deleted: boolean;
      alreadyGone: boolean;
    };
    expect(result.deleted).toBe(true);
    expect(result.alreadyGone).toBe(false);
    expect(packageStore.has("pkg-1")).toBe(false);
    expect(streetIndex.get("Eichenweg")?.has("pkg-1")).toBe(false);
  });

  it("is idempotent — second call on an already-deleted id reports alreadyGone", async () => {
    const result = (await runExecute({ packageId: "pkg-missing" })) as {
      deleted: boolean;
      alreadyGone: boolean;
    };
    expect(result.deleted).toBe(false);
    expect(result.alreadyGone).toBe(true);
  });

  it("refuses to delete a picked_up package", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", status: "picked_up" });
    await expect(runExecute({ packageId: "pkg-1" })).rejects.toThrow(
      /refusing to delete/,
    );
    expect(packageStore.has("pkg-1")).toBe(true);
  });

  it("refuses to delete an expired package", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", status: "expired" });
    await expect(runExecute({ packageId: "pkg-1" })).rejects.toThrow(
      /refusing to delete/,
    );
    expect(packageStore.has("pkg-1")).toBe(true);
  });

  it("refuses to delete an expected package", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", status: "expected" });
    await expect(runExecute({ packageId: "pkg-1" })).rejects.toThrow(
      /refusing to delete/,
    );
    expect(packageStore.has("pkg-1")).toBe(true);
  });
});
