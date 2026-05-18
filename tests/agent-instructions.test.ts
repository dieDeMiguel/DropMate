import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const instructionsPath = resolve(here, "..", "agent", "instructions.md");

const FORBIDDEN_TERMS = [
  "Marlene Hartmann",
  "Anna-Sophie Meyer",
  "Patricia Höfer",
  "Methfesselstraße",
  "Hs.88",
  "Hs.90",
  "Hs.92",
  "Marlene",
  "Hartmann",
  "Anna-Sophie",
  "Patricia",
  "Höfer",
  "Ritter",
  "Bremer",
  "Annemarie",
] as const;

describe("agent/instructions.md", () => {
  it("uses placeholders, not concrete resident identities, in examples", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const leaks = FORBIDDEN_TERMS.filter((term) => contents.includes(term));
    expect(leaks, `instructions.md must not contain example resident identities; the model treats them as authoritative Resident records (see issue #43 item 2b). Found: ${leaks.join(", ")}`).toEqual([]);
  });
});
