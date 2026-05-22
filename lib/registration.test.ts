import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Resident } from "./redis.js";

const residentStore = vi.hoisted(() => new Map<string, Resident>());

vi.mock("./redis.js", async () => {
  const actual = await vi.importActual<typeof import("./redis.js")>(
    "./redis.js",
  );
  return {
    ...actual,
    async getResident(platformId: string) {
      return residentStore.get(platformId) ?? null;
    },
    async setResident(resident: Resident) {
      residentStore.set(resident.platformId, resident);
    },
  };
});

async function loadLib() {
  return import("./registration.js");
}

describe("isRegisterCommand", () => {
  it("matches `/register` on its own", async () => {
    const { isRegisterCommand } = await loadLib();
    expect(isRegisterCommand("/register")).toBe(true);
  });
  it("matches `/register` with args", async () => {
    const { isRegisterCommand } = await loadLib();
    expect(
      isRegisterCommand("/register Diego de Miguel Lutterothstrasse 69"),
    ).toBe(true);
  });
  it("matches `/register@DropMate_bot`", async () => {
    const { isRegisterCommand } = await loadLib();
    expect(isRegisterCommand("/register@DropMate_bot")).toBe(true);
  });
  it("rejects `/registerx`", async () => {
    const { isRegisterCommand } = await loadLib();
    expect(isRegisterCommand("/registerx Diego")).toBe(false);
  });
  it("rejects `/receive` (a different slash command)", async () => {
    const { isRegisterCommand } = await loadLib();
    expect(isRegisterCommand("/receive DHL")).toBe(false);
  });
});

describe("isStartCommand", () => {
  it("matches `/start` on its own", async () => {
    const { isStartCommand } = await loadLib();
    expect(isStartCommand("/start")).toBe(true);
  });
  it("matches `/start <deeplink-token>`", async () => {
    const { isStartCommand } = await loadLib();
    expect(isStartCommand("/start ref_abc123")).toBe(true);
  });
  it("matches `/start@DropMate_bot`", async () => {
    const { isStartCommand } = await loadLib();
    expect(isStartCommand("/start@DropMate_bot")).toBe(true);
  });
  it("rejects `/startx`", async () => {
    const { isStartCommand } = await loadLib();
    expect(isStartCommand("/startx")).toBe(false);
  });
  it("rejects `/register` (a different slash command)", async () => {
    const { isStartCommand } = await loadLib();
    expect(isStartCommand("/register Diego")).toBe(false);
  });
});

describe("parseRegisterCommand", () => {
  it("returns null for bare `/register` (no args)", async () => {
    const { parseRegisterCommand } = await loadLib();
    expect(parseRegisterCommand("/register")).toBeNull();
  });

  it("parses the canonical live-trace input — name + Lutterothstrasse + house + Erdgeschoss + Links", async () => {
    const { parseRegisterCommand } = await loadLib();
    expect(
      parseRegisterCommand(
        "/register Diego de Miguel Lutterothstrasse 69 Erdgeschoss Links",
      ),
    ).toEqual({
      name: "Diego de Miguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      floor: "Erdgeschoss",
      buzzerName: "Links",
    });
  });

  it("parses the canonical ß variant — Lutterothstraße", async () => {
    const { parseRegisterCommand } = await loadLib();
    const parsed = parseRegisterCommand(
      "/register Diego de Miguel Lutterothstraße 69 Erdgeschoss Links",
    );
    expect(parsed?.street).toBe("Lutterothstraße");
    expect(parsed?.houseNumber).toBe("69");
  });

  it("tolerates a comma between name and address", async () => {
    const { parseRegisterCommand } = await loadLib();
    const parsed = parseRegisterCommand(
      "/register Anna-Sophie Meyer, Methfesselstraße 92",
    );
    expect(parsed?.name).toBe("Anna-Sophie Meyer");
    expect(parsed?.street).toBe("Methfesselstraße");
    expect(parsed?.houseNumber).toBe("92");
  });

  it("parses ordinal floor notation (III. Etage)", async () => {
    const { parseRegisterCommand } = await loadLib();
    const parsed = parseRegisterCommand(
      "/register Anna-Sophie Meyer Methfesselstraße 92 III. Etage",
    );
    expect(parsed?.floor).toMatch(/iii\.?\s*etage/i);
  });

  it("parses '5. OG' (numeric ordinal + OG abbreviation)", async () => {
    const { parseRegisterCommand } = await loadLib();
    const parsed = parseRegisterCommand(
      "/register Marlene Hartmann Methfesselstraße 88 5. OG Hartmann",
    );
    expect(parsed?.floor).toMatch(/5\.?\s*og/i);
    expect(parsed?.buzzerName).toBe("Hartmann");
  });

  it("treats a single-word name as unparseable (needs first + family)", async () => {
    const { parseRegisterCommand } = await loadLib();
    expect(parseRegisterCommand("/register Diego Lutterothstrasse 69")).toBeNull();
  });

  it("treats input missing a street as unparseable", async () => {
    const { parseRegisterCommand } = await loadLib();
    expect(
      parseRegisterCommand("/register Diego de Miguel 69 Erdgeschoss"),
    ).toBeNull();
  });

  it("omits buzzer when only a floor is given", async () => {
    const { parseRegisterCommand } = await loadLib();
    const parsed = parseRegisterCommand(
      "/register Diego de Miguel Lutterothstrasse 69 Erdgeschoss",
    );
    expect(parsed?.floor).toBe("Erdgeschoss");
    expect(parsed?.buzzerName).toBeUndefined();
  });

  it("omits floor and buzzer when neither is given", async () => {
    const { parseRegisterCommand } = await loadLib();
    const parsed = parseRegisterCommand(
      "/register Diego de Miguel Lutterothstrasse 69",
    );
    expect(parsed?.floor).toBeUndefined();
    expect(parsed?.buzzerName).toBeUndefined();
  });
});

