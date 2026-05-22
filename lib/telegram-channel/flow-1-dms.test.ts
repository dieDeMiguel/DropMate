import { describe, expect, it } from "vitest";

import {
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
});
