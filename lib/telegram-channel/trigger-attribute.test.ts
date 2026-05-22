import { describe, expect, it, vi } from "vitest";

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
  // Best-effort wrapper around `@opentelemetry/api`. In the unit-test
  // environment the package isn't installed as a direct dependency and
  // the lazy resolver falls back to a no-op. The contract is that
  // calling it never crashes the webhook — losing the attribute is
  // acceptable, crashing the inbound delivery is not.

  it("does not throw when @opentelemetry/api is absent", () => {
    expect(() => setTelegramTriggerAttribute("telegram.text-dm")).not.toThrow();
    expect(() => setTelegramTriggerAttribute("telegram.callback-confirm-pickup")).not.toThrow();
  });
});