describe("parseFreeTextRegistration", () => {
  it("parses `Diego de Miguel, Lutterothstrasse 69 Erdgeschoss Links`", async () => {
    const { parseFreeTextRegistration } = await loadLib();
    expect(
      parseFreeTextRegistration(
        "Diego de Miguel, Lutterothstrasse 69 Erdgeschoss Links",
      ),
    ).toEqual({
      name: "Diego de Miguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      floor: "Erdgeschoss",
      buzzerName: "Links",
    });
  });

  it("returns null when text starts with `/register` (slash variant has its own parser)", async () => {
    const { parseFreeTextRegistration } = await loadLib();
    expect(
      parseFreeTextRegistration(
        "/register Diego de Miguel, Lutterothstrasse 69",
      ),
    ).toBeNull();
  });

  it("returns null for `Patricia (Hs.90)` directory hint (no street suffix)", async () => {
    const { parseFreeTextRegistration } = await loadLib();
    expect(parseFreeTextRegistration("Patricia (Hs.90)")).toBeNull();
  });

  it("returns null for greetings, package questions, off-topic chat", async () => {
    const { parseFreeTextRegistration } = await loadLib();
    expect(parseFreeTextRegistration("Hallo!")).toBeNull();
    expect(parseFreeTextRegistration("Wo ist mein Paket?")).toBeNull();
    expect(
      parseFreeTextRegistration(
        "Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause",
      ),
    ).toBeNull();
  });

  it("returns null for a name + street with no house number", async () => {
    const { parseFreeTextRegistration } = await loadLib();
    expect(
      parseFreeTextRegistration("Diego de Miguel, Lutterothstrasse"),
    ).toBeNull();
  });
});

describe("registerResident", () => {
  beforeEach(() => {
    residentStore.clear();
    vi.restoreAllMocks();
  });

  it("writes a fresh Resident record on first registration", async () => {
    const { registerResident } = await loadLib();
    const { resident, updated } = await registerResident({
      name: "Diego de Miguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      floor: "Erdgeschoss",
      buzzerName: "Links",
      platformId: "12345",
      telegramLanguageCode: "de",
    });
    expect(updated).toBe(false);
    expect(resident.platformId).toBe("12345");
    expect(resident.id).toBe("12345");
    expect(resident.name).toBe("Diego de Miguel");
    expect(resident.street).toBe("Lutterothstrasse");
    expect(resident.houseNumber).toBe("69");
    expect(resident.floor).toBe("Erdgeschoss");
    expect(resident.buzzerName).toBe("Links");
    expect(resident.language).toBe("de");
    expect(resident.source).toBe("explicit");
    expect(resident.confirmed).toBe(true);
    expect(residentStore.get("12345")).toBeDefined();
  });

  it("preserves id / registeredAt / language / availabilityPatterns on re-registration", async () => {
    residentStore.set("12345", {
      id: "12345",
      name: "Old Name",
      street: "Old Street",
      houseNumber: "1",
      platformId: "12345",
      platform: "telegram",
      language: "tr",
      availabilityPatterns: ["mornings"],
      registeredAt: 1700000000000,
      source: "learned",
      confirmed: false,
    });
    const { registerResident } = await loadLib();
    const { resident, updated } = await registerResident({
      name: "Diego de Miguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      floor: "Erdgeschoss",
      platformId: "12345",
      telegramLanguageCode: "de", // ignored — existing.language wins
    });
    expect(updated).toBe(true);
    expect(resident.id).toBe("12345");
    expect(resident.registeredAt).toBe(1700000000000);
    expect(resident.language).toBe("tr"); // preserved
    expect(resident.availabilityPatterns).toEqual(["mornings"]);
    expect(resident.name).toBe("Diego de Miguel"); // updated
    expect(resident.street).toBe("Lutterothstrasse"); // updated
    expect(resident.source).toBe("explicit"); // re-registration always upgrades
    expect(resident.confirmed).toBe(true);
  });

  it("normalises a BCP-47 language code (de-AT → de)", async () => {
    const { registerResident } = await loadLib();
    const { resident } = await registerResident({
      name: "Diego de Miguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      platformId: "12345",
      telegramLanguageCode: "de-AT",
    });
    expect(resident.language).toBe("de");
  });

  it("leaves language undefined when no telegramLanguageCode and no existing record", async () => {
    const { registerResident } = await loadLib();
    const { resident } = await registerResident({
      name: "Diego de Miguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      platformId: "12345",
    });
    expect(resident.language).toBeUndefined();
  });
});

