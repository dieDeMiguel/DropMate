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

// v2.1 #100: the prior `[FLOW_2 DONE]` ack-shape stanza (and its
// per-language examples + card-shape prohibitions) was deleted because
// the agent no longer sees a Flow 2 synthetic — the channel sends the
// requester ack DM deterministically from `flow-2-dms.ts`. The new
// Flow 2 stanza in `instructions.md` is shorter and has a different
// load-bearing constraint: the agent must NOT post to the group or
// call Flow 2 tools even when a raw text inbound looks like a Flow 2
// trigger (e.g. an unregistered user's free-text that slipped past the
// channel classifier). This block pins that constraint.
describe("agent/instructions.md Flow 2 channel-driven contract (v2.1 #100)", () => {
  function extractFlow2Stanza(contents: string): string {
    const start = contents.indexOf('# Flow 2 — "I won\'t be home"');
    if (start === -1) {
      throw new Error(
        'could not locate the Flow 2 stanza header in instructions.md; if it was renamed, update this test',
      );
    }
    const after = contents.indexOf("\n# ", start + 1);
    return after === -1 ? contents.slice(start) : contents.slice(start, after);
  }

  it("states Flow 2 is fully channel-driven and the agent does not see synthetics for it", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const stanza = extractFlow2Stanza(contents);

    // The stanza must explicitly tell the model the channel owns Flow 2
    // end-to-end — no synthetics, no DM ack, no card posting.
    expect(stanza).toMatch(/channel-driven/i);
    // Names every synthetic that was deleted in #100 so a future
    // re-introduction is flagged.
    expect(stanza).toMatch(/\[FLOW_2 DONE\]/);
    expect(stanza).toMatch(/\[VISION_LOW_CONFIDENCE\]/);
    expect(stanza).toMatch(/\[VOLUNTEER_ACCEPTED\]/);
  });

  it("hard-prohibits the slip-past-classifier failure mode (raw text that looks like Flow 2)", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const stanza = extractFlow2Stanza(contents);

    // If the channel's regex/classifier ever misses, the agent might
    // see a raw text DM that LOOKS like Flow 2 ("Ich erwarte morgen
    // DHL"). The stanza must forbid the agent from posting to the
    // group or writing a request in that case — those side effects are
    // channel-only.
    expect(stanza).toMatch(/do not post to the group/i);
    expect(stanza).toMatch(/do not call any flow 2 tools/i);
  });
});

