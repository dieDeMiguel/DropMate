import { describe, expect, it } from "vitest";

import { normaliseLanguageCode } from "./language.js";

describe("normaliseLanguageCode", () => {
  it("lower-cases plain two-letter codes", () => {
    expect(normaliseLanguageCode("DE")).toBe("de");
    expect(normaliseLanguageCode("en")).toBe("en");
  });

  it("strips region suffixes per BCP 47", () => {
    expect(normaliseLanguageCode("de-AT")).toBe("de");
    expect(normaliseLanguageCode("en-US")).toBe("en");
    expect(normaliseLanguageCode("pt-BR")).toBe("pt");
  });

  it("returns null for junk", () => {
    expect(normaliseLanguageCode("")).toBeNull();
    expect(normaliseLanguageCode("  ")).toBeNull();
    expect(normaliseLanguageCode("123")).toBeNull();
    expect(normaliseLanguageCode(null)).toBeNull();
    expect(normaliseLanguageCode(undefined)).toBeNull();
  });

  it("unwraps single-element string arrays (matches Telegram's languageCode shape)", () => {
    expect(normaliseLanguageCode(["tr"])).toBe("tr");
  });
});
