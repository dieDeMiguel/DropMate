import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Package } from "../../lib/redis.js";

const packageStore = vi.hoisted(() => new Map<string, Package>());

vi.mock("../../lib/redis.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/redis.js")>(
    "../../lib/redis.js",
  );
  return {
    ...actual,
    async getPackage(id: string) {
      return packageStore.get(id) ?? null;
    },
    async setPackage(pkg: Package) {
      packageStore.set(pkg.id, pkg);
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/mark_package_reminded.js");
  return mod.default;
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

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("mark_package_reminded", () => {
  beforeEach(() => {
    packageStore.clear();
  });

  it("flips reminded false → true and persists", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", reminded: false });
    const result = (await runExecute({ packageId: "pkg-1" })) as {
      package: Package;
      alreadyReminded: boolean;
    };
    expect(result.alreadyReminded).toBe(false);
    expect(result.package.reminded).toBe(true);
    expect(packageStore.get("pkg-1")?.reminded).toBe(true);
  });

  it("is idempotent — second call reports alreadyReminded", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", reminded: true });
    const result = (await runExecute({ packageId: "pkg-1" })) as {
      package: Package;
      alreadyReminded: boolean;
    };
    expect(result.alreadyReminded).toBe(true);
    expect(result.package.reminded).toBe(true);
  });

  it("throws when the package id does not exist", async () => {
    await expect(runExecute({ packageId: "pkg-missing" })).rejects.toThrow(
      /no package with id=pkg-missing/,
    );
  });
});
