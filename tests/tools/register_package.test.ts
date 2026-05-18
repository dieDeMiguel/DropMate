import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Package,
  ReceptionRequest,
  Resident,
} from "../../lib/redis.js";

const sessionMock = vi.hoisted(() => ({ value: null as unknown }));
const residentStore = vi.hoisted(() => new Map<string, Resident>());
const packageStore = vi.hoisted(() => new Map<string, Package>());
const streetIndex = vi.hoisted(() => new Map<string, Set<string>>());
const requestStore = vi.hoisted(() => new Map<string, ReceptionRequest>());
const requestStreetIndex = vi.hoisted(
  () => new Map<string, Set<string>>(),
);

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
    async getReceptionRequest(id: string) {
      return requestStore.get(id) ?? null;
    },
    async setReceptionRequest(req: ReceptionRequest) {
      requestStore.set(req.id, req);
      if (!requestStreetIndex.has(req.streetId))
        requestStreetIndex.set(req.streetId, new Set());
      requestStreetIndex.get(req.streetId)!.add(req.id);
    },
    async listReceptionRequestsForStreet(streetId: string) {
      const ids = requestStreetIndex.get(streetId);
      if (!ids) return [];
      const out: ReceptionRequest[] = [];
      for (const id of ids) {
        const r = requestStore.get(id);
        if (r) out.push(r);
      }
      return out;
    },
    async findOpenReceptionRequestForRecipient(
      streetId: string,
      recipientName: string,
      recipientHouseNumber: string,
    ) {
      const needle = recipientName.trim().toLowerCase();
      if (needle === "") return null;
      const ids = requestStreetIndex.get(streetId);
      if (!ids) return null;
      const eligible: ReceptionRequest[] = [];
      for (const id of ids) {
        const r = requestStore.get(id);
        if (!r) continue;
        if (r.status !== "open" && r.status !== "matched") continue;
        if (r.requesterHouseNumber !== recipientHouseNumber) continue;
        const hay = r.requesterName.toLowerCase();
        if (!hay.includes(needle) && !needle.includes(hay)) continue;
        eligible.push(r);
      }
      eligible.sort((a, b) => b.createdAt - a.createdAt);
      return eligible[0] ?? null;
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/register_package.js");
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

function seedReceptionRequest(
  overrides: Partial<ReceptionRequest> & {
    id: string;
    streetId: string;
    requesterResidentId: string;
    requesterName: string;
    requesterHouseNumber: string;
  },
): ReceptionRequest {
  const r: ReceptionRequest = {
    id: overrides.id,
    streetId: overrides.streetId,
    requesterResidentId: overrides.requesterResidentId,
    requesterName: overrides.requesterName,
    requesterHouseNumber: overrides.requesterHouseNumber,
    carrier: overrides.carrier ?? "unknown",
    expectedAt: overrides.expectedAt ?? null,
    notes: overrides.notes,
    candidateResidentIds: overrides.candidateResidentIds ?? [],
    volunteerResidentId: overrides.volunteerResidentId ?? null,
    volunteerAvailability: overrides.volunteerAvailability ?? null,
    status: overrides.status ?? "open",
    createdAt: overrides.createdAt ?? Date.now(),
    respondedAt: overrides.respondedAt ?? null,
  };
  requestStore.set(r.id, r);
  if (!requestStreetIndex.has(r.streetId))
    requestStreetIndex.set(r.streetId, new Set());
  requestStreetIndex.get(r.streetId)!.add(r.id);
  return r;
}

describe("register_package", () => {
  beforeEach(() => {
    residentStore.clear();
    packageStore.clear();
    streetIndex.clear();
    requestStore.clear();
    requestStreetIndex.clear();
    sessionMock.value = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));
  });

  it("writes a held Package and indexes it under the holder's street", async () => {
    seedResident({
      platformId: "holder-1",
      name: "Annemarie Bremer",
      houseNumber: "92",
      floor: "V. Etage",
      buzzerName: "Bremer",
    });
    withTelegramSession("holder-1");

    const result = (await runExecute({
      recipientName: "Ritter",
      recipientHouseNumber: "92",
      carrier: "Hermes",
    })) as {
      package: Package;
      recipientLinked: boolean;
      holder: {
        id: string;
        name: string;
        houseNumber: string;
        floor: string | null;
        buzzerName: string | null;
      };
    };

    expect(result.package.status).toBe("held");
    expect(result.package.receivedAt).toBe(new Date("2026-05-17T10:00:00Z").getTime());
    expect(result.package.holderResidentId).toBe("holder-1");
    expect(result.package.streetId).toBe("Methfesselstraße");
    expect(result.package.carrier).toBe("Hermes");
    expect(result.package.pickedUpAt).toBeNull();
    expect(result.package.reminded).toBe(false);
    expect(result.recipientLinked).toBe(false);
    // Regression for #43 item 2b round 3: the holder summary must be in
    // the response so the model has the concrete name to paste into the
    // group post + recipient DM (instead of inventing or templatising).
    expect(result.holder).toEqual({
      id: "holder-1",
      name: "Annemarie Bremer",
      houseNumber: "92",
      floor: "V. Etage",
      buzzerName: "Bremer",
    });
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

  describe("reception request fulfillment (Flow 2b)", () => {
    it("flips a matching open request to fulfilled and returns requester + holder summary", async () => {
      seedResident({
        platformId: "holder-1",
        id: "holder-1",
        name: "Marlene Hartmann",
        houseNumber: "88",
        floor: "II.",
        buzzerName: "Hartmann",
      });
      seedResident({
        platformId: "requester-1",
        id: "requester-1",
        name: "Patricia Höfer",
        houseNumber: "90",
        language: "de",
      });
      seedReceptionRequest({
        id: "req-1",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-1",
        requesterName: "Patricia Höfer",
        requesterHouseNumber: "90",
        carrier: "DHL",
        candidateResidentIds: ["holder-1"],
        status: "open",
        createdAt: new Date("2026-05-16T09:00:00Z").getTime(),
      });
      withTelegramSession("holder-1");

      const result = (await runExecute({
        recipientName: "Patricia Höfer",
        recipientHouseNumber: "90",
        carrier: "DHL",
      })) as {
        package: Package;
        recipientLinked: boolean;
        receptionRequestFulfilled: {
          requestId: string;
          requester: {
            id: string;
            name: string;
            houseNumber: string;
            language: string | null;
          };
          holder: {
            id: string;
            name: string;
            houseNumber: string;
            floor: string | null;
            buzzerName: string | null;
          };
        } | null;
      };

      expect(result.receptionRequestFulfilled).not.toBeNull();
      expect(result.receptionRequestFulfilled!.requestId).toBe("req-1");
      expect(result.receptionRequestFulfilled!.requester).toEqual({
        id: "requester-1",
        name: "Patricia Höfer",
        houseNumber: "90",
        language: "de",
      });
      expect(result.receptionRequestFulfilled!.holder).toEqual({
        id: "holder-1",
        name: "Marlene Hartmann",
        houseNumber: "88",
        floor: "II.",
        buzzerName: "Hartmann",
      });
      expect(result.package.receptionRequestId).toBe("req-1");
      expect(requestStore.get("req-1")!.status).toBe("fulfilled");
    });

    it("matches a request already in 'matched' status (volunteer agreed earlier, package now arrived)", async () => {
      seedResident({ platformId: "holder-1", id: "holder-1", houseNumber: "88" });
      seedResident({
        platformId: "requester-1",
        id: "requester-1",
        name: "Patricia",
        houseNumber: "90",
      });
      seedReceptionRequest({
        id: "req-1",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-1",
        requesterName: "Patricia",
        requesterHouseNumber: "90",
        candidateResidentIds: ["holder-1"],
        status: "matched",
        volunteerResidentId: "holder-1",
        volunteerAvailability: "bis 15 Uhr",
      });
      withTelegramSession("holder-1");

      const result = (await runExecute({
        recipientName: "Patricia",
        recipientHouseNumber: "90",
      })) as { package: Package; receptionRequestFulfilled: unknown };

      expect(result.receptionRequestFulfilled).not.toBeNull();
      expect(result.package.receptionRequestId).toBe("req-1");
      expect(requestStore.get("req-1")!.status).toBe("fulfilled");
    });

    it("does not match a request that is already fulfilled or expired", async () => {
      seedResident({ platformId: "holder-1", id: "holder-1", houseNumber: "88" });
      seedResident({
        platformId: "requester-1",
        id: "requester-1",
        name: "Patricia",
        houseNumber: "90",
      });
      seedReceptionRequest({
        id: "req-fulfilled",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-1",
        requesterName: "Patricia",
        requesterHouseNumber: "90",
        status: "fulfilled",
      });
      seedReceptionRequest({
        id: "req-expired",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-1",
        requesterName: "Patricia",
        requesterHouseNumber: "90",
        status: "expired",
      });
      withTelegramSession("holder-1");

      const result = (await runExecute({
        recipientName: "Patricia",
        recipientHouseNumber: "90",
      })) as { package: Package; receptionRequestFulfilled: unknown };

      expect(result.receptionRequestFulfilled).toBeNull();
      expect(result.package.receptionRequestId).toBeUndefined();
      expect(requestStore.get("req-fulfilled")!.status).toBe("fulfilled");
      expect(requestStore.get("req-expired")!.status).toBe("expired");
    });

    it("does not match a request whose recipient name + house number do not align", async () => {
      seedResident({ platformId: "holder-1", id: "holder-1", houseNumber: "88" });
      seedResident({
        platformId: "requester-1",
        id: "requester-1",
        name: "Patricia",
        houseNumber: "90",
      });
      seedReceptionRequest({
        id: "req-1",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-1",
        requesterName: "Patricia",
        requesterHouseNumber: "90",
        status: "open",
      });
      withTelegramSession("holder-1");

      const result = (await runExecute({
        recipientName: "Ritter",
        recipientHouseNumber: "92",
      })) as { package: Package; receptionRequestFulfilled: unknown };

      expect(result.receptionRequestFulfilled).toBeNull();
      expect(result.package.receptionRequestId).toBeUndefined();
      expect(requestStore.get("req-1")!.status).toBe("open");
    });

    it("matches by case-insensitive substring on the requester's name", async () => {
      seedResident({ platformId: "holder-1", id: "holder-1", houseNumber: "88" });
      seedResident({
        platformId: "requester-1",
        id: "requester-1",
        name: "Anna-Sophie Meyer",
        houseNumber: "92",
      });
      seedReceptionRequest({
        id: "req-1",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-1",
        requesterName: "Anna-Sophie Meyer",
        requesterHouseNumber: "92",
        status: "open",
      });
      withTelegramSession("holder-1");

      const result = (await runExecute({
        recipientName: "meyer",
        recipientHouseNumber: "92",
      })) as { package: Package; receptionRequestFulfilled: unknown };

      expect(result.receptionRequestFulfilled).not.toBeNull();
      expect(result.package.receptionRequestId).toBe("req-1");
      expect(requestStore.get("req-1")!.status).toBe("fulfilled");
    });

    it("picks the most recent eligible request when multiple match", async () => {
      seedResident({ platformId: "holder-1", id: "holder-1", houseNumber: "88" });
      seedResident({
        platformId: "requester-1",
        id: "requester-1",
        name: "Patricia",
        houseNumber: "90",
      });
      seedReceptionRequest({
        id: "req-old",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-1",
        requesterName: "Patricia",
        requesterHouseNumber: "90",
        status: "open",
        createdAt: new Date("2026-05-10T09:00:00Z").getTime(),
      });
      seedReceptionRequest({
        id: "req-new",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-1",
        requesterName: "Patricia",
        requesterHouseNumber: "90",
        status: "open",
        createdAt: new Date("2026-05-16T09:00:00Z").getTime(),
      });
      withTelegramSession("holder-1");

      const result = (await runExecute({
        recipientName: "Patricia",
        recipientHouseNumber: "90",
      })) as {
        package: Package;
        receptionRequestFulfilled: { requestId: string } | null;
      };

      expect(result.receptionRequestFulfilled?.requestId).toBe("req-new");
      expect(requestStore.get("req-new")!.status).toBe("fulfilled");
      expect(requestStore.get("req-old")!.status).toBe("open");
    });

    it("returns null fulfillment when there are no reception requests on the street", async () => {
      seedResident({ platformId: "holder-1", id: "holder-1", houseNumber: "88" });
      withTelegramSession("holder-1");

      const result = (await runExecute({
        recipientName: "Ritter",
        recipientHouseNumber: "92",
      })) as { package: Package; receptionRequestFulfilled: unknown };

      expect(result.receptionRequestFulfilled).toBeNull();
      expect(result.package.receptionRequestId).toBeUndefined();
    });

    it("falls back to language=null when the requester Resident is missing", async () => {
      seedResident({ platformId: "holder-1", id: "holder-1", houseNumber: "88" });
      seedReceptionRequest({
        id: "req-1",
        streetId: "Methfesselstraße",
        requesterResidentId: "requester-ghost",
        requesterName: "Patricia",
        requesterHouseNumber: "90",
        status: "open",
      });
      withTelegramSession("holder-1");

      const result = (await runExecute({
        recipientName: "Patricia",
        recipientHouseNumber: "90",
      })) as {
        package: Package;
        receptionRequestFulfilled: {
          requester: { language: string | null };
        } | null;
      };

      expect(result.receptionRequestFulfilled?.requester.language).toBeNull();
    });
  });
});
