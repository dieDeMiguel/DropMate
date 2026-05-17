import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Resident } from "../../lib/redis.js";

const residentStore = vi.hoisted(() => new Map<string, Resident>());

vi.mock("../../lib/redis.js", () => ({
  async getResident(platformId: string) {
    return residentStore.get(platformId) ?? null;
  },
}));

async function loadTool() {
  const mod = await import("../../agent/tools/notify_recipient.js");
  return mod.default;
}

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

function seedResident(overrides: Partial<Resident> & { platformId: string }): Resident {
  const r: Resident = {
    id: overrides.id ?? overrides.platformId,
    name: overrides.name ?? "Anna-Sophie Meyer",
    street: overrides.street ?? "Methfesselstraße",
    houseNumber: overrides.houseNumber ?? "92",
    floor: overrides.floor,
    buzzerName: overrides.buzzerName,
    platformId: overrides.platformId,
    platform: "telegram",
    language: overrides.language,
    availabilityPatterns: overrides.availabilityPatterns ?? [],
    registeredAt: overrides.registeredAt ?? Date.now(),
    source: overrides.source ?? "explicit",
    confirmed: overrides.confirmed ?? true,
  };
  residentStore.set(r.platformId, r);
  return r;
}

const TEST_TOKEN = "111222:abcdef";

describe("notify_recipient", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    residentStore.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = TEST_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("DMs the resident via sendMessage with chat_id = Number(platformId)", async () => {
    seedResident({ platformId: "987654", language: "de" });

    const result = (await runExecute({
      recipientResidentId: "987654",
      text: "Dein Paket liegt bei Bremer (Hs.92, 5. Etage).",
    })) as { delivered: boolean; language: string | null };

    expect(result).toEqual({ delivered: true, language: "de" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: 987654,
      text: "Dein Paket liegt bei Bremer (Hs.92, 5. Etage).",
    });
  });

  it("returns language: null when the resident has no stored language", async () => {
    seedResident({ platformId: "111", language: undefined });
    const result = (await runExecute({
      recipientResidentId: "111",
      text: "hi",
    })) as { delivered: boolean; language: string | null };
    expect(result).toEqual({ delivered: true, language: null });
  });

  it("throws when the resident is not registered", async () => {
    await expect(
      runExecute({ recipientResidentId: "doesnotexist", text: "hi" }),
    ).rejects.toThrow(/no resident found for id=doesnotexist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when TELEGRAM_BOT_TOKEN is unset, without touching Redis", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await expect(
      runExecute({ recipientResidentId: "987654", text: "hi" }),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards inline-keyboard buttons as reply_markup with snake_case callback_data", async () => {
    seedResident({ platformId: "987654", language: "de" });

    await runExecute({
      recipientResidentId: "987654",
      text: "Dein Paket ist da.",
      buttons: [
        [
          { text: "Abgeholt", callbackData: "confirm_pickup:pkg_42" },
          { text: "Später erinnern", callbackData: "remind_later:pkg_42" },
        ],
      ],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: 987654,
      text: "Dein Paket ist da.",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Abgeholt", callback_data: "confirm_pickup:pkg_42" },
            { text: "Später erinnern", callback_data: "remind_later:pkg_42" },
          ],
        ],
      },
    });
  });

  it("omits reply_markup when buttons not supplied", async () => {
    seedResident({ platformId: "987654", language: "de" });
    await runExecute({ recipientResidentId: "987654", text: "plain" });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.reply_markup).toBeUndefined();
  });
});
