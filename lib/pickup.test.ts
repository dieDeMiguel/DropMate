import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Package, Resident } from "./redis.js";

/**
 * Lib-level tests for `confirmPickup` — the pure-function core that
 * v2.1 #108 Slice 4 introduces in place of the deleted
 * `confirm_pickup` tool. The channel calls this directly when the
 * recipient taps `[Abgeholt]` on the group ack (or recipient DM)
 * posted by Slice 1 (#106).
 *
 * Mirrors the mock-store style of `package.test.ts` and
 * `reception-request.test.ts`: the Redis primitives are stubbed
 * in-memory so the function exercises its full code path without
 * hitting Upstash.
 */

const residentStore = vi.hoisted(() => new Map<string, Resident>());
const packageStore = vi.hoisted(() => new Map<string, Package>());

vi.mock("./redis.js", async () => {
  const actual = await vi.importActual<typeof import("./redis.js")>(
    "./redis.js",
  );
  return {
    ...actual,
    async getPackage(id: string) {
      return packageStore.get(id) ?? null;
    },
    async setPackage(pkg: Package) {
      packageStore.set(pkg.id, pkg);
    },
    async getResident(id: string) {
      return residentStore.get(id) ?? null;
    },
  };
});

async function loadLib() {
  return import("./pickup.js");
}

function seedResident(
  overrides: Partial<Resident> & { id: string },
): Resident {
  const r: Resident = {
    id: overrides.id,
    name: overrides.name ?? "Resident",
    street: overrides.street ?? "Methfesselstraße",
    houseNumber: overrides.houseNumber ?? "88",
    floor: overrides.floor,
    buzzerName: overrides.buzzerName,
    platformId: overrides.platformId ?? overrides.id,
    platform: "telegram",
    language: "language" in overrides ? overrides.language : "de",
    availabilityPatterns: overrides.availabilityPatterns ?? [],
    registeredAt: overrides.registeredAt ?? Date.now(),
    source: overrides.source ?? "explicit",
    confirmed: overrides.confirmed ?? true,
  };
  residentStore.set(r.id, r);
  return r;
}

function seedPackage(overrides: Partial<Package> & { id: string }): Package {
  const p: Package = {
    id: overrides.id,
    streetId: overrides.streetId ?? "Methfesselstraße",
    recipientResidentId: overrides.recipientResidentId ?? "200",
    recipientName: overrides.recipientName ?? "Marlene Hartmann",
    recipientHouseNumber: overrides.recipientHouseNumber ?? "88",
    holderResidentId: overrides.holderResidentId ?? "100",
    carrier: overrides.carrier ?? "DHL",
    trackingNumber: overrides.trackingNumber,
    status: overrides.status ?? "held",
    receivedAt: overrides.receivedAt ?? Date.now(),
    pickedUpAt: overrides.pickedUpAt ?? null,
    reminded: overrides.reminded ?? false,
    expectedAt: overrides.expectedAt,
    notes: overrides.notes,
    receptionRequestId: overrides.receptionRequestId,
  };
  packageStore.set(p.id, p);
  return p;
}