// v2.1 #109 (Slice 3 of #105): the Flow 1 stanza was re-introduced
// after Slices 1+2+4 deleted the prior v1 5-step prose. The new stanza
// describes ONLY the clarification synthetic the channel hands the
// agent on disambiguation cases — every other Flow 1 path (text
// registration, photo registration, pickup tap, DM-text pickup) is
// channel-driven and the agent never sees the inbound. This block
// pins the new stanza shape so a future regression that re-introduces
// the v1 5-step procedure (or removes the hard prohibitions) fails
// loud.
describe("agent/instructions.md Flow 1 channel-driven contract (v2.1 #109)", () => {
  function extractFlow1Stanza(contents: string): string {
    const start = contents.indexOf("# Flow 1 — package received (channel-driven)");
    if (start === -1) {
      throw new Error(
        "could not locate the Flow 1 stanza header in instructions.md; if it was renamed, update this test",
      );
    }
    const after = contents.indexOf("\n# ", start + 1);
    return after === -1 ? contents.slice(start) : contents.slice(start, after);
  }

  it("states Flow 1 is fully channel-driven (text, photo, pickup all bypass the agent)", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const stanza = extractFlow1Stanza(contents);
    expect(stanza).toMatch(/channel-driven/i);
    expect(stanza).toMatch(/classify_group_message/);
    expect(stanza).toMatch(/parse_label/);
    // The agent must NOT decide whether a group message is a package
    // registration.
    expect(stanza).toMatch(/You do \*\*not\*\* decide/i);
  });

  it("names the [FLOW_1 CLARIFICATION] synthetic and lists every reason", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const stanza = extractFlow1Stanza(contents);
    expect(stanza).toMatch(/\[FLOW_1 CLARIFICATION/);
    expect(stanza).toMatch(/low-conf/);
    expect(stanza).toMatch(/missing-recipient/);
    expect(stanza).toMatch(/ambiguous-multi/);
    expect(stanza).toMatch(/parse-failed/);
  });

  it("hard-prohibits tool calls + group posts + neighbour-availability prose on the clarification turn", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const stanza = extractFlow1Stanza(contents);
    // Lifted from the synthetic's own prohibition block; the agent
    // and the synthetic must stay in lockstep. \s+ allows the prose
    // to wrap across lines.
    expect(stanza).toMatch(/Do NOT call any tools/);
    expect(stanza).toMatch(/Do NOT post to the group/);
    expect(stanza).toMatch(/Do NOT mention\s+finding/i);
    // ONE short clarifying question — no multi-step procedures.
    expect(stanza).toMatch(/ONE short clarifying question/i);
  });

  it("does NOT reintroduce references to deleted find_available_neighbors / classify_message tools", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const stanza = extractFlow1Stanza(contents);
    expect(stanza).not.toMatch(/find_available_neighbors/);
    expect(stanza).not.toMatch(/classify_message\b/);
    // register_package may appear ONLY in a sentence whose subject is
    // a negation ("Do not call …", "register_package was removed",
    // etc.). Walk every match, slice ±200 chars around it, and
    // confirm a negation sits within that window — this tolerates the
    // long-form prose where the "do **not**" lives a couple of lines
    // above the tool name.
    const matches = [...stanza.matchAll(/register_package/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const start = Math.max(0, match.index! - 200);
      const end = Math.min(stanza.length, match.index! + 200);
      const window = stanza.slice(start, end);
      expect(
        window,
        `register_package mention near "${stanza.slice(match.index!, match.index! + 80)}…" has no NOT/removed/deleted qualifier within 200 chars`,
      ).toMatch(/do\s*\*?\*?\s*not|don't|never|removed|deleted/i);
    }
  });
});

// Regression for v2.1 #97 — observed live 2026-05-22: a fresh /register
// inbound produced TEN bot messages — a freely-generated welcome wall,
// a German reintroduction, a trilingual /language brochure, AND a Flow 2
// misfire ("Habe in der Gruppe gefragt …") against a registration that
// never asked for a reception request. The fix has two layers:
//   1. The channel layer writes the Resident + sends ONE confirmation DM
//      before the agent runs (asserted in process-update.test.ts).
//   2. The Onboarding stanza in instructions.md hard-prohibits the
//      welcome wall + Flow 2 misfire for any registration turn that
//      slips past the channel's regex.
// This block pins the instructions.md side of (2).
describe("agent/instructions.md Onboarding stanza (v2.1 #97)", () => {
  function extractOnboardingStanza(contents: string): string {
    const start = contents.indexOf("# Onboarding");
    if (start === -1) {
      throw new Error(
        "could not locate the Onboarding stanza in instructions.md (added for v2.1 #97); if it was renamed or removed, update this test or the docs",
      );
    }
    const after = contents.indexOf("\n# ", start + 1);
    return after === -1 ? contents.slice(start) : contents.slice(start, after);
  }

  it("hard-prohibits the welcome-wall + Flow 2 misfire patterns observed in the live trace", async () => {
    const contents = await readFile(instructionsPath, "utf8");
    const stanza = extractOnboardingStanza(contents);
    expect(stanza).toMatch(/do not emit a welcome wall/i);
    expect(stanza).toMatch(/do not call `post_to_group`/i);
    // Names the `/register` shape so the agent's one-sentence fallback
    // matches the canonical channel-deterministic input.
    expect(stanza).toMatch(/\/register/);
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
