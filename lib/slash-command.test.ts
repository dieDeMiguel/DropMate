import { describe, expect, it } from "vitest";

import {
  isReceiveCommand,
  parseReceiveCommand,
} from "./slash-command.js";

// Fixed anchor: 2026-05-21 12:00 Berlin (summer time, UTC+2) — same
// shape as the slice-1 process-update test fixtures. Berlin TZ is in
// CEST on this date, so 14:00 Berlin = 12:00 UTC.
const NOW_2026_05_21 = Date.UTC(2026, 4, 21, 10, 0, 0);

// Pre-computed window endpoints for "morgen 14-16" on the anchor above:
//   morgen = 2026-05-22 (Berlin)
//   14:00 Berlin (CEST, UTC+2) = 2026-05-22 12:00 UTC = 1779451200000
//   16:00 Berlin (CEST, UTC+2) = 2026-05-22 14:00 UTC = 1779458400000
const TOMORROW_14_BERLIN_MS = 1779451200000;
const TOMORROW_16_BERLIN_MS = 1779458400000;

// Anchor across the DST boundary — last Sunday of March 2026 is the
// 29th, so 2026-03-28 → 2026-03-29 is the spring-forward day. "morgen
// 14-16" on the 28th should still come out to clean 14:00–16:00 in
// Berlin local time even though Berlin shifts from CET (+1) to CEST
// (+2) at 02:00 that day. We don't assert the exact ms numbers (those
// depend on the tzdb version of the test runner), only that:
//   1. window endpoints are 2h apart (no DST gap leaked through),
//   2. when formatted in Berlin they read 14:00 and 16:00.
const NOW_2026_03_28 = Date.UTC(2026, 2, 28, 10, 0, 0);

describe("isReceiveCommand", () => {
  it("matches /receive on its own", () => {
    expect(isReceiveCommand("/receive")).toBe(true);
  });
  it("matches /receive with args", () => {
    expect(isReceiveCommand("/receive DHL morgen 14-16")).toBe(true);
  });
  it("matches /receive with a bot @-mention", () => {
    expect(isReceiveCommand("/receive@DropMate_bot DHL")).toBe(true);
  });
  it("tolerates leading whitespace", () => {
    expect(isReceiveCommand("  /receive DHL")).toBe(true);
  });
  it("rejects /receivex (no word boundary)", () => {
    expect(isReceiveCommand("/receivex DHL")).toBe(false);
  });
  it("rejects free-text mentioning /receive in the middle", () => {
    expect(isReceiveCommand("hey /receive")).toBe(false);
  });
  it("rejects empty string", () => {
    expect(isReceiveCommand("")).toBe(false);
  });
  it("rejects another slash command", () => {
    expect(isReceiveCommand("/register Anna 92")).toBe(false);
  });
});

