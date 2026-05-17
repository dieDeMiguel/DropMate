import { describe, expect, it } from "vitest";

import agent from "./agent.js";

describe("agent definition", () => {
  it("loads the agent default export without throwing", () => {
    expect(agent).toBeDefined();
  });
});
