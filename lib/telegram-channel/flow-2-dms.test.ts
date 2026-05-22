import { describe, expect, it } from "vitest";

import {
  buildFlow2AckDm,
  buildFlow2VisionLowConfidenceDm,
} from "./flow-2-dms.js";

describe("buildFlow2AckDm (#100)", () => {
  it("renders the German ack for 'de'", () => {
    expect(buildFlow2AckDm("de")).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });

  it("renders the English ack for 'en'", () => {
    expect(buildFlow2AckDm("en")).toBe(
      "Asked in the group — I'll let you know as soon as someone says yes.",
    );
  });

  it("renders the Spanish ack for 'es'", () => {
    expect(buildFlow2AckDm("es")).toBe(
      "Pregunté en el grupo — te aviso en cuanto alguien responda.",
    );
  });

  it("renders the Turkish ack for 'tr'", () => {
    expect(buildFlow2AckDm("tr")).toBe(
      "Gruba sordum — biri yanıt verince haber veririm.",
    );
  });

  it("normalises BCP-47 'de-AT' to 'de'", () => {
    expect(buildFlow2AckDm("de-AT")).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });

  it("normalises BCP-47 'EN-us' to 'en' (case-insensitive)", () => {
    expect(buildFlow2AckDm("EN-us")).toBe(
      "Asked in the group — I'll let you know as soon as someone says yes.",
    );
  });

  it("falls back to German on unknown language code", () => {
    expect(buildFlow2AckDm("zh")).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });

  it("falls back to German on null input", () => {
    expect(buildFlow2AckDm(null)).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });

  it("falls back to German on undefined input", () => {
    expect(buildFlow2AckDm(undefined)).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });

  it("falls back to German on empty string", () => {
    expect(buildFlow2AckDm("")).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });
});

describe("buildFlow2VisionLowConfidenceDm (#100)", () => {
  it("renders the German recovery prompt for 'de'", () => {
    const dm = buildFlow2VisionLowConfidenceDm("de");
    expect(dm).toContain("Ich konnte den Beleg nicht eindeutig lesen");
    expect(dm).toContain("/receive");
    expect(dm).toContain("/register");
  });

  it("renders the English recovery prompt for 'en'", () => {
    const dm = buildFlow2VisionLowConfidenceDm("en");
    expect(dm).toContain("couldn't read the receipt confidently");
    expect(dm).toContain("/receive");
    expect(dm).toContain("/register");
  });

  it("renders the Spanish recovery prompt for 'es'", () => {
    const dm = buildFlow2VisionLowConfidenceDm("es");
    expect(dm).toContain("No pude leer el recibo");
    expect(dm).toContain("/receive");
    expect(dm).toContain("/register");
  });

  it("renders the Turkish recovery prompt for 'tr'", () => {
    const dm = buildFlow2VisionLowConfidenceDm("tr");
    expect(dm).toContain("Belgeyi net okuyamadım");
    expect(dm).toContain("/receive");
    expect(dm).toContain("/register");
  });

  it("normalises BCP-47 'es-MX' to 'es'", () => {
    const dm = buildFlow2VisionLowConfidenceDm("es-MX");
    expect(dm).toContain("No pude leer el recibo");
  });

  it("falls back to German on unknown language code", () => {
    const dm = buildFlow2VisionLowConfidenceDm("ja");
    expect(dm).toContain("Ich konnte den Beleg nicht eindeutig lesen");
  });

  it("falls back to German on null input", () => {
    const dm = buildFlow2VisionLowConfidenceDm(null);
    expect(dm).toContain("Ich konnte den Beleg nicht eindeutig lesen");
  });

  it("falls back to German on undefined input", () => {
    const dm = buildFlow2VisionLowConfidenceDm(undefined);
    expect(dm).toContain("Ich konnte den Beleg nicht eindeutig lesen");
  });
});
