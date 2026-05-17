---
name: use-ash
description: Reference guide for the Ash framework (`experimental-ash`) — Vercel's framework for building AI agents. Covers project layout, the `defineAgent`/`defineTool` APIs, skills, channels, CLI commands, session streaming, and conventions for organizing an agent. Use when the user invokes /use-ash, asks how to build or structure an Ash agent, works in a repo containing `agent.ts` + `agent/instructions.md`, edits files under `agent/{tools,skills,channels}/`, or mentions the `experimental-ash` package.
---

# Use Ash

Ash is Vercel's framework for building AI agents — instructions and skills in markdown, tools in TypeScript. Ash handles discovery, streaming, durability, channels, and deployment.

Authoritative docs: https://ash.labs.vercel.dev/docs/getting-started — fetch when in doubt.

## Quick start

```bash
pnpm create experimental-ash-agent   # interactive scaffold
pnpm dev                             # ash dev: REPL + local server
# or, in an existing project:
pnpm add -D experimental-ash
```

## Project layout

```
my-agent/agent/
  agent.ts            # defineAgent() — model + runtime config
  instructions.md     # base system prompt (exactly one)
  instrumentation.ts  # OTel setup; auto-run before agent code
  tools/              # defineTool() files; snake_case; auto-discovered
  skills/             # on-demand .md procedures loaded by the model
  channels/           # HTTP/Slack/etc entrypoints (root only)
  hooks/              # lifecycle + stream-event subscribers
  connections/        # MCP-backed external services
  schedules/          # cron jobs (.ts defineSchedule or .md w/ frontmatter)
  subagents/          # specialist child agents (each its own package)
  sandbox/            # sandbox config + seeded workspace files
  lib/                # shared helpers; import-only, not workspace-mounted
```

Only `skills/` and `sandbox/` content reach the runtime workspace.

## Core APIs

**Agent** — `agent/agent.ts`:

```ts
import { defineAgent } from "experimental-ash";

export default defineAgent({
  model: "anthropic/claude-opus-4.7",
  modelOptions: { providerOptions: { anthropic: { effort: "high" } } },
});
```

**Tool** — `agent/tools/<snake_case>.ts`:

```ts
import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

export default defineTool({
  description: "What it does + when to use it (the model reads this).",
  inputSchema: z.object({ city: z.string() }),
  async execute({ city }) { return { city, tempF: 72 }; },
});
```

**Skill** — `agent/skills/<name>.md` with frontmatter:

```md
---
description: When the model should load this skill (the trigger).
---

# Procedure body, instructions, examples...
```

**Channel** — `agent/channels/<name>.ts` (e.g. Slack):

```ts
import { slackChannel } from "experimental-ash/channels/slack";
export default slackChannel({ botName: "my-bot" });
```

## CLI

- `ash dev` — local runtime + REPL
- `ash build` — compile to `.ash/`
- `ash info` — show routes + compiled artifacts

## Sessions and streaming

`POST /ash/v1/session` returns a `continuationToken` and session ID. Follow-ups POST to `/ash/v1/session/<id>` with the token. Streams emit NDJSON lifecycle events (`session.started`, `turn.started`, `actions.requested`, `action.result`, `message.appended`/`completed`, etc.).

## Conventions

- `agent.ts` stays minimal (model + runtime config). Behavior goes in `instructions.md` and skills.
- Tool `description` is the model's only signal — state what, when, examples, return shape. Add `.describe()` on Zod fields that need hints.
- For long-running tools, stream progress and return a continuation token for follow-ups.

## Test placement (hard requirement, not a style preference)

**Never put `.test.ts` files inside `agent/tools/`, `agent/hooks/`, `agent/channels/`, `agent/schedules/`, or `agent/subagents/`.** Discovery treats every `.ts` file in those slots as a tool/hook/channel/etc. source and uses the file stem as the runtime slug. The slug validator rejects dots, so `register_package.test.ts` → slug `register_package.test` → **fatal `ash build` error**:

```
Error: Tool filename "register_package.test" is not a legal tool name.
Expected ASCII letters, digits, underscores, and dashes only,
starting with a letter, up to 64 characters.
```

This blocks Vercel deploys, not just local builds. The colocated-tests pattern from `src/**/*.test.ts` that Ash itself uses **does not work in user agent projects** because `src/` isn't a scanned slot but `agent/tools/` is.

**Canonical layout** — mirror the agent structure under a top-level `tests/` directory:

```
my-agent/
  agent/
    tools/
      register_resident.ts
    hooks/
      language_detection.ts
  tests/
    tools/
      register_resident.test.ts   # ← here, not agent/tools/
    hooks/
      language_detection.test.ts
  lib/
    redis.ts
    redis.test.ts                 # ← colocated is FINE in lib/ (not scanned)
  vitest.config.ts                # include: ["tests/**/*.test.ts", "lib/**/*.test.ts"]
```

**What is safe vs. unsafe:**
- ✅ `lib/foo.test.ts` — `lib/` at the repo root is not an Ash-scanned slot
- ✅ `agent/agent.test.ts` — `agent.test.ts` doesn't match the `agent.ts` slot pattern, silently ignored
- ✅ `tests/**/*.test.ts` — outside all slots
- ❌ `agent/tools/foo.test.ts` — fatal slug validation error
- ❌ `agent/hooks/foo.test.ts` — same, and `hooks/` walks recursively so `agent/hooks/__tests__/` doesn't help either
- ❌ `agent/tools/__tests__/` — slug validation still rejects `__tests__` (starts with underscore, not a letter)

**Dynamic import paths in moved tests:** `await import("./foo.js")` becomes `await import("../../agent/tools/foo.js")`. The `"../../lib/redis.js"` mocks usually survive verbatim because both `agent/tools/` and `tests/tools/` sit 2 levels below the repo root.

## Deeper reference

See [REFERENCE.md](REFERENCE.md) for hooks, subagents, evals, sandboxes, human-in-the-loop, and deployment patterns. For anything not covered, fetch the page under `https://ash.labs.vercel.dev/docs/` rather than guessing.
