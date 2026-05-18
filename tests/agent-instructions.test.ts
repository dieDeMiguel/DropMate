import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const instructionsPath = resolve(repoRoot, "agent", "instructions.md");

// Concrete example identities the model has previously regurgitated as
// authoritative Resident records, plus the German "John Doe" placeholders
// it invented when no holder data was available. Any of these appearing in
// model-facing surfaces (instructions.md, tool descriptions/schemas, skill
// markdown, schedule prompts, redis doc comments that bubble into tool
// metadata) risks the agent emitting them in real output. See issue #43
// item 2b.
const FORBIDDEN_TERMS = [
  // Full names from earlier docs.
  "Marlene Hartmann",
  "Anna-Sophie Meyer",
  "Patricia Höfer",
  // Regurgitable surname/forename fragments.
  "Marlene",
  "Hartmann",
  "Anna-Sophie",
  "Patricia",
  "Höfer",
  "Ritter",
  "Bremer",
  "Annemarie",
  "Meyer",
  // Street.
  "Methfesselstraße",
  // House-number example patterns.
  "Hs.88",
  "Hs.90",
  "Hs.92",
  // German "John Doe" placeholders the model invented when no holder data
  // was present — observed live 2026-05-18.
  "Max Mustermann",
  "Maria Musterfrau",
  "Erika Mustermann",
] as const;

async function walk(
  dir: string,
  matcher: (path: string) => boolean,
): Promise<readonly string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, matcher)));
    } else if (entry.isFile() && matcher(full)) {
      out.push(full);
    }
  }
  return out;
}

async function collectFiles(): Promise<readonly string[]> {
  const files: string[] = [];
  // agent/instructions.md (the original scope).
  files.push(instructionsPath);
  // All TypeScript under agent/tools and agent/schedules.
  files.push(
    ...(await walk(resolve(repoRoot, "agent", "tools"), (p) =>
      p.endsWith(".ts"),
    )),
  );
  files.push(
    ...(await walk(resolve(repoRoot, "agent", "schedules"), (p) =>
      p.endsWith(".ts"),
    )),
  );
  // Skill markdown — loaded into the model's context when the matching
  // intent fires.
  files.push(
    ...(await walk(resolve(repoRoot, "agent", "skills"), (p) =>
      p.endsWith(".md"),
    )),
  );
  // Redis doc comments bubble into tool input/output type names and JSDoc
  // hover; some of them appear verbatim in tool descriptions.
  files.push(resolve(repoRoot, "lib", "redis.ts"));
  return files;
}

function scanForLeaks(
  contents: string,
  filePath: string,
): readonly { term: string; file: string }[] {
  return FORBIDDEN_TERMS.filter((term) => contents.includes(term)).map(
    (term) => ({ term, file: filePath }),
  );
}

describe("agent/instructions.md", () => {
  it("uses placeholders, not concrete resident identities, in examples", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const leaks = FORBIDDEN_TERMS.filter((term) => contents.includes(term));
    expect(
      leaks,
      `instructions.md must not contain example resident identities; the model treats them as authoritative Resident records (see issue #43 item 2b). Found: ${leaks.join(", ")}`,
    ).toEqual([]);
  });
});

describe("model-facing surfaces (tools, skills, schedules, lib/redis.ts)", () => {
  it("contain no example resident identities", async () => {
    const files = await collectFiles();
    const leaks: { term: string; file: string }[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      leaks.push(...scanForLeaks(contents, relative(repoRoot, file)));
    }
    expect(
      leaks,
      `Tool descriptions, Zod schema describe() strings, skill markdown, schedule prompts, and Redis doc comments are serialised into the model's prompt (or its tool catalogue). Any example identity here can be regurgitated as if it were an authoritative Resident record (see issue #43 item 2b). Leaks: ${leaks
        .map((l) => `${l.file}: '${l.term}'`)
        .join("; ")}`,
    ).toEqual([]);
  });
});
