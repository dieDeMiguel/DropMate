import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  KnownTelegramUser,
  Package,
  ReceptionRequest,
  Resident,
} from "./redis.js";

/**
 * Lib-level tests for `registerPackage` — the pure-function core that
 * v2.1 #106 Slice 1 introduces in place of the deleted
 * `register_package` tool. The channel calls this directly when
 * `classify_group_message` returns a high-confidence package
 * registration verdict.
 *
 * Mirrors the mock-store style of `reception-request.test.ts`: the
 * Redis primitives are stubbed in-memory so the function exercises
 * its full code path without hitting Upstash.
 */
const residentStore = vi.hoisted(() => new Map<string, Resident>());
const knownTgStore = vi.hoisted(() => new Map<number, KnownTelegramUser>());
const requestStore = vi.hoisted(() => new Map<string, ReceptionRequest>());
const packageStore = vi.hoisted(() => new Map<string, Package>());

vi.mock("./redis.js", async () => {
  const actual = await vi.importActual<typeof import("./redis.js")>(
    "./redis.js",
  );
  return {
    ...actual,
    async findResidentByNameAndHouse(name: string, houseNumber: string) {
      const needle = name.trim().toLowerCase();
      for (const r of residentStore.values()) {
        if (r.houseNumber !== houseNumber) continue;
        const hay = r.name.toLowerCase();
        if (hay.includes(needle) || needle.includes(hay)) return r;
      }
      return null;
    },
    async findKnownTelegramUserByName(name: string) {
      const tokens = name
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      if (tokens.length === 0) return null;
      for (const u of knownTgStore.values()) {
        const full = u.lastName
          ? `${u.firstName} ${u.lastName}`.toLowerCase()
          : u.firstName.toLowerCase();
        const username = u.username?.toLowerCase() ?? "";
        if (tokens.every((tok) => full.includes(tok) || username.includes(tok))) {
          return u;
        }
      }
      return null;
    },
    async findOpenReceptionRequestForRecipient(
      streetId: string,
      recipientName: string,
      recipientHouseNumber: string,
    ) {
      const needle = recipientName.trim().toLowerCase();
      for (const r of requestStore.values()) {
        if (r.streetId !== streetId) continue;
        if (r.status !== "open" && r.status !== "matched") continue;
        if (r.requesterHouseNumber !== recipientHouseNumber) continue;
        const hay = r.requesterName.toLowerCase();
        if (hay.includes(needle) || needle.includes(hay)) return r;
      }
      return null;
    },
    newPackageId() {
      return `pkg_test_${packageStore.size + 1}`;
    },
    async setPackage(pkg: Package) {
      packageStore.set(pkg.id, pkg);
    },
    async setReceptionRequest(req: ReceptionRequest) {
      requestStore.set(req.id, req);
    },
  };
});

async function loadLib() {
  return import("./package.js");
}

function seedResident(
  overrides: Partial<Resident> & { platformId: string },
): Resident {
  const r: Resident = {
    id: overrides.id ?? overrides.platformId,
    name: overrides.name ?? "Resident",
    street: overrides.street ?? "Methfesselstraße",
    houseNumber: overrides.houseNumber ?? "88",
    floor: overrides.floor,
    buzzerName: overrides.buzzerName,
    platformId: overrides.platformId,
    platform: "telegram",
    language: "language" in overrides ? overrides.language : "de",
    availabilityPatterns: overrides.availabilityPatterns ?? [],
    registeredAt: overrides.registeredAt ?? Date.now(),
    source: overrides.source ?? "explicit",
    confirmed: overrides.confirmed ?? true,
  };
  residentStore.set(r.platformId, r);
  return r;
}

function seedKnownTg(
  overrides: Partial<KnownTelegramUser> & { userId: number; firstName: string },
): KnownTelegramUser {
  const u: KnownTelegramUser = {
    userId: overrides.userId,
    firstName: overrides.firstName,
    lastName: overrides.lastName,
    username: overrides.username,
    languageCode: overrides.languageCode,
    lastSeenAt: overrides.lastSeenAt ?? Date.now(),
    seenInChats: overrides.seenInChats ?? [],
  };
  knownTgStore.set(u.userId, u);
  return u;
}

