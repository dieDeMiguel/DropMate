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
    async setReceptionRequest(req: ReceptionRequest) {
      requestStore.set(req.id, req);
      if (!streetIndex.has(req.streetId))
        streetIndex.set(req.streetId, new Set());
      streetIndex.get(req.streetId)!.add(req.id);
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/create_reception_request.js");
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
    name: overrides.name ?? "Patricia Höfer",
    street: overrides.street ?? "Methfesselstraße",
    houseNumber: overrides.houseNumber ?? "90",
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
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("create_reception_request", () => {
  beforeEach(() => {
    residentStore.clear();
    requestStore.clear();
    streetIndex.clear();
    sessionMock.value = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));
  });

  it("writes an 'open' ReceptionRequest with the caller as requester", async () => {
    seedResident({
      platformId: "patricia",
      name: "Patricia Höfer",
      houseNumber: "90",
    });
    seedResident({ platformId: "marlene", name: "Marlene Hartmann", houseNumber: "88" });
    seedResident({ platformId: "bremer", name: "Annemarie Bremer", houseNumber: "92" });
    withTelegramSession("patricia");

    const result = (await runExecute({
      expectedDate: "2026-05-19",
      carrier: "DHL",
      notes: "DHL package, signature required",
      candidateResidentIds: ["marlene", "bremer"],
    })) as { request: ReceptionRequest };

    expect(result.request.status).toBe("open");
    expect(result.request.requesterResidentId).toBe("patricia");
    expect(result.request.requesterName).toBe("Patricia Höfer");
    expect(result.request.requesterHouseNumber).toBe("90");
    expect(result.request.streetId).toBe("Methfesselstraße");
    expect(result.request.carrier).toBe("DHL");
    expect(result.request.expectedAt).toBe(Date.parse("2026-05-19"));
    expect(result.request.notes).toBe("DHL package, signature required");
    expect(result.request.candidateResidentIds).toEqual(["marlene", "bremer"]);
    expect(result.request.volunteerResidentId).toBeNull();
    expect(result.request.volunteerAvailability).toBeNull();
    expect(result.request.respondedAt).toBeNull();
    expect(result.request.createdAt).toBe(
      new Date("2026-05-17T10:00:00Z").getTime(),
    );
    expect(streetIndex.get("Methfesselstraße")?.has(result.request.id)).toBe(true);
  });

  it("defaults expectedAt to null, carrier to 'unknown', notes to undefined", async () => {
    seedResident({ platformId: "patricia" });
    seedResident({ platformId: "marlene", houseNumber: "88" });
    withTelegramSession("patricia");

    const result = (await runExecute({
      candidateResidentIds: ["marlene"],
    })) as { request: ReceptionRequest };

    expect(result.request.expectedAt).toBeNull();
    expect(result.request.carrier).toBe("unknown");
    expect(result.request.notes).toBeUndefined();
    expect(result.request.status).toBe("open");
  });

  it("schema rejects an empty candidate list", async () => {
    const tool = await loadTool();
    const schema = tool.inputSchema as { safeParse: (input: unknown) => { success: boolean } };
    expect(schema.safeParse({ candidateResidentIds: [] }).success).toBe(false);
  });

  it("schema rejects more than 3 candidates", async () => {
    const tool = await loadTool();
    const schema = tool.inputSchema as { safeParse: (input: unknown) => { success: boolean } };
    expect(
      schema.safeParse({ candidateResidentIds: ["a", "b", "c", "d"] }).success,
    ).toBe(false);
  });

  it("throws when the caller is not a registered resident", async () => {
    withTelegramSession("ghost");
    await expect(
      runExecute({ candidateResidentIds: ["marlene"] }),
    ).rejects.toThrow(/not a registered resident/);
  });
});
