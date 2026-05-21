/**
 * `classify_dm_intent` — channel-side classifier replacing the
 * agent-driven branching that produced the v2 regression (#85).
 *
 * Tests cover four concerns:
 *
 *   1. The fallback chain (primary throws → fallback runs → fallback
 *      throws → re-throw primary).
 *   2. The prompt + output schema across DE / EN / ES / TR (matches
 *      the four absence-signal language families v2.1 must handle).
 *   3. Negative cases — the v2 regression's root cause was the model
 *      firing tools opportunistically on inputs that should NOT
 *      trigger Flow 2 (Flow 0, Flow 1, Flow 3, registration, chat).
 *   4. The v2.1 Bug 1 regression (#93 / #92 Trace A): the production
 *      ship attempt produced `heute 06:00–08:00` for the input
 *      `morgen 14-16 Uhr`. The tool now asks the model for local
 *      clock strings and converts to Unix ms in-code; tests pin
 *      "today" via `vi.setSystemTime` and assert the conversion is
 *      correct on the exact production input.
 *
 * The model is stubbed via `vi.mock("ai", ...)` exactly the way
 * `parse_tracking_page.test.ts` does it, so the assertions describe
 * input-shape contracts (which model slug was called, what the user
 * prompt contains) rather than re-implementing the model itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

async function loadTool() {
  const mod = await import("../../agent/tools/classify_dm_intent.js");
  return mod.default;
}

async function loadModelSlugs() {
  const mod = await import("../../agent/tools/classify_dm_intent.js");
  return { primary: mod.PRIMARY_MODEL, fallback: mod.FALLBACK_MODEL };
}

async function runExecute(input: Record<string, unknown>) {
  const tool = await loadTool();
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("classify_dm_intent — fallback chain", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("returns the primary model's parsed output on the happy path", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        confidence: "high",
        reason: "explicit absence + DHL carrier",
      },
    });

    const result = (await runExecute({
      text: "Ich erwarte morgen DHL und bin nicht zu Hause",
    })) as { isFlow2: boolean; confidence: string };

    expect(result.isFlow2).toBe(true);
    expect(result.confidence).toBe("high");

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const { primary } = await loadModelSlugs();
    expect(generateObjectMock.mock.calls[0]![0].model).toBe(primary);
  });

  it("falls back to the secondary model when the primary throws", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("gemini timed out"));
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "fallback ok; this is a search query",
      },
    });

    const result = (await runExecute({
      text: "Wo ist mein Paket?",
    })) as { isFlow2: boolean };

    expect(result.isFlow2).toBe(false);

    const { primary, fallback } = await loadModelSlugs();
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(generateObjectMock.mock.calls[0]![0].model).toBe(primary);
    expect(generateObjectMock.mock.calls[1]![0].model).toBe(fallback);
  });

  it("re-throws the primary's error when BOTH primary and fallback fail (preserves diagnostic signal)", async () => {
    const primaryErr = new Error("gemini down");
    generateObjectMock.mockRejectedValueOnce(primaryErr);
    generateObjectMock.mockRejectedValueOnce(new Error("claude down too"));

    await expect(runExecute({ text: "anything" })).rejects.toBe(primaryErr);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it("PRIMARY_MODEL and FALLBACK_MODEL name real AI Gateway model slugs", async () => {
    // Regression guard mirroring parse_label / parse_tracking_page —
    // we use the same fallback chain shape and want to catch typos
    // like 'sonnet-4.7' (which doesn't exist) before they hit prod.
    const { primary, fallback } = await loadModelSlugs();
    const knownSlugs = [
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "google/gemini-3-flash",
      "google/gemini-3.1-flash-lite",
      "google/gemini-3.1-pro-preview",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.7",
    ];
    expect(knownSlugs.some((s) => primary.startsWith(s))).toBe(true);
    expect(knownSlugs.some((s) => fallback.startsWith(s))).toBe(true);
  });
});

describe("classify_dm_intent — prompt shape", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "default stub",
      },
    });
  });

  it("includes today's, tomorrow's, and day-after-tomorrow's Berlin dates so relative-day parsing has concrete anchors", async () => {
    await runExecute({ text: "morgen kommt mein Paket" });
    const call = generateObjectMock.mock.calls[0]![0];
    // The new prompt names all three offsets explicitly so the model
    // doesn't have to compute "tomorrow" itself — the bug-1 #93 root
    // cause was the model emitting today's date when the user wrote
    // "morgen".
    expect(call.prompt).toMatch(/Today is \d{4}-\d{2}-\d{2}/);
    expect(call.prompt).toMatch(/Tomorrow is \d{4}-\d{2}-\d{2}/);
    expect(call.prompt).toMatch(/Day after tomorrow is \d{4}-\d{2}-\d{2}/);
  });

  it("names the Berlin weekday alongside today's date so weekday references ('Montag', ...) have an anchor", async () => {
    await runExecute({ text: "Montag kommt mein Paket" });
    const call = generateObjectMock.mock.calls[0]![0];
    expect(call.prompt).toMatch(
      /Today is \d{4}-\d{2}-\d{2} \((montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag), Europe\/Berlin\)/i,
    );
  });

  it("threads the languageHint into the user prompt when supplied", async () => {
    await runExecute({ text: "hola", languageHint: "es" });
    const call = generateObjectMock.mock.calls[0]![0];
    expect(call.prompt).toContain("es");
    expect(call.prompt).toMatch(/language hint/i);
  });

  it("notes the absence of a language hint when none was supplied", async () => {
    await runExecute({ text: "hello" });
    const call = generateObjectMock.mock.calls[0]![0];
    expect(call.prompt).toMatch(/No language hint/i);
  });

  it("routes via the Vercel AI Gateway with cost-sorted provider selection", async () => {
    await runExecute({ text: "anything" });
    const call = generateObjectMock.mock.calls[0]![0];
    expect(call.providerOptions?.gateway?.sort).toBe("cost");
  });
});

describe("classify_dm_intent — positive Flow 2 cases (DE/EN/ES/TR)", () => {
  // Each case stubs the model's output to validate that the tool
  // round-trips the structured fields the channel will consume. The
  // model itself is mocked — we are NOT asserting Gemini reasoning,
  // we are asserting that the tool's contract (schema, transport,
  // model selection) holds for the four languages the issue requires.

  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("DE: 'Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause' → isFlow2 high-confidence", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        expectedDate: "2026-05-22",
        expectedWindowStartLocal: "14:00",
        expectedWindowEndLocal: "16:00",
        confidence: "high",
        reason: "explicit absence + carrier + window",
      },
    });

    const result = (await runExecute({
      text: "Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause",
      languageHint: "de",
    })) as {
      isFlow2: boolean;
      absenceSignal: boolean;
      carrier: string;
      confidence: string;
    };

    expect(result.isFlow2).toBe(true);
    expect(result.absenceSignal).toBe(true);
    expect(result.carrier).toBe("DHL");
    expect(result.confidence).toBe("high");
  });

  it("EN: 'Tomorrow I'll get a Hermes package but I'll be at work' → isFlow2 high-confidence", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "Hermes",
        expectedDate: "2026-05-22",
        confidence: "high",
        reason: "absence ('at work') + Hermes",
      },
    });

    const result = (await runExecute({
      text: "Tomorrow I'll get a Hermes package but I'll be at work",
      languageHint: "en",
    })) as { isFlow2: boolean; carrier: string; confidence: string };

    expect(result.isFlow2).toBe(true);
    expect(result.carrier).toBe("Hermes");
    expect(result.confidence).toBe("high");
  });

  it("ES: 'Mañana espero un paquete de DHL pero no estaré en casa' → isFlow2 high-confidence", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        expectedDate: "2026-05-22",
        confidence: "high",
        reason: "Spanish absence + DHL",
      },
    });

    const result = (await runExecute({
      text: "Mañana espero un paquete de DHL pero no estaré en casa",
      languageHint: "es",
    })) as { isFlow2: boolean; absenceSignal: boolean; confidence: string };

    expect(result.isFlow2).toBe(true);
    expect(result.absenceSignal).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("TR: 'Yarın bir DHL kargosu bekliyorum ama evde olmayacağım' → isFlow2 high-confidence", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        expectedDate: "2026-05-22",
        confidence: "high",
        reason: "Turkish absence + DHL",
      },
    });

    const result = (await runExecute({
      text: "Yarın bir DHL kargosu bekliyorum ama evde olmayacağım",
      languageHint: "tr",
    })) as { isFlow2: boolean; confidence: string };

    expect(result.isFlow2).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("DE: 'Donnerstag kommt mein Paket, ich bin nicht da' → isFlow2 medium (no carrier, vague day)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        confidence: "medium",
        reason: "absence + day but no carrier and no window",
      },
    });

    const result = (await runExecute({
      text: "Donnerstag kommt mein Paket, ich bin nicht da",
    })) as { isFlow2: boolean; confidence: string };

    expect(result.isFlow2).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("EN: 'I'll be travelling next week, expecting a UPS box' → isFlow2 medium", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "UPS",
        confidence: "medium",
        reason: "absence + carrier but no concrete day",
      },
    });

    const result = (await runExecute({
      text: "I'll be travelling next week, expecting a UPS box",
    })) as { isFlow2: boolean; carrier: string; confidence: string };

    expect(result.isFlow2).toBe(true);
    expect(result.carrier).toBe("UPS");
    expect(result.confidence).toBe("medium");
  });

  it("DE: 'Heute kommt DPD zwischen 10 und 12, ich bin unterwegs' → isFlow2 high", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DPD",
        expectedDate: "2026-05-21",
        expectedWindowStartLocal: "10:00",
        expectedWindowEndLocal: "12:00",
        confidence: "high",
        reason: "absence ('unterwegs') + DPD + window",
      },
    });

    const result = (await runExecute({
      text: "Heute kommt DPD zwischen 10 und 12, ich bin unterwegs",
    })) as { confidence: string };

    expect(result.confidence).toBe("high");
  });

  it("ES: 'Hoy de 14 a 16 espero un paquete de Amazon, estoy fuera' → isFlow2 high", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "Amazon",
        expectedDate: "2026-05-21",
        expectedWindowStartLocal: "14:00",
        expectedWindowEndLocal: "16:00",
        confidence: "high",
        reason: "Spanish absence + Amazon + window",
      },
    });

    const result = (await runExecute({
      text: "Hoy de 14 a 16 espero un paquete de Amazon, estoy fuera",
    })) as { carrier: string; confidence: string };

    expect(result.carrier).toBe("Amazon");
    expect(result.confidence).toBe("high");
  });

  it("TR: 'Bugün 15-17 arasında GLS gelecek, işteyim' → isFlow2 high", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "GLS",
        expectedDate: "2026-05-21",
        expectedWindowStartLocal: "15:00",
        expectedWindowEndLocal: "17:00",
        confidence: "high",
        reason: "Turkish absence + GLS + window",
      },
    });

    const result = (await runExecute({
      text: "Bugün 15-17 arasında GLS gelecek, işteyim",
    })) as { carrier: string; confidence: string };

    expect(result.carrier).toBe("GLS");
    expect(result.confidence).toBe("high");
  });

  it("DE: '/receive DHL morgen 14-16' is technically a slash command but the classifier should still recognise the structure", async () => {
    // /receive is handled by the channel layer directly in Slice 2 (#87),
    // so classify_dm_intent is never asked. But if the channel's
    // dispatcher ever falls through to the classifier with a /receive
    // text, the classifier should NOT crash — it just returns whatever
    // the model gave. We assert the schema round-trips, not the
    // behaviour.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: false, // slash command doesn't say "I'm out"
        carrier: "DHL",
        expectedDate: "2026-05-22",
        confidence: "medium",
        reason: "/receive structure recognised",
      },
    });

    const result = (await runExecute({
      text: "/receive DHL morgen 14-16",
    })) as { isFlow2: boolean; confidence: string };

    expect(result.isFlow2).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("DE: 'Übermorgen UPS, ich bin auf der Arbeit' → isFlow2 medium (no window)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "UPS",
        expectedDate: "2026-05-23",
        confidence: "medium",
        reason: "absence + carrier + day but no window",
      },
    });

    const result = (await runExecute({
      text: "Übermorgen UPS, ich bin auf der Arbeit",
    })) as { confidence: string; expectedDate: string };

    expect(result.confidence).toBe("medium");
    expect(result.expectedDate).toBe("2026-05-23");
  });

  it("EN: 'Won't be home tomorrow, FedEx package incoming' → isFlow2 high (FedEx maps to 'unknown')", async () => {
    // Per packageCarrierSchema, FedEx maps to 'unknown' — the classifier
    // surfaces the absence + day even when the carrier isn't in our enum.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "unknown",
        expectedDate: "2026-05-22",
        confidence: "high",
        reason: "absence + day; FedEx mapped to unknown",
      },
    });

    const result = (await runExecute({
      text: "Won't be home tomorrow, FedEx package incoming",
    })) as { carrier: string; confidence: string };

    expect(result.carrier).toBe("unknown");
    expect(result.confidence).toBe("high");
  });
});

describe("classify_dm_intent — negative cases (NOT Flow 2)", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("DE: 'Ein Paket kommt heute' → isFlow2 false (Flow 0 — pre-announce WITHOUT absence)", async () => {
    // Critical negative case from #85: this is the user announcing a
    // delivery, NOT asking for help. v2 fired register_expected_delivery
    // alongside Flow 2 here, which is the bug. The classifier MUST
    // return isFlow2=false so the agent handles Flow 0 alone.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "no absence signal — Flow 0",
      },
    });

    const result = (await runExecute({
      text: "Ein Paket kommt heute",
    })) as { isFlow2: boolean; absenceSignal: boolean };

    expect(result.isFlow2).toBe(false);
    expect(result.absenceSignal).toBe(false);
  });

  it("DE: 'Wo ist mein Paket?' → isFlow2 false (Flow 3 — search)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "search intent, not pre-announce",
      },
    });

    const result = (await runExecute({
      text: "Wo ist mein Paket?",
    })) as { isFlow2: boolean };

    expect(result.isFlow2).toBe(false);
  });

  it("DE: 'Habe ein Paket für Müller angenommen' → isFlow2 false (Flow 1 — group label)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "package received for someone, not pre-announce",
      },
    });

    const result = (await runExecute({
      text: "Habe ein Paket für Müller angenommen",
    })) as { isFlow2: boolean };

    expect(result.isFlow2).toBe(false);
  });

  it("DE: '/register Diego, Methfesselstraße 90' → isFlow2 false (registration)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "registration command",
      },
    });

    const result = (await runExecute({
      text: "/register Diego, Methfesselstraße 90",
    })) as { isFlow2: boolean };

    expect(result.isFlow2).toBe(false);
  });

  it("DE: 'Hallo! Wie geht's?' → isFlow2 false (chit-chat)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "social greeting",
      },
    });

    const result = (await runExecute({ text: "Hallo! Wie geht's?" })) as {
      isFlow2: boolean;
    };

    expect(result.isFlow2).toBe(false);
  });

  it("EN: 'Thanks!' → isFlow2 false (acknowledgement)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "acknowledgement",
      },
    });

    const result = (await runExecute({ text: "Thanks!" })) as {
      isFlow2: boolean;
    };

    expect(result.isFlow2).toBe(false);
  });

  it("DE: 'Bin morgen nicht da' → isFlow2 false (absence WITHOUT package context — could be vacation note)", async () => {
    // Tricky: absence is present but there's no package context.
    // Conservative bias says: don't trigger Flow 2; let the agent ask
    // a follow-up.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: true,
        confidence: "low",
        reason: "absence but no package context",
      },
    });

    const result = (await runExecute({
      text: "Bin morgen nicht da",
    })) as { isFlow2: boolean; absenceSignal: boolean };

    expect(result.isFlow2).toBe(false);
    expect(result.absenceSignal).toBe(true);
  });

  it("DE: 'DHL kommt um 14 Uhr' → isFlow2 false (Flow 0 — carrier+window WITHOUT absence)", async () => {
    // Critical: just because a carrier and window are mentioned does
    // NOT make it Flow 2. Absence is the load-bearing signal.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: false,
        absenceSignal: false,
        carrier: "DHL",
        expectedDate: "2026-05-21",
        expectedWindowStartLocal: "14:00",
        expectedWindowEndLocal: "14:00",
        confidence: "low",
        reason: "carrier + window but no absence — Flow 0",
      },
    });

    const result = (await runExecute({
      text: "DHL kommt um 14 Uhr",
    })) as { isFlow2: boolean; absenceSignal: boolean };

    expect(result.isFlow2).toBe(false);
    expect(result.absenceSignal).toBe(false);
  });
});

describe("classify_dm_intent — v2.1 Bug 1 regression (#93 / #92 Trace A): local-clock → Unix ms conversion", () => {
  // The production card read `heute 06:00–08:00` for the input
  // `Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause`. Two bugs
  // composed:
  //   1. Model emitted Unix ms directly — easy to get wrong by 8h.
  //   2. Prompt didn't disambiguate `morgen` (tomorrow) vs `morgens`
  //      (in the morning).
  //
  // The fix has the model emit local clock strings; `execute()`
  // converts to Unix ms via the Berlin-anchored helper used by
  // `/receive`. These tests pin `Date.now()` to a fixed Berlin moment
  // so the converted Unix ms values are exact.
  beforeEach(() => {
    generateObjectMock.mockReset();
    // Anchor "now" to 2026-05-21 10:00 Europe/Berlin (which is 08:00 UTC
    // in summer, +02:00 offset). The system prompt advertises
    // "Tomorrow is 2026-05-22"; the test asserts the converted Unix ms
    // matches Berlin 14:00 / 16:00 on that day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("regression: 'Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause' → tomorrow 14:00–16:00 Berlin, not today 06:00–08:00", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        expectedDate: "2026-05-22",
        expectedWindowStartLocal: "14:00",
        expectedWindowEndLocal: "16:00",
        confidence: "high",
        reason: "explicit absence + carrier + window on tomorrow",
      },
    });

    const result = (await runExecute({
      text: "Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause",
      languageHint: "de",
    })) as {
      isFlow2: boolean;
      carrier: string;
      expectedDate: string;
      expectedWindowStartAt: number;
      expectedWindowEndAt: number;
      confidence: string;
    };

    expect(result.isFlow2).toBe(true);
    expect(result.carrier).toBe("DHL");
    expect(result.confidence).toBe("high");
    expect(result.expectedDate).toBe("2026-05-22");

    // 2026-05-22 14:00 Europe/Berlin is summer time (+02:00) → 12:00 UTC.
    expect(result.expectedWindowStartAt).toBe(
      Date.UTC(2026, 4, 22, 12, 0, 0),
    );
    expect(result.expectedWindowEndAt).toBe(Date.UTC(2026, 4, 22, 14, 0, 0));

    // And the buggy value the production trace produced — today
    // 2026-05-21 06:00 Berlin (= 04:00 UTC) — must NOT appear.
    expect(result.expectedWindowStartAt).not.toBe(
      Date.UTC(2026, 4, 21, 4, 0, 0),
    );
  });

  it("'morgen Vormittag' → tomorrow 09:00–12:00 (NOT today morning)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "Hermes",
        expectedDate: "2026-05-22",
        expectedWindowStartLocal: "09:00",
        expectedWindowEndLocal: "12:00",
        confidence: "high",
        reason: "Vormittag = 09-12 on tomorrow",
      },
    });

    const result = (await runExecute({
      text: "Hermes kommt morgen Vormittag, ich bin im Büro",
    })) as {
      expectedDate: string;
      expectedWindowStartAt: number;
      expectedWindowEndAt: number;
    };

    expect(result.expectedDate).toBe("2026-05-22");
    expect(result.expectedWindowStartAt).toBe(Date.UTC(2026, 4, 22, 7, 0, 0));
    expect(result.expectedWindowEndAt).toBe(Date.UTC(2026, 4, 22, 10, 0, 0));
  });

  it("'heute Vormittag' → today 09:00–12:00", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        expectedDate: "2026-05-21",
        expectedWindowStartLocal: "09:00",
        expectedWindowEndLocal: "12:00",
        confidence: "high",
        reason: "absence + today Vormittag + DHL",
      },
    });

    const result = (await runExecute({
      text: "Heute Vormittag kommt DHL, ich bin nicht zu Hause",
    })) as {
      expectedDate: string;
      expectedWindowStartAt: number;
      expectedWindowEndAt: number;
    };

    expect(result.expectedDate).toBe("2026-05-21");
    expect(result.expectedWindowStartAt).toBe(Date.UTC(2026, 4, 21, 7, 0, 0));
    expect(result.expectedWindowEndAt).toBe(Date.UTC(2026, 4, 21, 10, 0, 0));
  });

  it("'heute Nachmittag' → today 14:00–18:00", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "UPS",
        expectedDate: "2026-05-21",
        expectedWindowStartLocal: "14:00",
        expectedWindowEndLocal: "18:00",
        confidence: "high",
        reason: "Nachmittag = 14-18 today",
      },
    });

    const result = (await runExecute({
      text: "UPS kommt heute Nachmittag, ich bin auf der Arbeit",
    })) as {
      expectedWindowStartAt: number;
      expectedWindowEndAt: number;
    };

    expect(result.expectedWindowStartAt).toBe(Date.UTC(2026, 4, 21, 12, 0, 0));
    expect(result.expectedWindowEndAt).toBe(Date.UTC(2026, 4, 21, 16, 0, 0));
  });

  it("'übermorgen' → day after tomorrow (2026-05-23)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "UPS",
        expectedDate: "2026-05-23",
        confidence: "medium",
        reason: "absence + carrier + übermorgen but no window",
      },
    });

    const result = (await runExecute({
      text: "Übermorgen UPS, ich bin auf der Arbeit",
    })) as { expectedDate: string; expectedWindowStartAt?: number };

    expect(result.expectedDate).toBe("2026-05-23");
    expect(result.expectedWindowStartAt).toBeUndefined();
  });

  it("German weekday names resolve via the prompt's weekday anchor (Montag from a Donnerstag → next Monday)", async () => {
    // Today (pinned) is Donnerstag 2026-05-21. Next Montag is 2026-05-25.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        expectedDate: "2026-05-25",
        confidence: "medium",
        reason: "Montag from Donnerstag → next Monday",
      },
    });

    const result = (await runExecute({
      text: "Montag kommt DHL, ich bin im Büro",
    })) as { expectedDate: string };

    expect(result.expectedDate).toBe("2026-05-25");

    // The prompt must give the model the weekday anchor so it can do
    // this resolution at all.
    const call = generateObjectMock.mock.calls[0]![0];
    expect(call.prompt).toMatch(/donnerstag/i);
  });

  it("malformed model output (window with missing date) drops the window rather than throwing or inventing a date", async () => {
    // Defensive: if the model emits clock strings but forgets
    // `expectedDate`, the post-processor has nothing to anchor the
    // window against. Drop the window fields; keep the rest of the
    // classification.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        // expectedDate omitted on purpose
        expectedWindowStartLocal: "14:00",
        expectedWindowEndLocal: "16:00",
        confidence: "medium",
        reason: "window without a date — drop window",
      },
    });

    const result = (await runExecute({
      text: "DHL 14-16 Uhr, bin nicht da",
    })) as {
      isFlow2: boolean;
      carrier: string;
      expectedWindowStartAt?: number;
      expectedWindowEndAt?: number;
    };

    expect(result.isFlow2).toBe(true);
    expect(result.carrier).toBe("DHL");
    expect(result.expectedWindowStartAt).toBeUndefined();
    expect(result.expectedWindowEndAt).toBeUndefined();
  });

  it("malformed model output (start > end) drops the window rather than emitting an inverted range", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        isFlow2: true,
        absenceSignal: true,
        carrier: "DHL",
        expectedDate: "2026-05-22",
        expectedWindowStartLocal: "16:00",
        expectedWindowEndLocal: "14:00", // inverted
        confidence: "high",
        reason: "inverted range — drop",
      },
    });

    const result = (await runExecute({
      text: "DHL morgen 16-14 Uhr, bin nicht da",
    })) as {
      isFlow2: boolean;
      expectedWindowStartAt?: number;
      expectedWindowEndAt?: number;
    };

    expect(result.isFlow2).toBe(true);
    expect(result.expectedWindowStartAt).toBeUndefined();
    expect(result.expectedWindowEndAt).toBeUndefined();
  });
});

describe("classify_dm_intent — system prompt disambiguation (v2.1 Bug 1 / #93)", () => {
  it("the system prompt explicitly disambiguates 'morgen' (tomorrow) from 'morgens' (in the morning)", async () => {
    // This is the single most important prompt-engineering fix in this
    // slice. The system prompt MUST contain prose that tells the model
    // 'morgen' is never a time-of-day. Asserting the literal text
    // pins the constraint so future prompt tweaks can't silently
    // delete it.
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "test stub",
      },
    });
    await runExecute({ text: "anything" });
    const call = generateObjectMock.mock.calls[0]![0];
    expect(call.system).toMatch(/morgen.*≠.*morgens/i);
    expect(call.system).toMatch(/'morgen'\s+ALWAYS means 'tomorrow'/i);
  });

  it("the system prompt lists German time-of-day phrases with concrete hour windows", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "test stub",
      },
    });
    await runExecute({ text: "anything" });
    const call = generateObjectMock.mock.calls[0]![0];
    // The Vormittag / Nachmittag / Abend mappings must be in the prompt
    // so the model can map 'morgen Vormittag' to a 09-12 window.
    expect(call.system).toMatch(/Vormittag.*09:00-12:00/);
    expect(call.system).toMatch(/Nachmittag.*14:00-18:00/);
    expect(call.system).toMatch(/Abend.*18:00-21:00/);
  });

  it("the system prompt instructs the model to emit local clock strings, NOT Unix timestamps", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: {
        isFlow2: false,
        absenceSignal: false,
        confidence: "low",
        reason: "test stub",
      },
    });
    await runExecute({ text: "anything" });
    const call = generateObjectMock.mock.calls[0]![0];
    // The output schema only accepts HH:mm strings, but a belt-and-braces
    // hint in the system prompt helps the model when it would otherwise
    // try to be helpful and emit numbers.
    expect(call.system).toMatch(/Do NOT emit Unix timestamps/i);
  });
});