describe("confirmPickup (v2.1 #108 — channel-deterministic Flow 1 pickup)", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
  });

  it("flips a held package to picked_up when the caller is the recipient", async () => {
    const holder = seedResident({
      id: "100",
      name: "Anna Müller",
      houseNumber: "12",
      platformId: "100",
    });
    const recipient = seedResident({
      id: "200",
      name: "Marlene Hartmann",
      houseNumber: "88",
      platformId: "200",
    });
    seedPackage({
      id: "pkg_42",
      recipientResidentId: recipient.id,
      holderResidentId: holder.id,
    });

    const { confirmPickup } = await loadLib();
    const before = Date.now();
    const result = await confirmPickup(recipient, "pkg_42");

    expect(result.package.status).toBe("picked_up");
    expect(result.package.pickedUpAt).not.toBeNull();
    expect(result.package.pickedUpAt!).toBeGreaterThanOrEqual(before);
    expect(packageStore.get("pkg_42")!.status).toBe("picked_up");

    expect(result.holder).not.toBeNull();
    expect(result.holder?.name).toBe("Anna Müller");
    expect(result.holder?.houseNumber).toBe("12");
    expect(result.holder?.platformId).toBe("100");
    expect(result.holder?.language).toBe("de");

    expect(result.recipient).not.toBeNull();
    expect(result.recipient?.name).toBe("Marlene Hartmann");
    expect(result.recipient?.houseNumber).toBe("88");
  });

  it("throws ConfirmPickupError with code PICKUP_NOT_RECIPIENT when caller is not the recipient", async () => {
    const caller = seedResident({
      id: "999",
      name: "Some Neighbor",
      houseNumber: "10",
    });
    seedResident({ id: "200", name: "Marlene Hartmann", houseNumber: "88" });
    seedPackage({
      id: "pkg_42",
      recipientResidentId: "200",
      holderResidentId: "100",
    });

    const {
      confirmPickup,
      ConfirmPickupError,
      PICKUP_NOT_RECIPIENT_ERROR_CODE,
    } = await loadLib();

    let thrown: unknown;
    try {
      await confirmPickup(caller, "pkg_42");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfirmPickupError);
    expect((thrown as InstanceType<typeof ConfirmPickupError>).code).toBe(
      PICKUP_NOT_RECIPIENT_ERROR_CODE,
    );
    // State is unchanged on rejection.
    expect(packageStore.get("pkg_42")!.status).toBe("held");
    expect(packageStore.get("pkg_42")!.pickedUpAt).toBeNull();
  });

  it("throws ConfirmPickupError with code PICKUP_ALREADY_DONE when the package is already picked up", async () => {
    const recipient = seedResident({
      id: "200",
      name: "Marlene Hartmann",
      houseNumber: "88",
    });
    seedPackage({
      id: "pkg_42",
      recipientResidentId: recipient.id,
      status: "picked_up",
      pickedUpAt: 1234,
    });

    const {
      confirmPickup,
      ConfirmPickupError,
      PICKUP_ALREADY_DONE_ERROR_CODE,
    } = await loadLib();

    let thrown: unknown;
    try {
      await confirmPickup(recipient, "pkg_42");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfirmPickupError);
    expect((thrown as InstanceType<typeof ConfirmPickupError>).code).toBe(
      PICKUP_ALREADY_DONE_ERROR_CODE,
    );
    // pickedUpAt is unchanged — the second tap did not bump it.
    expect(packageStore.get("pkg_42")!.pickedUpAt).toBe(1234);
  });

  it("throws a plain Error when the package id is unknown", async () => {
    const recipient = seedResident({
      id: "200",
      name: "Marlene Hartmann",
      houseNumber: "88",
    });
    const { confirmPickup, ConfirmPickupError } = await loadLib();

    await expect(confirmPickup(recipient, "pkg_missing")).rejects.toThrow(
      /no package with id=pkg_missing/i,
    );
    // The generic-not-found case is NOT a ConfirmPickupError — the
    // channel renders the generic retry toast for this branch.
    await expect(confirmPickup(recipient, "pkg_missing")).rejects.not.toBeInstanceOf(
      ConfirmPickupError,
    );
  });

  it("returns a null holder/recipient on the result when the resident lookups return null (de-registered between Slice 1 write and tap)", async () => {
    // Caller (recipient) IS registered — they tapped, so they hit the
    // gate. But the channel's holder/recipient lookup might fall short
    // of finding them by id (e.g. id-format drift). The lib must not
    // throw on the lookup failure — the canonical state flip is the
    // important contract, the summaries are cosmetic.
    const recipient = seedResident({
      id: "200",
      name: "Marlene Hartmann",
      houseNumber: "88",
    });
    seedPackage({
      id: "pkg_42",
      recipientResidentId: recipient.id,
      holderResidentId: "deregistered-holder", // not in residentStore
    });

    const { confirmPickup } = await loadLib();
    const result = await confirmPickup(recipient, "pkg_42");

    // Status still flipped.
    expect(result.package.status).toBe("picked_up");
    // Holder summary is null because the lookup didn't find anyone.
    expect(result.holder).toBeNull();
    // Recipient summary IS populated (we loaded that one successfully).
    expect(result.recipient).not.toBeNull();
    expect(result.recipient?.name).toBe("Marlene Hartmann");
  });

  it("does not flip status when the recipient lookup throws (defensive — no callers should hit this)", async () => {
    // Verifying that errors thrown by the resident getter are
    // swallowed rather than propagated, so the channel's success
    // path doesn't lose a flipped status to a downstream hiccup.
    const recipient = seedResident({
      id: "200",
      name: "Marlene Hartmann",
      houseNumber: "88",
    });
    seedPackage({
      id: "pkg_42",
      recipientResidentId: recipient.id,
      holderResidentId: "100",
    });

    const { confirmPickup } = await loadLib();
    const result = await confirmPickup(recipient, "pkg_42", {
      async getResidentById() {
        throw new Error("redis hiccup on holder lookup");
      },
    });
    expect(result.package.status).toBe("picked_up");
    // Summaries land as null when the lookup throws — the function
    // still returns successfully so the channel can proceed.
    expect(result.holder).toBeNull();
    expect(result.recipient).toBeNull();
  });

  it("rejects PICKUP_NOT_RECIPIENT before PICKUP_ALREADY_DONE — scope check fires first", async () => {
    // The scope guard runs before the already-done guard so a
    // non-recipient never learns whether the package was already
    // closed (mild privacy / data-minimisation). Pin the order.
    const caller = seedResident({
      id: "999",
      name: "Some Neighbor",
      houseNumber: "10",
    });
    seedResident({ id: "200", name: "Marlene Hartmann", houseNumber: "88" });
    seedPackage({
      id: "pkg_42",
      recipientResidentId: "200",
      status: "picked_up",
      pickedUpAt: 1234,
    });

    const { confirmPickup, PICKUP_NOT_RECIPIENT_ERROR_CODE } = await loadLib();

    await expect(confirmPickup(caller, "pkg_42")).rejects.toMatchObject({
      code: PICKUP_NOT_RECIPIENT_ERROR_CODE,
    });
  });
});
