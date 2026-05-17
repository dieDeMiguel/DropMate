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
  const mod = await import("../../agent/tools/mark_package_expired.js");
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

describe("mark_package_expired", () => {
  beforeEach(() => {
    packageStore.clear();
  });

  it("flips status held → expired and persists", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", status: "held" });
    const result = (await runExecute({ packageId: "pkg-1" })) as {
      package: Package;
      alreadyExpired: boolean;
    };
    expect(result.alreadyExpired).toBe(false);
    expect(result.package.status).toBe("expired");
    expect(packageStore.get("pkg-1")?.status).toBe("expired");
  });

  it("is idempotent — second call reports alreadyExpired", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", status: "expired" });
    const result = (await runExecute({ packageId: "pkg-1" })) as {
      package: Package;
      alreadyExpired: boolean;
    };
    expect(result.alreadyExpired).toBe(true);
    expect(result.package.status).toBe("expired");
  });

  it("refuses to expire a picked_up package", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", status: "picked_up" });
    await expect(runExecute({ packageId: "pkg-1" })).rejects.toThrow(
      /refusing to expire/,
    );
    expect(packageStore.get("pkg-1")?.status).toBe("picked_up");
  });

  it("refuses to expire an expected package", async () => {
    seedPackage({ id: "pkg-1", streetId: "S", status: "expected" });
    await expect(runExecute({ packageId: "pkg-1" })).rejects.toThrow(
      /refusing to expire/,
    );
  });

  it("throws when the package id does not exist", async () => {
    await expect(runExecute({ packageId: "pkg-missing" })).rejects.toThrow(
      /no package with id=pkg-missing/,
    );
  });
});
