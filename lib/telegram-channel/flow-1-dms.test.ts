import { describe, expect, it } from "vitest";

import {
  buildDmTextPickupAlreadyDoneText,
  buildDmTextPickupConfirmedText,
  buildDmTextPickupMultiplePackagesText,
  buildDmTextPickupNoOpenPackagesText,
  buildDmTextPickupRetryText,
  buildGroupAckText,
  buildHolderNotRegisteredNudge,
  buildPickupKeyboard,
  buildRecipientDmText,
} from "./flow-1-dms.js";
import type { HolderSummary, ResidentRecipientSummary } from "../package.js";

const holder: HolderSummary = {
  id: "100",
  name: "Diego Demiguel",
  houseNumber: "69",
  floor: "Erdgeschoss",
  buzzerName: "Wohngemeinschaft",
  language: "de",
};

const recipient: ResidentRecipientSummary = {
  id: "200",
  name: "Marlene Hartmann",
  houseNumber: "88",
  language: "de",
  floor: "V.",
  buzzerName: "Hartmann",
};

describe("flow-1-dms", () => {
  describe("buildGroupAckText", () => {
    it("names both parties and their house numbers, no buzzer/floor leak", () => {
      const text = buildGroupAckText({ holder, recipient });
      expect(text).toBe(
        "📦 Paket von Diego Demiguel (69) an Marlene Hartmann (88).",
      );
      // PRD §9 privacy: holder's buzzer + floor must never appear in the
      // group ack.
      expect(text).not.toContain("Erdgeschoss");
      expect(text).not.toContain("Wohngemeinschaft");
    });
  });

  describe("buildRecipientDmText", () => {
    it("renders floor + buzzer in the recipient DM when present", () => {
      const text = buildRecipientDmText({ holder, recipient });
      expect(text).toContain("Hi Marlene Hartmann!");
      expect(text).toContain("Diego Demiguel hat ein Paket für dich angenommen.");
      expect(text).toContain("📍 69, Stock Erdgeschoss — Klingel Wohngemeinschaft");
      expect(text).toContain("[Abgeholt]");
    });

    it("omits the floor clause when holder.floor is null", () => {
      const text = buildRecipientDmText({
        holder: { ...holder, floor: null },
        recipient,
      });
      expect(text).toContain("📍 69 — Klingel Wohngemeinschaft");
      expect(text).not.toContain("Stock");
    });

    it("omits the buzzer clause when holder.buzzerName is null", () => {
      const text = buildRecipientDmText({
        holder: { ...holder, buzzerName: null },
        recipient,
      });
      expect(text).toContain("📍 69, Stock Erdgeschoss");
      expect(text).not.toContain("Klingel");
    });

    it("renders bare house number when both floor + buzzer are null", () => {
      const text = buildRecipientDmText({
        holder: { ...holder, floor: null, buzzerName: null },
        recipient,
      });
      expect(text).toContain("📍 69\n");
    });
  });

  describe("buildPickupKeyboard", () => {
    it("renders one row with one Abgeholt button carrying the package id in callback_data", () => {
      const keyboard = buildPickupKeyboard("pkg_42");
      expect(keyboard.inline_keyboard).toHaveLength(1);
      expect(keyboard.inline_keyboard[0]).toHaveLength(1);
      const button = keyboard.inline_keyboard[0]![0]!;
      expect(button.text).toBe("Abgeholt");
      expect(button.callback_data).toBe("confirm_pickup:pkg_42");
    });

    it("respects Telegram's 64-byte callback_data limit for plausible package ids", () => {
      const keyboard = buildPickupKeyboard("pkg_lZ4xK3_aBc123");
      const button = keyboard.inline_keyboard[0]![0]!;
      expect(button.callback_data.length).toBeLessThanOrEqual(64);
    });
  });

  describe("buildHolderNotRegisteredNudge", () => {
    it("returns the German nudge by default", () => {
      expect(buildHolderNotRegisteredNudge(null)).toBe(
        "Um Pakete für andere zu registrieren, registriere dich zuerst mit /register.",
      );
    });

    it("returns the English nudge for 'en'", () => {
      expect(buildHolderNotRegisteredNudge("en")).toBe(
        "To register packages for neighbours, please /register first.",
      );
    });

    it("falls back to German for unsupported languages", () => {
      expect(buildHolderNotRegisteredNudge("ja")).toBe(
        "Um Pakete für andere zu registrieren, registriere dich zuerst mit /register.",
      );
    });
  });

  // v2.1 #110: DM-text pickup-confirmation fallback templates.
  describe("buildDmTextPickupNoOpenPackagesText", () => {
    it("returns German by default", () => {
      expect(buildDmTextPickupNoOpenPackagesText(null)).toBe(
        "Du hast aktuell kein offenes Paket bei mir.",
      );
    });
    it("returns English for 'en'", () => {
      expect(buildDmTextPickupNoOpenPackagesText("en")).toBe(
        "You don't have any open packages with me right now.",
      );
    });
    it("returns Spanish for 'es'", () => {
      expect(buildDmTextPickupNoOpenPackagesText("es")).toBe(
        "Ahora mismo no tienes ningún paquete pendiente conmigo.",
      );
    });
    it("returns Turkish for 'tr'", () => {
      expect(buildDmTextPickupNoOpenPackagesText("tr")).toBe(
        "Şu anda bende açık bir paketin yok.",
      );
    });
    it("falls back to German for unsupported languages", () => {
      expect(buildDmTextPickupNoOpenPackagesText("ja")).toBe(
        "Du hast aktuell kein offenes Paket bei mir.",
      );
    });
  });

  describe("buildDmTextPickupMultiplePackagesText", () => {
    it("renders the German disambiguation prompt pointing to the group button", () => {
      const text = buildDmTextPickupMultiplePackagesText("de");
      expect(text).toBe(
        "Welches Paket meinst du? Bitte tippe in der Gruppe auf [Abgeholt] beim richtigen Paket.",
      );
      // Regression pin: the prompt must mention [Abgeholt] verbatim so
      // the writer can pattern-match it on the group surface.
      expect(text).toContain("[Abgeholt]");
    });
    it("renders English for 'en' with [Picked up]", () => {
      expect(buildDmTextPickupMultiplePackagesText("en")).toContain(
        "[Picked up]",
      );
    });
    it("renders Spanish for 'es' with [Recogido]", () => {
      expect(buildDmTextPickupMultiplePackagesText("es")).toContain(
        "[Recogido]",
      );
    });
    it("renders Turkish for 'tr' with [Alındı]", () => {
      expect(buildDmTextPickupMultiplePackagesText("tr")).toContain(
        "[Alındı]",
      );
    });
  });

  describe("buildDmTextPickupConfirmedText", () => {
    it("returns the German confirmation by default", () => {
      expect(buildDmTextPickupConfirmedText(null)).toBe("Hab notiert — danke!");
    });
    it("returns English for 'en'", () => {
      expect(buildDmTextPickupConfirmedText("en")).toBe("Got it — thanks!");
    });
    it("returns Spanish for 'es'", () => {
      expect(buildDmTextPickupConfirmedText("es")).toBe("Anotado — ¡gracias!");
    });
    it("returns Turkish for 'tr'", () => {
      expect(buildDmTextPickupConfirmedText("tr")).toBe(
        "Not aldım — teşekkürler!",
      );
    });
  });

  describe("buildDmTextPickupAlreadyDoneText", () => {
    it("matches the toast text from pickup-dms.ts (same UX promise across surfaces)", () => {
      // The toast on the button-tap path and the DM on the text path
      // should say the same thing in the same language — otherwise the
      // user gets confused about whether something different happened.
      expect(buildDmTextPickupAlreadyDoneText("de")).toBe(
        "Dieses Paket wurde schon abgeholt.",
      );
      expect(buildDmTextPickupAlreadyDoneText("en")).toBe(
        "This package has already been picked up.",
      );
    });
  });

  describe("buildDmTextPickupRetryText", () => {
    it("returns a German retry prompt by default", () => {
      expect(buildDmTextPickupRetryText(null)).toBe(
        "Etwas ist schiefgelaufen. Bitte gleich nochmal versuchen.",
      );
    });
    it("returns English for 'en'", () => {
      expect(buildDmTextPickupRetryText("en")).toBe(
        "Something went wrong. Please try again in a moment.",
      );
    });
  });
});
