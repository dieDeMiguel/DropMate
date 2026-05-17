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
- `tools/` is auto-discovered; keep it free of tests. Put import-only helpers in `lib/`; integration tests for tools go elsewhere (e.g. `lib/__integration__/`).
- For long-running tools, stream progress and return a continuation token for follow-ups.

## Deeper reference

See [REFERENCE.md](REFERENCE.md) for hooks, subagents, evals, sandboxes, human-in-the-loop, and deployment patterns. For anything not covered, fetch the page under `https://ash.labs.vercel.dev/docs/` rather than guessing.
