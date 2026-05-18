import { describe, expect, it } from "vitest";

import {
  berlinCalendarOffsetDays,
  berlinDayKey,
  formatBerlinDate,
  formatBerlinRelativeDay,
  formatBerlinTime,
  formatBerlinWindow,
} from "./datetime.js";

// All test reference times are explicit UTC instants so the assertions
// don't depend on the host's local timezone.

describe("formatBerlinTime", () => {
  it("renders Europe/Berlin time during summer (CEST = UTC+2)", () => {
    // 2026-05-19T12:00:00Z → 14:00 in Berlin during CEST
    expect(formatBerlinTime(Date.UTC(2026, 4, 19, 12, 0))).toBe("14:00");
  });

  it("renders Europe/Berlin time during winter (CET = UTC+1)", () => {
    // 2026-12-19T12:00:00Z → 13:00 in Berlin during CET
    expect(formatBerlinTime(Date.UTC(2026, 11, 19, 12, 0))).toBe("13:00");
  });
});

describe("formatBerlinDate", () => {
  it("renders DD.MM.YYYY", () => {
    expect(formatBerlinDate(Date.UTC(2026, 4, 19, 12, 0))).toBe("19.05.2026");
  });

  it("respects Berlin midnight rollover (just before midnight UTC → next day in Berlin)", () => {
    // 2026-05-19T23:00:00Z → 2026-05-20 01:00 Berlin (CEST)
    expect(formatBerlinDate(Date.UTC(2026, 4, 19, 23, 0))).toBe("20.05.2026");
  });
});

describe("berlinDayKey", () => {
  it("uses ISO order so string compare matches calendar order", () => {
    expect(berlinDayKey(Date.UTC(2026, 4, 19, 12, 0))).toBe("2026-05-19");
  });
});

describe("berlinCalendarOffsetDays", () => {
  const noon = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 10);
  // 10:00 UTC is safely past Berlin midnight in both CET and CEST.

  it("returns 0 for the same day", () => {
    expect(
      berlinCalendarOffsetDays(noon(2026, 5, 19), noon(2026, 5, 19)),
    ).toBe(0);
  });

  it("returns 1 for the next calendar day", () => {
    expect(
      berlinCalendarOffsetDays(noon(2026, 5, 20), noon(2026, 5, 19)),
    ).toBe(1);
  });

  it("returns 2 for the day after that", () => {
    expect(
      berlinCalendarOffsetDays(noon(2026, 5, 21), noon(2026, 5, 19)),
    ).toBe(2);
  });

  it("returns -1 for the previous day", () => {
    expect(
      berlinCalendarOffsetDays(noon(2026, 5, 18), noon(2026, 5, 19)),
    ).toBe(-1);
  });

  it("handles the spring DST transition (2026-03-29 in Berlin)", () => {
    // 2026-03-29 is the spring-forward day in Berlin (02:00 → 03:00 CEST).
    // The calendar still has 24 unique days; the offset between 03-28 and
    // 03-30 must be 2 even though the elapsed ms is 23h short of 2*86400000.
    const sat = noon(2026, 3, 28);
    const mon = noon(2026, 3, 30);
    expect(berlinCalendarOffsetDays(mon, sat)).toBe(2);
  });

  it("handles the autumn DST transition (2026-10-25 in Berlin)", () => {
    // 2026-10-25 is the fall-back day (03:00 → 02:00 CEST → CET).
    const sat = noon(2026, 10, 24);
    const mon = noon(2026, 10, 26);
    expect(berlinCalendarOffsetDays(mon, sat)).toBe(2);
  });
});

describe("formatBerlinRelativeDay", () => {
  const noon = (y: number, m: number, d: number, h = 12) =>
    Date.UTC(y, m - 1, d, h);

  it("returns 'heute' for the same Berlin day", () => {
    expect(
      formatBerlinRelativeDay(noon(2026, 5, 19, 12), noon(2026, 5, 19, 10)),
    ).toBe("heute");
  });

  it("returns 'morgen' for the next Berlin day", () => {
    expect(
      formatBerlinRelativeDay(noon(2026, 5, 20, 12), noon(2026, 5, 19, 10)),
    ).toBe("morgen");
  });

  it("returns 'übermorgen' for two days out", () => {
    expect(
      formatBerlinRelativeDay(noon(2026, 5, 21, 12), noon(2026, 5, 19, 10)),
    ).toBe("übermorgen");
  });

  it("falls back to DD.MM.YYYY for three+ days out", () => {
    expect(
      formatBerlinRelativeDay(noon(2026, 5, 23, 12), noon(2026, 5, 19, 10)),
    ).toBe("23.05.2026");
  });

  it("falls back to DD.MM.YYYY for past dates", () => {
    expect(
      formatBerlinRelativeDay(noon(2026, 5, 18, 12), noon(2026, 5, 19, 10)),
    ).toBe("18.05.2026");
  });
});

describe("formatBerlinWindow", () => {
  const noon = (y: number, m: number, d: number, h = 12, mm = 0) =>
    Date.UTC(y, m - 1, d, h, mm);

  it("renders a single-point window as '<day> HH:MM' when start === end", () => {
    // 2026-05-19T12:00:00Z → 14:00 Berlin
    const ts = noon(2026, 5, 19, 12, 0);
    expect(formatBerlinWindow(ts, ts, ts)).toBe("heute 14:00");
  });

  it("renders a same-day range as '<day> HH:MM–HH:MM'", () => {
    const start = noon(2026, 5, 19, 12, 0); // 14:00 Berlin
    const end = noon(2026, 5, 19, 14, 0); // 16:00 Berlin
    expect(formatBerlinWindow(start, end, start)).toBe("heute 14:00–16:00");
  });

  it("uses 'morgen' when the same-day window is the next calendar day", () => {
    const now = noon(2026, 5, 19, 10, 0);
    const start = noon(2026, 5, 20, 12, 0); // 14:00 Berlin
    const end = noon(2026, 5, 20, 14, 0); // 16:00 Berlin
    expect(formatBerlinWindow(start, end, now)).toBe("morgen 14:00–16:00");
  });

  it("renders a cross-day window with both endpoints", () => {
    const now = noon(2026, 5, 19, 10, 0);
    const start = noon(2026, 5, 20, 16, 0); // 18:00 Berlin (morgen)
    const end = noon(2026, 5, 21, 8, 0); // 10:00 Berlin (übermorgen)
    expect(formatBerlinWindow(start, end, now)).toBe(
      "morgen 18:00 – übermorgen 10:00",
    );
  });

  it("falls back to absolute dates on both endpoints for far-future windows", () => {
    const now = noon(2026, 5, 19, 10, 0);
    const start = noon(2026, 5, 25, 12, 0); // 14:00 Berlin
    const end = noon(2026, 5, 26, 12, 0); // 14:00 Berlin
    expect(formatBerlinWindow(start, end, now)).toBe(
      "25.05.2026 14:00 – 26.05.2026 14:00",
    );
  });
});
