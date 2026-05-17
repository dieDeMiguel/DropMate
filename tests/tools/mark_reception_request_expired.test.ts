import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceptionRequest } from "../../lib/redis.js";

const requestStore = vi.hoisted(() => new Map<string, ReceptionRequest>());

vi.mock("../../lib/redis.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/redis.js")>(
    "../../lib/redis.js",
  );
  return {
    ...actual,
    async getReceptionRequest(id: string) {
      return requestStore.get(id) ?? null;
    },
    async setReceptionRequest(req: ReceptionRequest) {
      requestStore.set(req.id, req);
    },
  };
});

async function loadTool() {
  const mod = await import("../../agent/tools/mark_reception_request_expired.js");
  return mod.default;
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

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("mark_reception_request_expired", () => {
  beforeEach(() => {
    requestStore.clear();
  });

  it("flips an open request to expired and persists", async () => {
    seedRequest({ id: "req-1", streetId: "S", status: "open" });
    const result = (await runExecute({ requestId: "req-1" })) as {
      request: ReceptionRequest;
      alreadyExpired: boolean;
    };
    expect(result.alreadyExpired).toBe(false);
    expect(result.request.status).toBe("expired");
    expect(requestStore.get("req-1")?.status).toBe("expired");
  });

  it("flips a matched request to expired and persists", async () => {
    seedRequest({
      id: "req-1",
      streetId: "S",
      status: "matched",
      volunteerResidentId: "marlene",
      volunteerAvailability: "bis 15 Uhr",
      respondedAt: Date.now() - 1000,
    });
    const result = (await runExecute({ requestId: "req-1" })) as {
      request: ReceptionRequest;
      alreadyExpired: boolean;
    };
    expect(result.alreadyExpired).toBe(false);
    expect(result.request.status).toBe("expired");
    expect(result.request.volunteerResidentId).toBe("marlene");
    expect(requestStore.get("req-1")?.status).toBe("expired");
  });

  it("is idempotent — second call reports alreadyExpired", async () => {
    seedRequest({ id: "req-1", streetId: "S", status: "expired" });
    const result = (await runExecute({ requestId: "req-1" })) as {
      request: ReceptionRequest;
      alreadyExpired: boolean;
    };
    expect(result.alreadyExpired).toBe(true);
    expect(result.request.status).toBe("expired");
  });

  it("refuses to expire a fulfilled request", async () => {
    seedRequest({ id: "req-1", streetId: "S", status: "fulfilled" });
    await expect(runExecute({ requestId: "req-1" })).rejects.toThrow(
      /refusing to expire a fulfilled request/,
    );
    expect(requestStore.get("req-1")?.status).toBe("fulfilled");
  });

  it("throws when the request id does not exist", async () => {
    await expect(runExecute({ requestId: "req-missing" })).rejects.toThrow(
      /no request with id=req-missing/,
    );
  });
});
