import { describe, expect, it } from "vitest";

import {
  buildHolderThanksDmText,
  pickupAlreadyDoneToast,
  pickupNotRecipientToast,
  pickupRetryToast,
} from "./pickup-dms.js";
import type {
  PickupHolderSummary,
  PickupRecipientSummary,
} from "../pickup.js";

const holder: PickupHolderSummary = {
  id: "100",
  platformId: "100",
  name: "Diego de Miguel",
  houseNumber: "69",
  language: "de",
};

const recipient: PickupRecipientSummary = {
  id: "200",
  name: "Marlene Hartmann",
  houseNumber: "88",
  language: "de",
};

describe("pickup-dms (v2.1 #108)", () => {
  describe("buildHolderThanksDmText", () => {
    it("renders the German thanks DM by default", () => {
      const text = buildHolderThanksDmText({ holder, recipient });
      expect(text).toBe(
        "Marlene Hartmann hat das Paket abgeholt – danke fürs Annehmen!",
      );
    });

    it("renders the English variant when holder language is en", () => {
      const text = buildHolderThanksDmText({
        holder: { ...holder, language: "en" },
        recipient,
      });
      expect(text).toBe(
        "Marlene Hartmann has picked up the package — thanks for taking it in!",
      );
    });

    it("renders the Spanish variant when holder language is es", () => {
      const text = buildHolderThanksDmText({
        holder: { ...holder, language: "es" },
        recipient,
      });
      expect(text).toContain("Marlene Hartmann");
      expect(text).toContain("recogido");
    });

    it("renders the Turkish variant when holder language is tr", () => {
      const text = buildHolderThanksDmText({
        holder: { ...holder, language: "tr" },
        recipient,
      });
      expect(text).toContain("Marlene Hartmann");
      expect(text).toContain("teşekkürler");
    });

    it("falls back to German when holder language is unknown / null", () => {
      const text = buildHolderThanksDmText({
        holder: { ...holder, language: null },
        recipient,
      });
      expect(text).toBe(
        "Marlene Hartmann hat das Paket abgeholt – danke fürs Annehmen!",
      );
    });
  });

  describe("pickupNotRecipientToast", () => {
    it("returns localised toast for each supported language", () => {
      expect(pickupNotRecipientToast("de")).toBe(
        "Du bist nicht der Empfänger dieses Pakets.",
      );
      expect(pickupNotRecipientToast("en")).toBe(
        "You are not the recipient of this package.",
      );
      expect(pickupNotRecipientToast("es")).toBe(
        "No eres el destinatario de este paquete.",
      );
      expect(pickupNotRecipientToast("tr")).toBe(
        "Bu paketin alıcısı sen değilsin.",
      );
    });

    it("falls back to German for unknown / null languages", () => {
      expect(pickupNotRecipientToast(null)).toBe(
        "Du bist nicht der Empfänger dieses Pakets.",
      );
      expect(pickupNotRecipientToast("ja")).toBe(
        "Du bist nicht der Empfänger dieses Pakets.",
      );
    });
  });

  describe("pickupAlreadyDoneToast", () => {
    it("returns localised toast for each supported language", () => {
      expect(pickupAlreadyDoneToast("de")).toBe(
        "Dieses Paket wurde schon abgeholt.",
      );
      expect(pickupAlreadyDoneToast("en")).toBe(
        "This package has already been picked up.",
      );
      expect(pickupAlreadyDoneToast("es")).toBe(
        "Este paquete ya ha sido recogido.",
      );
      expect(pickupAlreadyDoneToast("tr")).toBe(
        "Bu paket zaten alınmış.",
      );
    });

    it("falls back to German for unknown languages", () => {
      expect(pickupAlreadyDoneToast(undefined)).toBe(
        "Dieses Paket wurde schon abgeholt.",
      );
    });
  });

  describe("pickupRetryToast", () => {
    it("returns localised generic retry toast", () => {
      expect(pickupRetryToast("de")).toBe(
        "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
      );
      expect(pickupRetryToast("en")).toBe(
        "Something went wrong. Please try again.",
      );
      expect(pickupRetryToast("es")).toBe(
        "Algo salió mal. Por favor inténtalo de nuevo.",
      );
      expect(pickupRetryToast("tr")).toBe(
        "Bir şeyler ters gitti. Lütfen tekrar deneyin.",
      );
      expect(pickupRetryToast(null)).toBe(
        "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
      );
    });
  });
});
