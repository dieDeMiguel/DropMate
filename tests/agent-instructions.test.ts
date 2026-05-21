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

// Regression for v2.1 Bug 2 (#94) — observed live 2026-05-21: on the
// `[FLOW_2 DONE]` synthetic the model emitted the card text verbatim
// ("📦 DHL-Paket erwartet heute 06:00–08:00. Kann jemand annehmen?") as
// the DM ack instead of the one-sentence "Habe in der Gruppe gefragt …"
// confirmation. The fix has two layers: (1) the synthetic itself is now
// directive (asserted in `lib/telegram-channel/process-update.test.ts`),
// and (2) the Flow 2 stanza in `instructions.md` calls out every
// card-shaped pattern the ack must NOT take. This block pins the
// instructions.md side of (2) so a future doc tweak can't silently
// delete the load-bearing prohibitions.
describe("agent/instructions.md Flow 2 ack format rules (v2.1 Bug 2, #94)", () => {
  let flow2Stanza: string;

  function extractFlow2Stanza(contents: string): string {
    const start = contents.indexOf("# Flow 2 — \"I won't be home\"");
    if (start === -1) {
      throw new Error(
        'could not locate the Flow 2 stanza header in instructions.md; if it was renamed, update this test',
      );
    }
    const after = contents.indexOf("\n# ", start + 1);
    return after === -1 ? contents.slice(start) : contents.slice(start, after);
  }

  it("contains explicit hard prohibitions on the card-shaped ack patterns from the bug trace", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    flow2Stanza = extractFlow2Stanza(contents);

    // Each clause names a specific pattern observed in the buggy live
    // ack — collectively they tell the model "the card is not the
    // template for your reply."
    expect(flow2Stanza).toMatch(/do not mention the carrier/i);
    expect(flow2Stanza).toMatch(/do not mention the date/i);
    expect(flow2Stanza).toMatch(/package emoji \(📦\)/i);
    expect(flow2Stanza).toMatch(/do not repeat.+card text/i);
    expect(flow2Stanza).toMatch(/do not ask "kann jemand annehmen\?"/i);
  });

  it("keeps the four per-language ack examples in sync with the synthetic's embedded examples", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    flow2Stanza = extractFlow2Stanza(contents);
    // The markdown source wraps long example sentences across multiple
    // lines with leading indentation. Normalise whitespace before
    // comparing so the assertions match the reader's mental model of
    // the sentence rather than the literal wrap.
    const normalised = flow2Stanza.replace(/\s+/g, " ");

    // The synthetic embeds these examples in `process-update.ts`'s
    // `FLOW_2_DONE_ACK_EXAMPLES` map. The stanza below MUST list the
    // same four examples verbatim — they are the canonical fallback
    // the model leans on for unknown-language requesters who fall
    // outside the synthetic's per-language example block.
    expect(normalised).toContain(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
    expect(normalised).toContain(
      "Asked in the group — I'll let you know as soon as someone says yes.",
    );
    expect(normalised).toContain(
      "Pregunté en el grupo — te aviso en cuanto alguien responda.",
    );
    expect(normalised).toContain(
      "Gruba sordum — biri yanıt verince haber veririm.",
    );
  });
});

// Regression for #43 item 2b round 3 — observed live 2026-05-18: the
// model produced the literal string "<holder.name>" in its reply because
// previous instructions used angle-bracket dashed placeholders
// (`<holder-name>`, `<holder-house>`, …) as illustrative template
// variables. The model treated them as Mustache-style tokens to copy
// verbatim instead of fields to substitute.
//
// The fix: outside of explicit "do NOT output this" warnings, instructions
// must not contain template-shaped placeholder tokens that the model
// could mistake for output it should emit. Inline-code-wrapped backtick
// references (e.g. `` `<holder-name>` ``) are allowed — backticks frame
// the token as a code identifier the human reader recognises, and we
// only forbid them when they appear in *naked* example text.
//
// Patterns checked:
//   - `<some-name>`, `<recipient-name>`, `<holder.name>`, etc.
//     Matched when NOT preceded by a backtick.
//
// We deliberately allow `<carrier>`, `<name>`, etc. inside backticks so
// the new "do NOT write `<holder-name>`" warning stanza can name the
// forbidden patterns explicitly without tripping its own lint.
describe("agent/instructions.md placeholder hygiene", () => {
  // The failure mode we're guarding against: the model emitting an
  // angle-bracket *dotted-path* placeholder verbatim. Specifically
  // `<holder.name>` and `<package.id>` shapes — those read to the
  // model as "Mustache field accessors I should copy" rather than
  // "field on the tool response I should look up".
  //
  // Dashed-identifier tokens (`<recipient>`, `<holder-name>`,
  // `<recipient-a>`) used in trigger-pattern descriptions have NOT
  // produced bad output historically and read naturally as illustrative
  // placeholders in prose. We deliberately do NOT lint those — banning
  // them would require rewriting unaffected long-standing docs.
  //
  // Tokens inside backticks (`<holder.name>`) are allowed: backticks
  // mark them as code identifiers, and the new "do NOT output this"
  // warning stanza needs to name forbidden patterns explicitly.
  const DOTTED_PLACEHOLDER_RE = /<[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*>/g;

  it("contains no naked dotted-path angle-bracket placeholders outside backticks", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const offences: { match: string; line: number }[] = [];
    const lines = contents.split("\n");
    lines.forEach((line, idx) => {
      // Split the line on backticks: even-indexed chunks are outside
      // inline-code spans, odd-indexed are inside. Lint only the outside
      // chunks. This handles `callbackData: "confirm_pickup:<package.id>"`
      // (whole inline-code expression) and matches the markdown reader's
      // intuition: backticked content is code identifiers, not template
      // for the model to copy.
      const segments = line.split("`");
      segments.forEach((segment, segIdx) => {
        if (segIdx % 2 === 1) return; // inside backticks
        const re = new RegExp(DOTTED_PLACEHOLDER_RE);
        let match: RegExpExecArray | null;
        while ((match = re.exec(segment)) !== null) {
          offences.push({ match: match[0], line: idx + 1 });
        }
      });
    });
    expect(
      offences,
      `instructions.md must not contain naked dotted-path angle-bracket placeholders (e.g. <holder.name>) outside backticks — the model emits them verbatim ('<holder.name>' observed live on 2026-05-18). Wrap them in backticks to mark them as code identifiers, or rewrite in prose. Offenders: ${offences
        .map((o) => `line ${o.line}: '${o.match}'`)
        .join("; ")}`,
    ).toEqual([]);
  });
});