describe("parseReceiveCommand", () => {
  describe("bare", () => {
    it("returns {} for `/receive` alone", () => {
      expect(parseReceiveCommand("/receive", NOW_2026_05_21)).toEqual({});
    });
    it("returns {} for `/receive ` with trailing whitespace", () => {
      expect(parseReceiveCommand("/receive   ", NOW_2026_05_21)).toEqual({});
    });
    it("returns {} for /receive with a bot mention but no args", () => {
      expect(
        parseReceiveCommand("/receive@DropMate_bot", NOW_2026_05_21),
      ).toEqual({});
    });
  });

  describe("carrier extraction", () => {
    it("recognises DHL (uppercase)", () => {
      const out = parseReceiveCommand("/receive DHL", NOW_2026_05_21);
      expect(out.carrier).toBe("DHL");
      expect(out.expectedDate).toBeUndefined();
      expect(out.expectedWindowStartAt).toBeUndefined();
    });
    it("recognises hermes (lowercase)", () => {
      expect(parseReceiveCommand("/receive hermes", NOW_2026_05_21).carrier).toBe(
        "Hermes",
      );
    });
    it("recognises DPD/GLS/UPS/Amazon canonicalisation", () => {
      expect(parseReceiveCommand("/receive dpd", NOW_2026_05_21).carrier).toBe(
        "DPD",
      );
      expect(parseReceiveCommand("/receive Gls", NOW_2026_05_21).carrier).toBe(
        "GLS",
      );
      expect(parseReceiveCommand("/receive ups", NOW_2026_05_21).carrier).toBe(
        "UPS",
      );
      expect(parseReceiveCommand("/receive AMAZON", NOW_2026_05_21).carrier).toBe(
        "Amazon",
      );
    });
    it("does NOT match FedEx (not in PackageCarrier schema)", () => {
      // The issue's example regex mentions FedEx, but the PackageCarrier
      // enum doesn't include it. Better to leave carrier unset than
      // smuggle in a value the schema rejects.
      expect(
        parseReceiveCommand("/receive FedEx", NOW_2026_05_21).carrier,
      ).toBeUndefined();
    });
    it("recognises carrier embedded in mixed input", () => {
      const out = parseReceiveCommand(
        "/receive ich erwarte Hermes morgen",
        NOW_2026_05_21,
      );
      expect(out.carrier).toBe("Hermes");
      expect(out.expectedDate).toBe("2026-05-22");
    });
  });

  describe("date-word extraction", () => {
    it("heute → today (offset 0)", () => {
      expect(parseReceiveCommand("/receive heute", NOW_2026_05_21).expectedDate).toBe(
        "2026-05-21",
      );
    });
    it("morgen → tomorrow (offset 1)", () => {
      expect(parseReceiveCommand("/receive morgen", NOW_2026_05_21).expectedDate).toBe(
        "2026-05-22",
      );
    });
    it("übermorgen → +2 days", () => {
      expect(
        parseReceiveCommand("/receive übermorgen", NOW_2026_05_21).expectedDate,
      ).toBe("2026-05-23");
    });
    it("today (English alias) → offset 0", () => {
      expect(parseReceiveCommand("/receive today", NOW_2026_05_21).expectedDate).toBe(
        "2026-05-21",
      );
    });
    it("tomorrow (English alias) → offset 1", () => {
      expect(parseReceiveCommand("/receive tomorrow", NOW_2026_05_21).expectedDate).toBe(
        "2026-05-22",
      );
    });
    it("unrecognised date word leaves expectedDate unset", () => {
      expect(
        parseReceiveCommand("/receive nächste Woche", NOW_2026_05_21).expectedDate,
      ).toBeUndefined();
    });
  });

  describe("window extraction", () => {
    it("`/receive DHL morgen 14-16` → carrier + date + window", () => {
      const out = parseReceiveCommand(
        "/receive DHL morgen 14-16",
        NOW_2026_05_21,
      );
      expect(out).toEqual({
        carrier: "DHL",
        expectedDate: "2026-05-22",
        expectedWindowStartAt: TOMORROW_14_BERLIN_MS,
        expectedWindowEndAt: TOMORROW_16_BERLIN_MS,
      });
    });
    it("accepts the en-dash separator (14–16)", () => {
      const out = parseReceiveCommand(
        "/receive DHL morgen 14–16",
        NOW_2026_05_21,
      );
      expect(out.expectedWindowStartAt).toBe(TOMORROW_14_BERLIN_MS);
      expect(out.expectedWindowEndAt).toBe(TOMORROW_16_BERLIN_MS);
    });
    it("accepts the trailing `Uhr` suffix", () => {
      const out = parseReceiveCommand(
        "/receive DHL morgen 14-16 Uhr",
        NOW_2026_05_21,
      );
      expect(out.expectedWindowStartAt).toBe(TOMORROW_14_BERLIN_MS);
      expect(out.expectedWindowEndAt).toBe(TOMORROW_16_BERLIN_MS);
    });
    it("accepts the trailing `h` suffix", () => {
      const out = parseReceiveCommand(
        "/receive DHL morgen 9-11h",
        NOW_2026_05_21,
      );
      expect(out.expectedWindowStartAt).toBeDefined();
      expect(out.expectedWindowEndAt).toBeDefined();
      // 9:00 → 11:00 Berlin = 2h apart
      expect(
        out.expectedWindowEndAt! - out.expectedWindowStartAt!,
      ).toBe(2 * 60 * 60 * 1000);
    });
    it("window without a date word anchors to today", () => {
      const out = parseReceiveCommand("/receive 14-16", NOW_2026_05_21);
      expect(out.expectedDate).toBe("2026-05-21");
      expect(out.expectedWindowStartAt).toBeDefined();
      expect(out.expectedWindowEndAt).toBeDefined();
    });
    it("rejects an invalid window (end <= start) — leaves window unset", () => {
      const out = parseReceiveCommand(
        "/receive DHL morgen 16-14",
        NOW_2026_05_21,
      );
      expect(out.carrier).toBe("DHL");
      expect(out.expectedDate).toBe("2026-05-22");
      expect(out.expectedWindowStartAt).toBeUndefined();
      expect(out.expectedWindowEndAt).toBeUndefined();
    });
    it("rejects out-of-range hours (>23)", () => {
      const out = parseReceiveCommand(
        "/receive 25-26",
        NOW_2026_05_21,
      );
      expect(out.expectedWindowStartAt).toBeUndefined();
    });
    it("accepts a one-digit hour ('9-11')", () => {
      const out = parseReceiveCommand("/receive 9-11", NOW_2026_05_21);
      expect(out.expectedWindowStartAt).toBeDefined();
      expect(out.expectedWindowEndAt).toBeDefined();
    });
  });

  describe("DST robustness", () => {
    it("window crossing the spring-forward day reads 14:00-16:00 Berlin", () => {
      const out = parseReceiveCommand(
        "/receive DHL morgen 14-16",
        NOW_2026_03_28,
      );
      expect(out.expectedDate).toBe("2026-03-29");
      expect(out.expectedWindowStartAt).toBeDefined();
      expect(out.expectedWindowEndAt).toBeDefined();
      // Exactly 2h apart — no DST gap leaked through.
      expect(
        out.expectedWindowEndAt! - out.expectedWindowStartAt!,
      ).toBe(2 * 60 * 60 * 1000);
      // And when formatted in Berlin, they read 14:00 and 16:00.
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      expect(fmt.format(new Date(out.expectedWindowStartAt!))).toBe("14:00");
      expect(fmt.format(new Date(out.expectedWindowEndAt!))).toBe("16:00");
    });
  });
});
