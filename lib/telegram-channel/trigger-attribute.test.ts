import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeTriggerAttributeSetter,
  setTelegramTriggerAttribute,
} from "./trigger-attribute.js";

describe("makeTriggerAttributeSetter", () => {
  // Composable seam exported for tests + future migration to a typed
  // framework-canonical key. The production callable
  // `setTelegramTriggerAttribute` wires its own setAttribute target via
  // the OTel API; this helper isolates the curry so the choice of key
  // ("trigger") stays in one place.

  it("forwards every trigger kind under the same key", () => {
    const setAttribute = vi.fn();
    const setter = makeTriggerAttributeSetter(setAttribute);

    setter("telegram.text-dm");
    setter("telegram.group");
    setter("telegram.photo");
    setter("telegram.slash-receive");
    setter("telegram.callback-confirm-pickup");
    setter("telegram.callback");

    expect(setAttribute.mock.calls).toEqual([
      ["trigger", "telegram.text-dm"],
      ["trigger", "telegram.group"],
      ["trigger", "telegram.photo"],
      ["trigger", "telegram.slash-receive"],
      ["trigger", "telegram.callback-confirm-pickup"],
      ["trigger", "telegram.callback"],
    ]);
  });
});

describe("setTelegramTriggerAttribute", () => {
  // Static import of @opentelemetry/api means the helper runs
  // synchronously and lands the attribute on whatever span the OTel
  // global says is active at the call site. With no provider
  // registered, `getActiveSpan()` returns `undefined` and the call is
  // a no-op — the helper must NEVER crash an inbound delivery.

  it("does not throw when no active span is set", () => {
    expect(() => setTelegramTriggerAttribute("telegram.text-dm")).not.toThrow();
    expect(() =>
      setTelegramTriggerAttribute("telegram.callback-confirm-pickup"),
    ).not.toThrow();
  });

  describe("with an active span", () => {
    const setAttribute = vi.fn();
    let getActiveSpanSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      setAttribute.mockReset();
      getActiveSpanSpy = vi.spyOn(trace, "getActiveSpan").mockReturnValue({
        setAttribute,
      } as unknown as ReturnType<typeof trace.getActiveSpan>);
    });

    afterEach(() => {
      getActiveSpanSpy.mockRestore();
    });

    it("synchronously stamps the trigger attribute on the active span", () => {
      // Synchronous contract: by the time the call returns, the
      // attribute is already on the span. Earlier revisions used a
      // fire-and-forget `.then(...)` microtask, which could drain
      // after `sendToAsh` had advanced the active context — landing
      // the attribute on a sibling instead of the parent of the
      // `ash.turn` span. Pin the synchronous behaviour explicitly.
      setTelegramTriggerAttribute("telegram.text-dm");
      expect(setAttribute).toHaveBeenCalledTimes(1);
      expect(setAttribute).toHaveBeenCalledWith("trigger", "telegram.text-dm");
    });

    it("forwards every trigger kind under the `trigger` key", () => {
      setTelegramTriggerAttribute("telegram.group");
      setTelegramTriggerAttribute("telegram.photo");
      setTelegramTriggerAttribute("telegram.slash-receive");
      setTelegramTriggerAttribute("telegram.callback-confirm-pickup");
      setTelegramTriggerAttribute("telegram.callback");

      expect(setAttribute.mock.calls).toEqual([
        ["trigger", "telegram.group"],
        ["trigger", "telegram.photo"],
        ["trigger", "telegram.slash-receive"],
        ["trigger", "telegram.callback-confirm-pickup"],
        ["trigger", "telegram.callback"],
      ]);
    });

    it("swallows setAttribute throws so an inbound delivery never crashes", () => {
      setAttribute.mockImplementationOnce(() => {
        throw new Error("bundler shim does not implement setAttribute");
      });
      expect(() =>
        setTelegramTriggerAttribute("telegram.text-dm"),
      ).not.toThrow();
    });
  });
});
