# Ash Reference

Deeper notes on Ash beyond SKILL.md. Always cross-check against https://ash.labs.vercel.dev/docs/ — this file is a quick map, not a replacement for the docs.

## Discovery rules

Ash auto-discovers files in the standard directories under `agent/`. **The filename or folder name is the identifier** — there is no central registry.

- `tools/foo_bar.ts` → tool name `foo_bar`. Snake_case.
- `skills/billing.md` → skill `billing`. Loaded on demand based on the skill's frontmatter `description`.
- `channels/slack.ts` → Slack channel. Channels live only at the root of `agent/`.
- `hooks/` may nest recursively.
- `connections/<name>.ts` → one MCP connection per file.
- `schedules/*.ts` (with `defineSchedule()`) or `*.md` (with cron frontmatter).
- `subagents/<name>/` → each is its own package with its own `agent/` tree.

## `agent.ts` — runtime config

Holds model selection, model options, metadata, workspace settings, build config, and compaction tuning. Keep it small — behavior belongs in `instructions.md` and skills.

```ts
import { defineAgent } from "experimental-ash";

export default defineAgent({
  model: "anthropic/claude-opus-4.7",
  modelOptions: { providerOptions: { anthropic: { thinking: { type: "adaptive" } } } },
});
```

Common model strings use the AI Gateway form `"<provider>/<model>"` (e.g. `"anthropic/claude-opus-4.7"`, `"openai/gpt-5.4-mini"`).

## `instructions.md` — base prompt

Exactly one required. Defines identity and persistent behavior. Skills layer on top of this when triggered.

## Tools

- Description is the model's only signal — write it carefully (what it does, when to use, examples, return shape).
- Use Zod schemas (`zod` from the workspace catalog). Add `.describe(...)` on fields the model needs hints for.
- Tools must be deterministic, side-effect-aware, and safe to run on the model's behalf.
- Keep `agent/tools/` free of test files. Put integration tests under `agent/lib/__integration__/` and import the tool's implementation from `lib/`.

## Skills

- Markdown files with `description:` frontmatter. The description is the trigger — be specific about *when* to load it.
- Skills are seeded into `/workspace/skills/...` at runtime, so they can reference each other and the model can read them on demand.
- Use skills for capability packs, procedures, identity, domain knowledge. Use tools for API/code execution.

## Channels

Channels are how the agent receives input. Each file in `channels/` is a separate entrypoint:

- `slackChannel({ botName })` from `experimental-ash/channels/slack`
- HTTP/REST default channel at `/ash/v1/session`
- Twilio, web chat, CLI, cron — see docs

## Sessions and streaming

- `POST /ash/v1/session` with `{ "message": "..." }` starts a session. Response includes `continuationToken` and session ID header.
- `POST /ash/v1/session/<id>` with `{ "continuationToken", "message" }` continues it.
- Streams emit NDJSON. Key events: `session.started`, `turn.started`, `message.received`, `actions.requested`, `action.result`, `reasoning.appended`/`completed`, `message.appended`/`completed`.
- `finishReason` distinguishes interim tool narration from terminal responses.
- Child session IDs let you monitor delegated subagent work.

## Hooks

Subscribe to lifecycle and stream events. Use for logging, side-effects, gating. Lives in `hooks/`; subdirectories are allowed.

## Human-in-the-loop

Tools can require approval before execution — useful for destructive actions (sending messages, writing data). See the HITL docs page for the API.

## Sandboxes

Isolated VMs for safe code execution by the agent. Configured under `agent/sandbox/`; workspace files seeded there are visible at runtime.

## Subagents

Specialist child agents in `subagents/<name>/`. Each is its own package with its own `agent/` tree. The parent invokes them and can stream their child sessions back through the parent's stream.

## Evals

Test suites with scoring rubrics for agent quality. Wire into `pnpm eval` (see root `turbo.json` / `package.json`).

## Deployment

Deploy to Vercel. `instrumentation.ts` wires OTel (e.g. `@vercel/otel`, `@braintrust/otel`). See https://ash.labs.vercel.dev/docs/vercel-deployment.

## When the docs and this file disagree

Trust the docs. Fetch the relevant page under `https://ash.labs.vercel.dev/docs/` and update this file if you find drift.