describe("buildRegistrationConfirmationDm", () => {
  const baseResident: Resident = {
    id: "12345",
    name: "Diego de Miguel",
    street: "Lutterothstrasse",
    houseNumber: "69",
    floor: "Erdgeschoss Links",
    platformId: "12345",
    platform: "telegram",
    language: "de",
    availabilityPatterns: [],
    registeredAt: 0,
    source: "explicit",
    confirmed: true,
  };

  it("renders the canonical German confirmation", async () => {
    const { buildRegistrationConfirmationDm } = await loadLib();
    expect(buildRegistrationConfirmationDm({ resident: baseResident })).toBe(
      "Vielen Dank, Diego de Miguel! Du bist jetzt unter Lutterothstrasse 69, Erdgeschoss Links registriert.",
    );
  });

  it("renders English when resident.language is 'en'", async () => {
    const { buildRegistrationConfirmationDm } = await loadLib();
    expect(
      buildRegistrationConfirmationDm({
        resident: { ...baseResident, language: "en" },
      }),
    ).toBe(
      "Thanks, Diego de Miguel! You're registered at Lutterothstrasse 69, Erdgeschoss Links.",
    );
  });

  it("renders Spanish when resident.language is 'es'", async () => {
    const { buildRegistrationConfirmationDm } = await loadLib();
    expect(
      buildRegistrationConfirmationDm({
        resident: { ...baseResident, language: "es", floor: undefined },
      }),
    ).toBe("Gracias, Diego de Miguel! Estás registrado en Lutterothstrasse 69.");
  });

  it("renders Turkish when resident.language is 'tr'", async () => {
    const { buildRegistrationConfirmationDm } = await loadLib();
    expect(
      buildRegistrationConfirmationDm({
        resident: { ...baseResident, language: "tr", floor: undefined },
      }),
    ).toBe(
      "Teşekkürler, Diego de Miguel! Lutterothstrasse 69 adresine kaydedildin.",
    );
  });

  it("falls back to the telegram languageCode when resident.language is unset", async () => {
    const { buildRegistrationConfirmationDm } = await loadLib();
    expect(
      buildRegistrationConfirmationDm({
        resident: { ...baseResident, language: undefined, floor: undefined },
        fallbackLanguageCode: "en",
      }),
    ).toBe("Thanks, Diego de Miguel! You're registered at Lutterothstrasse 69.");
  });

  it("falls back to German when neither resident.language nor fallback is set", async () => {
    const { buildRegistrationConfirmationDm } = await loadLib();
    expect(
      buildRegistrationConfirmationDm({
        resident: { ...baseResident, language: undefined, floor: undefined },
      }),
    ).toBe(
      "Vielen Dank, Diego de Miguel! Du bist jetzt unter Lutterothstrasse 69 registriert.",
    );
  });

  it("omits the floor clause when resident.floor is undefined", async () => {
    const { buildRegistrationConfirmationDm } = await loadLib();
    const out = buildRegistrationConfirmationDm({
      resident: { ...baseResident, floor: undefined },
    });
    expect(out).not.toContain(", ,");
    expect(out).toBe(
      "Vielen Dank, Diego de Miguel! Du bist jetzt unter Lutterothstrasse 69 registriert.",
    );
  });
});
