import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceptionRequest, Resident } from "./redis.js";

/**
 * Lib-level tests for `acceptReceptionRequest` — the function that the
 * channel callback handler now calls directly (v2.1 Slice 4 / #89) when
 * a registered resident taps `[Ich kann helfen]`. The live trace at #92
 * showed it throwing on production data; the v2.1 Bug 3 fix (#95) adds
 * per-step logging + defensive handling for sparse fields. These tests
 * pin those guarantees: a sparse `ReceptionRequest` (no carrier window,
 * no group-card ids, missing optional resident fields) must NOT throw
 * and must return a coherent `AcceptReceptionRequestResult`.
 *
 * The function calls into `lib/redis.js`; the store is mocked in-memory
 * the same way `tests/tools/scan_due_unanswered_requests.test.ts` mocks
 * it for tool tests.
 */
const residentStore = vi.hoisted(() => new Map<string, Resident>());
const requestStore = vi.hoisted(() => new Map<string, ReceptionRequest>());

vi.mock("./redis.js", async () => {
  const actual = await vi.importActual<typeof import("./redis.js")>(
    "./redis.js",
  );
  return {
    ...actual,
    async getReceptionRequest(id: string) {
      return requestStore.get(id) ?? null;
    },
    async setReceptionRequest(req: ReceptionRequest) {
      requestStore.set(req.id, req);
    },
    async listReceptionRequestsForStreet(streetId: string) {
      return Array.from(requestStore.values()).filter(
        (r) => r.streetId === streetId,
      );
    },
    async getResident(platformId: string) {
      return residentStore.get(platformId) ?? null;
    },
  };
});

async function loadLib() {
  return import("./reception-request.js");
}

