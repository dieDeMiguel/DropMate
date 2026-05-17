import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Package, Resident } from "../../lib/redis.js";

const sessionMock = vi.hoisted(() => ({ value: null as unknown }));
const residentStore = vi.hoisted(() => new Map<string, Resident>());
const packageStore = vi.hoisted(() => new Map<string, Package>());
const streetIndex = vi.hoisted(() => new Map<string, Set<string>>());

vi.mock("experimental-ash/context", () => ({
  getSession: () => sessionMock.value,
}));

vi.mock("../../lib/redis.js", () => ({
  async getResident(platformId: string) {
    return residentStore.get(platformId) ?? null;
  },
  async setResident(resident: Resident) {
    residentStore.set(resident.platformId, resident);
  },
  async findResidentByNameAndHouse(name: string, houseNumber: string) {
    const needle = name.trim().toLowerCase();
    if (needle === "") return null;
    for (const r of residentStore.values()) {
      if (r.houseNumber !== houseNumber) continue;
      const hay = r.name.toLowerCase();
      if (hay.includes(needle) || needle.includes(hay)) return r;
    }
    return null;
  },
  async getPackage(id: string) {
    return packageStore.get(id) ?? null;
  },
  async setPackage(pkg: Package) {
    packageStore.set(pkg.id, pkg);
    const key = pkg.streetId;
    if (!streetIndex.has(key)) streetIndex.set(key, new Set());
    streetIndex.get(key)!.add(pkg.id);
  },
}));

async function loadTool() {
  const mod = await import("./register_package.js");
  return mod.default;
}

function withTelegramSession(
  principalId: string,
  attributes: Record<string, string | readonly string[]> = {},
): void {
  sessionMock.value = {
    sessionId: "sess-test",
    turn: { id: "turn-1", index: 0 },
    auth: {
      current: {
        attributes,
        authenticator: "telegram",
        principalId,
        principalType: "user",
      },
      initiator: {
        attributes,
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
    name: overrides.name ?? "Annemarie Bremer",
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

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, {
    toolCallId: "call-1",
    messages: [],
  });
}

describe("register_package", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
    streetIndex.clear();
    sessionMock.value = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));
  });

  it("writes a held Package and indexes it under the holder's street", async () => {
    seedResident({ platformId: "holder-1", name: "Annemarie Bremer", houseNumber: "92" });
    withTelegramSession("holder-1");

    const result = (await runExecute({
      recipientName: "Ritter",
      recipientHouseNumber: "92",
      carrier: "Hermes",
    })) as { package: Package; recipientLinked: boolean };

    expect(result.package.status).toBe("held");
    expect(result.package.receivedAt).toBe(new Date("2026-05-17T10:00:00Z").getTime());
    expect(result.package.holderResidentId).toBe("holder-1");
    expect(result.package.streetId).toBe("Methfesselstraße");
    expect(result.package.carrier).toBe("Hermes");
    expect(result.package.pickedUpAt).toBeNull();
    expect(result.package.reminded).toBe(false);
    expect(result.recipientLinked).toBe(false);
    // street index populated
    expect(streetIndex.get("Methfesselstraße")?.has(result.package.id)).toBe(true);
  });

  it("links recipientResidentId when the recipient is already registered", async () => {
    seedResident({ platformId: "holder-1", name: "Annemarie Bremer", houseNumber: "92" });
    seedResident({
      platformId: "recipient-1",
      id: "recipient-1",
      name: "Anna-Sophie Meyer",
      houseNumber: "92",
    });
    withTelegramSession("holder-1");

    const result = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
      carrier: "Amazon",
    })) as { package: Package; recipientLinked: boolean };

    expect(result.recipientLinked).toBe(true);
    expect(result.package.recipientResidentId).toBe("recipient-1");
  });

  it("defaults carrier to 'unknown' when omitted", async () => {
    seedResident({ platformId: "holder-1" });
    withTelegramSession("holder-1");

    const result = (await runExecute({
      recipientName: "Ritter",
      recipientHouseNumber: "92",
    })) as { package: Package };

    expect(result.package.carrier).toBe("unknown");
    expect(result.package.trackingNumber).toBeUndefined();
  });

  it("supports two packages from one group message via two calls", async () => {
    seedResident({ platformId: "holder-1", name: "Annemarie Bremer", houseNumber: "92" });
    withTelegramSession("holder-1");

    const a = (await runExecute({
      recipientName: "Ritter",
      recipientHouseNumber: "92",
      carrier: "Hermes",
    })) as { package: Package };
    const b = (await runExecute({
      recipientName: "Meyer",
      recipientHouseNumber: "92",
      carrier: "Amazon",
    })) as { package: Package };

    expect(a.package.id).not.toBe(b.package.id);
    expect(streetIndex.get("Methfesselstraße")?.size).toBe(2);
  });

  it("throws when the calling holder is not yet a registered resident", async () => {
    withTelegramSession("unknown-holder");
    await expect(
      runExecute({ recipientName: "Ritter", recipientHouseNumber: "92" }),
    ).rejects.toThrow(/not a registered resident/);
  });

  it("throws when there is no Telegram-authenticated caller", async () => {
    sessionMock.value = {
      sessionId: "sess-test",
      turn: { id: "turn-1", index: 0 },
      auth: { current: null, initiator: null },
    };
    await expect(
      runExecute({ recipientName: "Ritter", recipientHouseNumber: "92" }),
    ).rejects.toThrow(/Telegram-authenticated caller/);
  });
});
