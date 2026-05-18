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
  const mod = await import("../../agent/tools/scan_due_unfulfilled_requests.js");
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
    status: overrides.status ?? "matched",
    createdAt: overrides.createdAt ?? Date.now(),
    respondedAt: overrides.respondedAt ?? null,
    groupCardChatId: overrides.groupCardChatId,
    groupCardMessageId: overrides.groupCardMessageId,
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
const H48 = 48 * 60 * 60 * 1000;

describe("scan_due_unfulfilled_requests", () => {
  beforeEach(() => {
    residentStore.clear();
    requestStore.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("returns matched requests whose volunteer accepted > 48h ago with both summaries", async () => {
    seedResident({ platformId: "patricia", name: "Patricia Höfer", houseNumber: "90", language: "de" });
    seedResident({ platformId: "marlene", name: "Marlene Hartmann", houseNumber: "88", language: "de" });
    seedRequest({
      id: "req-1",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      status: "matched",
      createdAt: NOW - H48 - 60_000,
      respondedAt: NOW - H48 - 1000,
      volunteerResidentId: "marlene",
      volunteerAvailability: "bis 15 Uhr",
      carrier: "DHL",
    });

    const result = (await runExecute()) as {
      entries: Array<{
        requestId: string;
        carrier: string;
        respondedAt: number;
        requester: { id: string; name: string; houseNumber: string; language: string | null } | null;
        volunteer: { id: string; name: string; houseNumber: string; language: string | null } | null;
      }>;
      now: number;
    };

    expect(result.now).toBe(NOW);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].requestId).toBe("req-1");
    expect(result.entries[0].carrier).toBe("DHL");
    expect(result.entries[0].respondedAt).toBe(NOW - H48 - 1000);
    expect(result.entries[0].requester).toEqual({
      id: "patricia",
      name: "Patricia Höfer",
      houseNumber: "90",
      language: "de",
    });
    expect(result.entries[0].volunteer).toEqual({
      id: "marlene",
      name: "Marlene Hartmann",
      houseNumber: "88",
      language: "de",
    });
  });

  it("does not return matched requests whose respondedAt is less than 48h ago", async () => {
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "matched",
      respondedAt: NOW - H48 + 5_000,
      volunteerResidentId: "marlene",
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return open requests (out of scope — handled by 4h schedule)", async () => {
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "open",
      createdAt: NOW - H48 - 1000,
      respondedAt: null,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("does not return fulfilled or expired requests", async () => {
    seedRequest({
      id: "req-fulfilled",
      streetId: "S",
      status: "fulfilled",
      respondedAt: NOW - H48 - 1000,
    });
    seedRequest({
      id: "req-expired",
      streetId: "S",
      status: "expired",
      respondedAt: NOW - H48 - 1000,
    });
    const result = (await runExecute()) as { entries: unknown[] };
    expect(result.entries).toHaveLength(0);
  });

  it("tolerates a deleted volunteer resident — volunteer summary null", async () => {
    seedResident({ platformId: "patricia" });
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "matched",
      respondedAt: NOW - H48 - 1000,
      volunteerResidentId: "ghost-volunteer",
    });
    const result = (await runExecute()) as {
      entries: Array<{ volunteer: unknown; requester: unknown }>;
    };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].volunteer).toBeNull();
    expect(result.entries[0].requester).not.toBeNull();
  });

  it("returns an empty list when nothing is due", async () => {
    const result = (await runExecute()) as { entries: unknown[]; now: number };
    expect(result.entries).toEqual([]);
    expect(result.now).toBe(NOW);
  });

  it("surfaces groupCardChatId + groupCardMessageId when populated", async () => {
    seedResident({ platformId: "patricia" });
    seedResident({ platformId: "marlene" });
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "matched",
      respondedAt: NOW - H48 - 1000,
      volunteerResidentId: "marlene",
      groupCardChatId: -1009999999999,
      groupCardMessageId: 7777,
    });
    const result = (await runExecute()) as {
      entries: Array<{ groupCardChatId: number | null; groupCardMessageId: number | null }>;
    };
    expect(result.entries[0].groupCardChatId).toBe(-1009999999999);
    expect(result.entries[0].groupCardMessageId).toBe(7777);
  });

  it("returns groupCardChatId + groupCardMessageId as null on DM-3-path records", async () => {
    seedResident({ platformId: "patricia" });
    seedResident({ platformId: "marlene" });
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "matched",
      respondedAt: NOW - H48 - 1000,
      volunteerResidentId: "marlene",
    });
    const result = (await runExecute()) as {
      entries: Array<{ groupCardChatId: number | null; groupCardMessageId: number | null }>;
    };
    expect(result.entries[0].groupCardChatId).toBeNull();
    expect(result.entries[0].groupCardMessageId).toBeNull();
  });
});
