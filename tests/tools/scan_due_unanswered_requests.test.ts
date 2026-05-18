import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceptionRequest, Resident } from "../../lib/redis.js";

const residentStore = vi.hoisted(() => new Map<string, Resident>());
const requestStore = vi.hoisted(() => new Map<string, ReceptionRequest>());

vi.mock("../../lib/redis.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/redis.js")>(
    "../../lib/redis.js",
  );
  return {
    ...actual,
    async getResident(platformId: string) {
      return residentStore.get(platformId) ?? null;
    },
    async listAllReceptionRequests() {
      return Array.from(requestStore.values());
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/scan_due_unanswered_requests.js");
  return mod.default;
}

function seedResident(
  overrides: Partial<Resident> & { platformId: string },
): Resident {
  const r: Resident = {
    id: overrides.id ?? overrides.platformId,
    name: overrides.name ?? "Patricia Höfer",
    street: overrides.street ?? "Methfesselstraße",
    houseNumber: overrides.houseNumber ?? "90",
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
    candidateResidentIds: overrides.candidateResidentIds ?? ["marlene"],
    volunteerResidentId: overrides.volunteerResidentId ?? null,
    volunteerAvailability: overrides.volunteerAvailability ?? null,
    status: overrides.status ?? "open",
    createdAt: overrides.createdAt ?? Date.now(),
    respondedAt: overrides.respondedAt ?? null,
  };
  requestStore.set(r.id, r);
  return r;
}

async function runExecute() {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute({}, { toolCallId: "call-1", messages: [] });
}

const NOW = new Date("2026-05-17T14:00:00Z").getTime();
const H4 = 4 * 60 * 60 * 1000;

describe("scan_due_unanswered_requests", () => {
  beforeEach(() => {
    residentStore.clear();
    requestStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("returns open requests older than 4h with requester summary", async () => {
    seedResident({ platformId: "patricia", name: "Patricia Höfer", houseNumber: "90", language: "de" });
    seedRequest({
      id: "req-1",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      status: "open",
      createdAt: NOW - H4 - 1000,
      carrier: "DHL",
      notes: "Geburtstag",
      candidateResidentIds: ["marlene", "bremer"],
    });

    const result = (await runExecute()) as {
      entries: Array<{
        requestId: string;
        streetId: string;
        carrier: string;
        createdAt: number;
        notes: string | null;
        candidateResidentIds: readonly string[];
        requester: { id: string; name: string; houseNumber: string; language: string | null } | null;
      }>;
      now: number;
    };

    expect(result.now).toBe(NOW);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].requestId).toBe("req-1");
    expect(result.entries[0].streetId).toBe("Methfesselstraße");
    expect(result.entries[0].carrier).toBe("DHL");
    expect(result.entries[0].notes).toBe("Geburtstag");
    expect(result.entries[0].candidateResidentIds).toEqual(["marlene", "bremer"]);
    expect(result.entries[0].requester).toEqual({
      id: "patricia",
      name: "Patricia Höfer",
      houseNumber: "90",
      language: "de",
    });
  });

  it("does not return open requests created less than 4h ago", async () => {
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "open",
      createdAt: NOW - H4 + 5_000,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return matched requests (out of scope — handled by 48h schedule)", async () => {
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "matched",
      createdAt: NOW - H4 - 1000,
      respondedAt: NOW - 60_000,
      volunteerResidentId: "marlene",
      volunteerAvailability: "bis 15 Uhr",
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return fulfilled or expired requests", async () => {
    seedRequest({
      id: "req-fulfilled",
      streetId: "S",
      status: "fulfilled",
      createdAt: NOW - H4 - 1000,
    });
    seedRequest({
      id: "req-expired",
      streetId: "S",
      status: "expired",
      createdAt: NOW - H4 - 1000,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("returns requester: null when the requester resident has been deleted", async () => {
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "open",
      createdAt: NOW - H4 - 1000,
      requesterResidentId: "ghost",
    });
    const result = (await runExecute()) as {
      entries: Array<{ requester: unknown }>;
    };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].requester).toBeNull();
  });

  it("returns an empty list when nothing is due", async () => {
    const result = (await runExecute()) as { entries: unknown[]; now: number };
    expect(result.entries).toEqual([]);
    expect(result.now).toBe(NOW);
  });

  it("passes through expectedAt, defaulting notes to null when absent", async () => {
    seedResident({ platformId: "patricia" });
    const expectedAt = Date.parse("2026-05-20");
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "open",
      createdAt: NOW - H4 - 1000,
      expectedAt,
    });
    const result = (await runExecute()) as {
      entries: Array<{ expectedAt: number | null; notes: string | null }>;
    };
    expect(result.entries[0].expectedAt).toBe(expectedAt);
    expect(result.entries[0].notes).toBeNull();
  });
});