function seedRequest(
  overrides: Partial<ReceptionRequest> & { id: string; streetId: string },
): ReceptionRequest {
  const r: ReceptionRequest = {
    id: overrides.id,
    streetId: overrides.streetId,
    requesterResidentId: overrides.requesterResidentId ?? "patricia",
    requesterName: overrides.requesterName ?? "Patricia Höfer",
    requesterHouseNumber: overrides.requesterHouseNumber ?? "90",
    carrier: overrides.carrier ?? "DHL",
    expectedAt: overrides.expectedAt ?? null,
    notes: overrides.notes,
    volunteerResidentId: overrides.volunteerResidentId ?? null,
    volunteerAvailability: overrides.volunteerAvailability ?? null,
    status: overrides.status ?? "open",
    createdAt: overrides.createdAt ?? Date.now(),
    respondedAt: overrides.respondedAt ?? null,
    expectedWindowStartAt: overrides.expectedWindowStartAt,
    expectedWindowEndAt: overrides.expectedWindowEndAt,
    groupCardChatId: overrides.groupCardChatId,
    groupCardMessageId: overrides.groupCardMessageId,
  };
  requestStore.set(r.id, r);
  return r;
}

describe("registerPackage (v2.1 #106 — channel-deterministic Flow 1)", () => {
  beforeEach(() => {
    residentStore.clear();
    knownTgStore.clear();
    requestStore.clear();
    packageStore.clear();
  });

  it("registers a Package when the holder is a registered resident and the recipient resolves to another registered resident", async () => {
    const holder = seedResident({
      platformId: "100",
      name: "Diego de Miguel",
      houseNumber: "69",
      floor: "Erdgeschoss",
      buzzerName: "de Miguel",
    });
    seedResident({
      platformId: "200",
      name: "Marlene Hartmann",
      houseNumber: "88",
      language: "de",
    });

    const { registerPackage } = await loadLib();
    const result = await registerPackage(holder, {
      recipientName: "Marlene Hartmann",
      recipientHouseNumber: "88",
      carrier: "DHL",
    });

    expect(result.package.status).toBe("held");
    expect(result.package.holderResidentId).toBe("100");
    expect(result.package.recipientResidentId).toBe("200");
    expect(result.package.recipientName).toBe("Marlene Hartmann");
    expect(result.package.recipientHouseNumber).toBe("88");
    expect(result.package.carrier).toBe("DHL");
    expect(result.package.streetId).toBe("Methfesselstraße");
    expect(result.recipientResolution.kind).toBe("resident");
    if (result.recipientResolution.kind === "resident") {
      expect(result.recipientResolution.resident.id).toBe("200");
      expect(result.recipientResolution.resident.name).toBe("Marlene Hartmann");
      expect(result.recipientResolution.resident.language).toBe("de");
    }
    expect(result.holder.name).toBe("Diego de Miguel");
    expect(result.holder.houseNumber).toBe("69");
    expect(result.holder.floor).toBe("Erdgeschoss");
    expect(result.holder.buzzerName).toBe("de Miguel");
    expect(result.receptionRequestFulfilled).toBeNull();
  });

  it("throws RegisterPackageError with code REGISTER_PACKAGE_HOLDER_NOT_REGISTERED when holder is null", async () => {
    const { registerPackage, REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE, RegisterPackageError } =
      await loadLib();

    await expect(
      registerPackage(null, {
        recipientName: "Marlene",
        recipientHouseNumber: "88",
      }),
    ).rejects.toMatchObject({
      code: REGISTER_PACKAGE_HOLDER_NOT_REGISTERED_ERROR_CODE,
    });

    // Same shape pinned via instanceof + class identity check — the
    // channel handler distinguishes RegisterPackageError from other
    // throws by .code, so the class export is load-bearing.
    let caught: unknown;
    try {
      await registerPackage(null, {
        recipientName: "Marlene",
        recipientHouseNumber: "88",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegisterPackageError);
  });

  it("resolves to known_telegram when the recipient name matches a known TG user but no Resident", async () => {
    const holder = seedResident({
      platformId: "100",
      name: "Diego de Miguel",
      houseNumber: "69",
    });
    seedKnownTg({
      userId: 555,
      firstName: "Natascha",
      lastName: "Elter",
      username: "natascha",
    });

    const { registerPackage } = await loadLib();
    const result = await registerPackage(holder, {
      recipientName: "Natascha Elter",
      recipientHouseNumber: "77",
    });

    expect(result.recipientResolution.kind).toBe("known_telegram");
    if (result.recipientResolution.kind === "known_telegram") {
      expect(result.recipientResolution.telegram.userId).toBe(555);
      expect(result.recipientResolution.telegram.firstName).toBe("Natascha");
      expect(result.recipientResolution.telegram.lastName).toBe("Elter");
    }
    expect(result.package.recipientResidentId).toBeNull();
  });

  it("resolves to unknown when the recipient name matches neither a Resident nor a known TG user", async () => {
    const holder = seedResident({
      platformId: "100",
      name: "Diego",
      houseNumber: "69",
    });

    const { registerPackage } = await loadLib();
    const result = await registerPackage(holder, {
      recipientName: "Someone Random",
      recipientHouseNumber: "77",
    });

    expect(result.recipientResolution.kind).toBe("unknown");
    expect(result.package.recipientResidentId).toBeNull();
    expect(result.package.recipientName).toBe("Someone Random");
  });

  it("defaults carrier to 'unknown' and omits trackingNumber when both are absent", async () => {
    const holder = seedResident({
      platformId: "100",
      name: "Diego",
      houseNumber: "69",
    });
    seedResident({
      platformId: "200",
      name: "Marlene",
      houseNumber: "88",
    });

    const { registerPackage } = await loadLib();
    const result = await registerPackage(holder, {
      recipientName: "Marlene",
      recipientHouseNumber: "88",
    });

    expect(result.package.carrier).toBe("unknown");
    expect(result.package.trackingNumber).toBeUndefined();
  });

  it("flips an open ReceptionRequest to 'fulfilled' when the package closes out a pending Flow 2 ask", async () => {
    const holder = seedResident({
      platformId: "100",
      name: "Diego",
      houseNumber: "69",
    });
    seedResident({
      platformId: "200",
      name: "Patricia Höfer",
      houseNumber: "90",
    });
    seedRequest({
      id: "req_open",
      streetId: "Methfesselstraße",
      requesterResidentId: "200",
      requesterName: "Patricia Höfer",
      requesterHouseNumber: "90",
      status: "open",
    });

    const { registerPackage } = await loadLib();
    const result = await registerPackage(holder, {
      recipientName: "Patricia Höfer",
      recipientHouseNumber: "90",
      carrier: "Hermes",
    });

    expect(result.receptionRequestFulfilled).not.toBeNull();
    expect(result.receptionRequestFulfilled?.requestId).toBe("req_open");
    expect(result.receptionRequestFulfilled?.requesterResidentId).toBe("200");
    expect(result.package.receptionRequestId).toBe("req_open");

    const updated = requestStore.get("req_open");
    expect(updated?.status).toBe("fulfilled");
  });

  it("does not link to a 'fulfilled' or 'expired' request — only open or matched", async () => {
    const holder = seedResident({
      platformId: "100",
      name: "Diego",
      houseNumber: "69",
    });
    seedResident({
      platformId: "200",
      name: "Patricia",
      houseNumber: "90",
    });
    seedRequest({
      id: "req_fulfilled",
      streetId: "Methfesselstraße",
      requesterResidentId: "200",
      requesterName: "Patricia",
      requesterHouseNumber: "90",
      status: "fulfilled",
    });

    const { registerPackage } = await loadLib();
    const result = await registerPackage(holder, {
      recipientName: "Patricia",
      recipientHouseNumber: "90",
    });

    expect(result.receptionRequestFulfilled).toBeNull();
    expect(result.package.receptionRequestId).toBeUndefined();
  });
});