function seedResident(overrides: Partial<Resident> & { platformId: string }): Resident {
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

describe("acceptReceptionRequest (v2.1 Bug 3 / #95 — defensive sparse-field handling)", () => {
  beforeEach(() => {
    residentStore.clear();
    requestStore.clear();
    vi.restoreAllMocks();
  });

  it("returns a coherent result for the Trace A repro: sparse Bug-1 record (carrier=DHL, window, group-card ids) + valid volunteer", async () => {
    // Pinned to the conditions described in #92 Trace A:
    // Natascha (registered volunteer) taps `[Ich kann helfen]` on
    // Diego's card after the v2.1 classifier-side fix (#93) populated
    // `carrier`, `expectedWindowStartAt`, `expectedWindowEndAt`, and
    // the `groupCardChatId` / `groupCardMessageId` patch.
    const requester = seedResident({
      platformId: "200",
      name: "Diego de Miguel",
      houseNumber: "69",
      language: "de",
    });
    const volunteer = seedResident({
      platformId: "300",
      name: "Natascha Hartmann",
      houseNumber: "88",
      floor: "V.",
      buzzerName: "Hartmann",
      language: "de",
    });
    seedRequest({
      id: "req_42",
      streetId: "Methfesselstraße",
      requesterResidentId: requester.platformId,
      requesterName: requester.name,
      requesterHouseNumber: requester.houseNumber,
      carrier: "DHL",
      expectedWindowStartAt: 1716122400000,
      expectedWindowEndAt: 1716133200000,
      groupCardChatId: -100123,
      groupCardMessageId: 555,
    });

    const { acceptReceptionRequest } = await loadLib();
    const result = await acceptReceptionRequest(volunteer, { requestId: "req_42" });

    expect(result.request.status).toBe("matched");
    expect(result.request.volunteerResidentId).toBe(volunteer.id);
    expect(result.request.volunteerAvailability).toBeNull();
    expect(result.requester.id).toBe("200");
    expect(result.requester.name).toBe("Diego de Miguel");
    expect(result.requester.language).toBe("de");
    expect(result.volunteer.id).toBe("300");
    expect(result.volunteer.platformId).toBe("300");
    expect(result.volunteer.floor).toBe("V.");
    expect(result.volunteer.buzzerName).toBe("Hartmann");
    expect(result.groupCardChatId).toBe(-100123);
    expect(result.groupCardMessageId).toBe(555);
  });

  it("handles a fully sparse request (carrier=unknown, no window, no group card) without throwing", async () => {
    const requester = seedResident({
      platformId: "201",
      name: "Patricia",
      houseNumber: "90",
    });
    const volunteer = seedResident({
      platformId: "301",
      name: "Marlene",
      houseNumber: "88",
      // No floor, no buzzerName.
      floor: undefined,
      buzzerName: undefined,
    });
    seedRequest({
      id: "req_sparse",
      streetId: "Methfesselstraße",
      requesterResidentId: requester.platformId,
      requesterName: requester.name,
      requesterHouseNumber: requester.houseNumber,
      carrier: "unknown",
      expectedAt: null,
      // No expectedWindow*, no groupCard*.
    });

    const { acceptReceptionRequest } = await loadLib();
    const result = await acceptReceptionRequest(volunteer, {
      requestId: "req_sparse",
    });

    expect(result.request.status).toBe("matched");
    expect(result.request.carrier).toBe("unknown");
    expect(result.request.expectedWindowStartAt).toBeUndefined();
    expect(result.request.expectedWindowEndAt).toBeUndefined();
    expect(result.groupCardChatId).toBeNull();
    expect(result.groupCardMessageId).toBeNull();
    expect(result.volunteer.floor).toBeNull();
    expect(result.volunteer.buzzerName).toBeNull();
  });

  it("falls back to the request's frozen requester fields when the requester Resident record is missing", async () => {
    // The requester deleted their account or was never registered as a
    // resident — the request still carries the name + house number, so
    // accept must succeed and surface those frozen fields.
    const volunteer = seedResident({
      platformId: "302",
      name: "Marlene",
      houseNumber: "88",
    });
    seedRequest({
      id: "req_orphan",
      streetId: "Methfesselstraße",
      requesterResidentId: "ghost_400",
      requesterName: "Ghost Requester",
      requesterHouseNumber: "77",
    });

    const { acceptReceptionRequest } = await loadLib();
    const result = await acceptReceptionRequest(volunteer, {
      requestId: "req_orphan",
    });

    expect(result.requester.id).toBe("ghost_400");
    expect(result.requester.name).toBe("Ghost Requester");
    expect(result.requester.houseNumber).toBe("77");
    expect(result.requester.language).toBeNull();
    expect(result.requester.floor).toBeNull();
    expect(result.requester.buzzerName).toBeNull();
  });

  it("logs `step=getReceptionRequest` and `step=setReceptionRequest` and `done` for the happy path so a subsequent failure shows where it failed", async () => {
    const volunteer = seedResident({
      platformId: "303",
      name: "Marlene",
      houseNumber: "88",
    });
    seedResident({
      platformId: "203",
      name: "Patricia",
      houseNumber: "90",
    });
    seedRequest({
      id: "req_logs",
      streetId: "Methfesselstraße",
      requesterResidentId: "203",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const { acceptReceptionRequest } = await loadLib();
    await acceptReceptionRequest(volunteer, { requestId: "req_logs" });

    const logged = info.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(
      "[acceptReceptionRequest] step=getReceptionRequest",
    );
    expect(logged).toContain(
      "[acceptReceptionRequest] step=setReceptionRequest",
    );
    expect(logged).toContain(
      "[acceptReceptionRequest] step=getResident(requester)",
    );
    expect(logged).toContain("[acceptReceptionRequest] done");
  });

  it("wraps the error with the failed step name when getReceptionRequest throws (Redis hiccup)", async () => {
    const volunteer = seedResident({
      platformId: "304",
      name: "Marlene",
      houseNumber: "88",
    });
    // Re-mock getReceptionRequest to throw mid-call. We import once
    // here to grab the live module reference.
    const lib = await loadLib();
    const redis = await import("./redis.js");
    vi.spyOn(redis, "getReceptionRequest").mockRejectedValueOnce(
      new Error("ECONNREFUSED upstash"),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      lib.acceptReceptionRequest(volunteer, { requestId: "req_x" }),
    ).rejects.toThrow(/getReceptionRequest failed: ECONNREFUSED upstash/);

    // Step-level error log fires so a future failure shows which
    // subroutine threw (the truncated production log made this
    // impossible to root-cause for #92).
    const errorLines = err.mock.calls.map((c) => String(c[0]));
    expect(errorLines).toContain(
      "[acceptReceptionRequest] step=getReceptionRequest threw",
    );
  });

  it("still allows the accept when the requester's Resident lookup throws (degrades to frozen-fields path)", async () => {
    const volunteer = seedResident({
      platformId: "305",
      name: "Marlene",
      houseNumber: "88",
    });
    seedRequest({
      id: "req_redis_hiccup",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      requesterName: "Patricia",
      requesterHouseNumber: "90",
    });
    const redis = await import("./redis.js");
    vi.spyOn(redis, "getResident").mockRejectedValueOnce(
      new Error("ECONNREFUSED upstash"),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const { acceptReceptionRequest } = await loadLib();
    const result = await acceptReceptionRequest(volunteer, {
      requestId: "req_redis_hiccup",
    });

    expect(result.request.status).toBe("matched");
    expect(result.requester.name).toBe("Patricia");
    expect(result.requester.language).toBeNull();
    const errorLines = err.mock.calls.map((c) => String(c[0]));
    expect(errorLines).toContain(
      "[acceptReceptionRequest] getResident(requester) failed, falling back to frozen request fields",
    );
  });

  it("rejects with the expected message when the requestId is not on the caller's street (defensive backstop)", async () => {
    const volunteer = seedResident({
      platformId: "306",
      name: "Marlene",
      houseNumber: "88",
      street: "Methfesselstraße",
    });
    seedRequest({
      id: "req_otherstreet",
      streetId: "Some Other Street",
    });

    const { acceptReceptionRequest } = await loadLib();
    await expect(
      acceptReceptionRequest(volunteer, { requestId: "req_otherstreet" }),
    ).rejects.toThrow(/different street/);
  });

  it("rejects with the expected message when the request is already matched", async () => {
    const volunteer = seedResident({
      platformId: "307",
      name: "Marlene",
      houseNumber: "88",
    });
    seedRequest({
      id: "req_taken",
      streetId: "Methfesselstraße",
      status: "matched",
    });

    const { acceptReceptionRequest } = await loadLib();
    await expect(
      acceptReceptionRequest(volunteer, { requestId: "req_taken" }),
    ).rejects.toThrow(/already matched/);
  });
});
