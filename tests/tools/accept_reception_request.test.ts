import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceptionRequest, Resident } from "../../lib/redis.js";

const sessionMock = vi.hoisted(() => ({ value: null as unknown }));
const residentStore = vi.hoisted(() => new Map<string, Resident>());
const requestStore = vi.hoisted(() => new Map<string, ReceptionRequest>());
const streetIndex = vi.hoisted(() => new Map<string, Set<string>>());

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
    async getReceptionRequest(id: string) {
      return requestStore.get(id) ?? null;
    },
    async listReceptionRequestsForStreet(streetId: string) {
      const ids = streetIndex.get(streetId);
      if (!ids) return [];
      const out: ReceptionRequest[] = [];
      for (const id of ids) {
        const r = requestStore.get(id);
        if (r) out.push(r);
      }
      return out;
    },
    async setReceptionRequest(req: ReceptionRequest) {
      requestStore.set(req.id, req);
      if (!streetIndex.has(req.streetId))
        streetIndex.set(req.streetId, new Set());
      streetIndex.get(req.streetId)!.add(req.id);
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/accept_reception_request.js");
  return mod.default;
}

function withTelegramSession(principalId: string): void {
  sessionMock.value = {
    sessionId: "sess-test",
    turn: { id: "turn-1", index: 0 },
    auth: {
      current: {
        attributes: {},
        authenticator: "telegram",
        principalId,
        principalType: "user",
      },
      initiator: {
        attributes: {},
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
    name: overrides.name ?? "Marlene Hartmann",
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

function seedRequest(overrides: Partial<ReceptionRequest> & { id: string; streetId: string }): ReceptionRequest {
  const r: ReceptionRequest = {
    id: overrides.id,
    streetId: overrides.streetId,
    requesterResidentId: overrides.requesterResidentId ?? "patricia",
    requesterName: overrides.requesterName ?? "Patricia Höfer",
    requesterHouseNumber: overrides.requesterHouseNumber ?? "90",
    carrier: overrides.carrier ?? "DHL",
    expectedAt: overrides.expectedAt ?? null,
    notes: overrides.notes,
    candidateResidentIds: overrides.candidateResidentIds ?? ["marlene", "bremer"],
    volunteerResidentId: overrides.volunteerResidentId ?? null,
    volunteerAvailability: overrides.volunteerAvailability ?? null,
    status: overrides.status ?? "open",
    createdAt: overrides.createdAt ?? Date.now(),
    respondedAt: overrides.respondedAt ?? null,
    trackingNumber: overrides.trackingNumber,
    screenshotFileId: overrides.screenshotFileId,
    expectedWindowStartAt: overrides.expectedWindowStartAt,
    expectedWindowEndAt: overrides.expectedWindowEndAt,
    groupCardChatId: overrides.groupCardChatId,
    groupCardMessageId: overrides.groupCardMessageId,
    parseConfidence: overrides.parseConfidence,
  };
  requestStore.set(r.id, r);
  if (!streetIndex.has(r.streetId)) streetIndex.set(r.streetId, new Set());
  streetIndex.get(r.streetId)!.add(r.id);
  return r;
}

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("accept_reception_request", () => {
  beforeEach(() => {
    residentStore.clear();
    requestStore.clear();
    streetIndex.clear();
    sessionMock.value = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T11:00:00Z"));
  });

  it("flips an open request to matched and records volunteer + availability", async () => {
    seedResident({
      platformId: "marlene",
      name: "Marlene Hartmann",
      houseNumber: "88",
      floor: "IV",
      buzzerName: "Hartmann",
    });
    seedResident({ platformId: "patricia", name: "Patricia Höfer", houseNumber: "90" });
    seedRequest({
      id: "req-1",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      candidateResidentIds: ["marlene", "bremer"],
    });
    withTelegramSession("marlene");

    const result = (await runExecute({
      availability: "bis 15 Uhr",
    })) as {
      request: ReceptionRequest;
      requester: { id: string; name: string; houseNumber: string; language: string | null };
      volunteer: {
        id: string;
        name: string;
        houseNumber: string;
        floor: string | null;
        buzzerName: string | null;
        language: string | null;
        platformId: string;
      };
      groupCardChatId: number | null;
      groupCardMessageId: number | null;
    };

    expect(result.request.id).toBe("req-1");
    expect(result.request.status).toBe("matched");
    expect(result.request.volunteerResidentId).toBe("marlene");
    expect(result.request.volunteerAvailability).toBe("bis 15 Uhr");
    expect(result.request.respondedAt).toBe(
      new Date("2026-05-17T11:00:00Z").getTime(),
    );
    expect(requestStore.get("req-1")?.status).toBe("matched");

    expect(result.requester).toEqual({
      id: "patricia",
      name: "Patricia Höfer",
      houseNumber: "90",
      language: "de",
    });
    expect(result.volunteer).toEqual({
      id: "marlene",
      name: "Marlene Hartmann",
      houseNumber: "88",
      floor: "IV",
      buzzerName: "Hartmann",
      language: "de",
      platformId: "marlene",
    });
    // No group card on this soft-deprecated DM-3 request.
    expect(result.groupCardChatId).toBeNull();
    expect(result.groupCardMessageId).toBeNull();
  });

  it("picks the most recent open request when several exist", async () => {
    seedResident({ platformId: "marlene", houseNumber: "88" });
    seedResident({ platformId: "patricia", name: "Patricia", houseNumber: "90" });
    seedResident({ platformId: "ulf", name: "Ulf", houseNumber: "86" });
    seedRequest({
      id: "req-old",
      streetId: "Methfesselstraße",
      requesterResidentId: "ulf",
      requesterName: "Ulf",
      requesterHouseNumber: "86",
      candidateResidentIds: ["marlene"],
      createdAt: Date.parse("2026-05-15T10:00:00Z"),
    });
    seedRequest({
      id: "req-new",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      requesterName: "Patricia",
      requesterHouseNumber: "90",
      candidateResidentIds: ["marlene"],
      createdAt: Date.parse("2026-05-17T09:00:00Z"),
    });
    withTelegramSession("marlene");

    const result = (await runExecute({ availability: "until 18:00" })) as {
      request: ReceptionRequest;
    };

    expect(result.request.id).toBe("req-new");
  });

  it("ignores already-matched requests", async () => {
    seedResident({ platformId: "marlene", houseNumber: "88" });
    seedResident({ platformId: "patricia", houseNumber: "90" });
    seedRequest({
      id: "req-1",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      candidateResidentIds: ["marlene"],
      status: "matched",
      volunteerResidentId: "marlene",
    });
    withTelegramSession("marlene");

    await expect(
      runExecute({ availability: "until 18:00" }),
    ).rejects.toThrow(/no open reception request/);
  });

  it("ignores requests where the caller is not in the candidate list", async () => {
    seedResident({ platformId: "marlene", houseNumber: "88" });
    seedResident({ platformId: "patricia", houseNumber: "90" });
    seedRequest({
      id: "req-other",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      candidateResidentIds: ["bremer"], // marlene NOT in the list
    });
    withTelegramSession("marlene");

    await expect(
      runExecute({ availability: "until 18:00" }),
    ).rejects.toThrow(/no open reception request/);
  });

  it("respects the explicit requestId override", async () => {
    seedResident({ platformId: "marlene", houseNumber: "88" });
    seedResident({ platformId: "patricia", name: "Patricia", houseNumber: "90" });
    seedResident({ platformId: "ulf", name: "Ulf", houseNumber: "86" });
    seedRequest({
      id: "req-old",
      streetId: "Methfesselstraße",
      requesterResidentId: "ulf",
      requesterName: "Ulf",
      requesterHouseNumber: "86",
      candidateResidentIds: ["marlene"],
      createdAt: Date.parse("2026-05-15T10:00:00Z"),
    });
    seedRequest({
      id: "req-new",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      requesterName: "Patricia",
      requesterHouseNumber: "90",
      candidateResidentIds: ["marlene"],
      createdAt: Date.parse("2026-05-17T09:00:00Z"),
    });
    withTelegramSession("marlene");

    const result = (await runExecute({
      availability: "until 18:00",
      requestId: "req-old",
    })) as { request: ReceptionRequest };

    expect(result.request.id).toBe("req-old");
  });

  it("rejects explicit requestId when caller is not a candidate for that request", async () => {
    seedResident({ platformId: "marlene", houseNumber: "88" });
    seedResident({ platformId: "patricia", houseNumber: "90" });
    seedRequest({
      id: "req-other",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      candidateResidentIds: ["bremer"],
    });
    withTelegramSession("marlene");

    await expect(
      runExecute({ availability: "until 18:00", requestId: "req-other" }),
    ).rejects.toThrow(/not in the candidate list/);
  });

  it("throws when the caller is not a registered resident", async () => {
    withTelegramSession("ghost");
    await expect(
      runExecute({ availability: "until 18:00" }),
    ).rejects.toThrow(/not a registered resident/);
  });

  it("accepts a group-card request with empty candidate list when requestId is supplied", async () => {
    seedResident({
      platformId: "marlene",
      name: "Marlene Hartmann",
      houseNumber: "88",
      floor: "IV",
      buzzerName: "Hartmann",
    });
    seedResident({ platformId: "patricia", name: "Patricia", houseNumber: "90" });
    seedRequest({
      id: "req-group",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      candidateResidentIds: [],
      groupCardChatId: -100123,
      groupCardMessageId: 777,
      trackingNumber: "AB123",
      expectedWindowStartAt: Date.parse("2026-05-17T12:00:00Z"),
      expectedWindowEndAt: Date.parse("2026-05-17T16:00:00Z"),
    });
    withTelegramSession("marlene");

    const result = (await runExecute({
      availability: "bis 16 Uhr",
      requestId: "req-group",
    })) as {
      request: ReceptionRequest;
      volunteer: { id: string; floor: string | null; buzzerName: string | null };
      groupCardChatId: number | null;
      groupCardMessageId: number | null;
    };

    expect(result.request.status).toBe("matched");
    expect(result.request.volunteerResidentId).toBe("marlene");
    expect(result.groupCardChatId).toBe(-100123);
    expect(result.groupCardMessageId).toBe(777);
    expect(result.volunteer.floor).toBe("IV");
    expect(result.volunteer.buzzerName).toBe("Hartmann");
    // Original fields preserved on the matched record.
    expect(result.request.trackingNumber).toBe("AB123");
    expect(result.request.expectedWindowStartAt).toBe(
      Date.parse("2026-05-17T12:00:00Z"),
    );
  });

  it("rejects a group-card request when the caller is on a different street", async () => {
    seedResident({
      platformId: "marlene",
      name: "Marlene",
      houseNumber: "88",
      street: "Other-Straße",
    });
    seedResident({ platformId: "patricia", name: "Patricia", houseNumber: "90" });
    seedRequest({
      id: "req-group",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      candidateResidentIds: [],
      groupCardMessageId: 777,
    });
    withTelegramSession("marlene");

    await expect(
      runExecute({ availability: "x", requestId: "req-group" }),
    ).rejects.toThrow(/different street|on .* request .* is on/i);
  });

  it("volunteer.floor and buzzerName default to null when the volunteer has none stored", async () => {
    seedResident({
      platformId: "marlene",
      name: "Marlene",
      houseNumber: "88",
      floor: undefined,
      buzzerName: undefined,
    });
    seedResident({ platformId: "patricia", houseNumber: "90" });
    seedRequest({
      id: "req-1",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      candidateResidentIds: ["marlene"],
    });
    withTelegramSession("marlene");

    const result = (await runExecute({ availability: "x" })) as {
      volunteer: { floor: string | null; buzzerName: string | null };
    };

    expect(result.volunteer.floor).toBeNull();
    expect(result.volunteer.buzzerName).toBeNull();
  });

  it("requester.language defaults to null when the requester has no stored language", async () => {
    seedResident({ platformId: "marlene", houseNumber: "88" });
    seedResident({
      platformId: "patricia",
      name: "Patricia",
      houseNumber: "90",
      language: undefined,
    });
    seedRequest({
      id: "req-1",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      candidateResidentIds: ["marlene"],
    });
    withTelegramSession("marlene");

    const result = (await runExecute({ availability: "x" })) as {
      requester: { language: string | null };
    };

    expect(result.requester.language).toBeNull();
  });
});
