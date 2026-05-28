import { describe, expect, it } from "vitest";

import { repairFencedJson, repairJsonText } from "./structured-output.js";

describe("repairJsonText", () => {
  it("passes plain JSON through unchanged", () => {
    const input = '{"kind":"shipping_label","confidence":"high"}';
    expect(repairJsonText(input)).toBe(input);
  });

  it("strips a ```json … ``` fence", () => {
    const fenced = '```json\n{"kind":"shipping_label"}\n```';
    expect(repairJsonText(fenced)).toBe('{"kind":"shipping_label"}');
  });

  it("strips a ``` … ``` fence without language tag", () => {
    const fenced = '```\n{"kind":"tracking_page"}\n```';
    expect(repairJsonText(fenced)).toBe('{"kind":"tracking_page"}');
  });

  it("slices off lead-in prose before the first {", () => {
    const input =
      'Here is the JSON you requested:\n{"kind":"unknown","confidence":"low"}';
    expect(repairJsonText(input)).toBe(
      '{"kind":"unknown","confidence":"low"}',
    );
  });

  it("slices off trailing prose after the last }", () => {
    const input =
      '{"kind":"unknown","confidence":"low"}\nHope that helps!';
    expect(repairJsonText(input)).toBe(
      '{"kind":"unknown","confidence":"low"}',
    );
  });

  it("handles fence + lead-in + trailing prose combined", () => {
    const input = [
      "Sure! Here's the classification:",
      "```json",
      '{"kind":"shipping_label","confidence":"medium"}',
      "```",
      "Let me know if you need more.",
    ].join("\n");
    expect(repairJsonText(input)).toBe(
      '{"kind":"shipping_label","confidence":"medium"}',
    );
  });

  it("preserves nested braces inside the payload", () => {
    const input = '```json\n{"a":1,"nested":{"b":2}}\n```';
    expect(repairJsonText(input)).toBe('{"a":1,"nested":{"b":2}}');
  });

  it("trims surrounding whitespace", () => {
    expect(repairJsonText('   \n{"a":1}\n  ')).toBe('{"a":1}');
  });
});

describe("repairFencedJson (AI SDK adapter)", () => {
  it("returns the stripped string for a fenced payload", async () => {
    const result = await repairFencedJson({
      text: '```json\n{"k":"v"}\n```',
    });
    expect(result).toBe('{"k":"v"}');
  });
});
