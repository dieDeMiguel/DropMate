import { describe, expect, it } from "vitest";

import { buildFlow2AckDm, buildVlc3PathDm } from "./flow-2-dms.js";

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

describe("buildVlc3PathDm (#128 — 3-path recovery for unknown DM photo)", () => {
  it("renders the German 3-path recovery for 'de' (Etikett resend + text + /receive)", () => {
    const dm = buildVlc3PathDm("de");
    expect(dm).toMatch(/Etikett/i);
    // German copy uses "Schicke mir" (send to me) — implies DM since the
    // user is already in DM with the bot; spelling out "DM" is redundant
    // in German context.
    expect(dm).toMatch(/Schicke/i);
    expect(dm).toContain("/receive");
    expect(dm).toContain("/register");
  });

  it("renders the English 3-path recovery for 'en'", () => {
    const dm = buildVlc3PathDm("en");
    expect(dm).toMatch(/label/i);
    expect(dm).toMatch(/text/i);
    expect(dm).toContain("/receive");
    expect(dm).toContain("/register");
  });

  it("renders the Spanish 3-path recovery for 'es'", () => {
    const dm = buildVlc3PathDm("es");
    expect(dm).toMatch(/etiqueta/i);
    expect(dm).toContain("/receive");
    expect(dm).toContain("/register");
  });

  it("renders the Turkish 3-path recovery for 'tr'", () => {
    const dm = buildVlc3PathDm("tr");
    expect(dm).toMatch(/etiket/i);
    expect(dm).toContain("/receive");
    expect(dm).toContain("/register");
  });

  it("normalises BCP-47 'es-MX' to 'es'", () => {
    const dm = buildVlc3PathDm("es-MX");
    expect(dm).toMatch(/etiqueta/i);
  });

  it("falls back to German on unknown language code", () => {
    const dm = buildVlc3PathDm("ja");
    expect(dm).toMatch(/Etikett/i);
  });

  it("falls back to German on null input", () => {
    const dm = buildVlc3PathDm(null);
    expect(dm).toMatch(/Etikett/i);
  });

  it("falls back to German on undefined input", () => {
    const dm = buildVlc3PathDm(undefined);
    expect(dm).toMatch(/Etikett/i);
  });

  it("lists all three paths in every supported language", () => {
    // Regression pin: the 3-path copy must mention three distinct
    // next-steps (resend label / type text / /receive) so the user
    // has the full recovery menu, not just one option.
    for (const language of ["de", "en", "es", "tr"]) {
      const dm = buildVlc3PathDm(language);
      // Three bullet points / line breaks. The exact bullet glyph
      // varies by language but `\n• ` (or `\n- `) is enforced.
      const bulletCount = (dm.match(/\n[•\-]/g) ?? []).length;
      expect(
        bulletCount,
        `language=${language} must list 3 paths via bullets`,
      ).toBeGreaterThanOrEqual(3);
      expect(dm).toContain("/receive");
    }
  });
});
