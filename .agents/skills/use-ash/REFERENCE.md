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
- `twilioChannel({ allowFrom, messaging })` from `experimental-ash/channels/twilio`
- `ashChannel({ auth })` — built-in HTTP session protocol at `/ash/v1/session`
- Web chat, CLI, cron — see docs

**Prefer framework channels.** Custom HTTP channels work but lose Trigger column attribution in Agent Runs and require you to replicate OTEL conventions by hand. If a `@chat-adapter/*` package exists for the platform, wrap it in a thin channel factory instead of hand-rolling verify/inbound/outbound/send primitives.

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

## Schedules

Two shapes — choose deliberately:

- `defineSchedule({ cron, markdown })` — fire-and-forget. The model runs the prompt on cron and the output is discarded. If the prompt can early-exit (e.g. "if list is empty, stop") the runtime can complete the workflow without ever invoking the model, producing zero-turn rows in Agent Runs.
- `defineSchedule({ cron, async run({ receive, waitUntil, appAuth }) { ... } })` — handler-based. The handler decides what to do and hands off to a channel via `receive(channel, { message, args, auth })`. Always produces a real turn with proper Trigger attribution.

Use markdown when the schedule unconditionally fires one tool ("poll watches every minute"). Use handlers when there's branching, especially conditional early-exit, or when the output needs to land in a specific channel/thread.

## Observability

Vercel Observability → **Agent Runs** reads OTEL spans (`ash.turn` parent + `ai.streamText` / `ai.toolCall` children). Populated columns require:

1. **`agent/instrumentation.ts`** with `recordInputs: true` and `recordOutputs: true` (and optional `setup()` for additional exporters). Without this file, runs show only Duration — Tokens/Cost/Turns stay zero.
2. **Framework channels** (Slack, Twilio, Ash HTTP) — they emit the Trigger attribute the column displays. Custom channels need to do this themselves.
3. **All model calls inside the agent loop.** Calling AI Gateway directly from a channel handler before delegating to the agent creates spans outside `ash.turn` — visible in AI Gateway logs, invisible in Agent Runs. Promote that work to a tool the agent invokes.

See SKILL.md → *Observability* for example snippets and the rationale behind each rule.

## Deployment

Deploy to Vercel. `instrumentation.ts` wires OTel (e.g. `@vercel/otel`, `@braintrust/otel`). See https://ash.labs.vercel.dev/docs/vercel-deployment.

## When the docs and this file disagree

Trust the docs. Fetch the relevant page under `https://ash.labs.vercel.dev/docs/` and update this file if you find drift.
