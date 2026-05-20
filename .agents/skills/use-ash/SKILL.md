---
name: use-ash
description: DropMate-specific Ash overlay. Use ALONGSIDE the upstream `ash-agent` skill — covers the test-placement gotcha (fatal `ash build` error), the Vercel Agent Runs observability wire-up (registerOTel + feature flag), and Telegram channel notes. Trigger on the same conditions as ash-agent (any task involving `experimental-ash`, `agent/` slots, or Ash CLI).
---

# Use Ash — DropMate overlay

> **Read [`ash-agent`](../ash-agent/SKILL.md) first.** That's the canonical guide maintained by the Ash team and synced via `skills-lock.json`. This file only documents DropMate-specific deltas or lessons learned the hard way that aren't yet upstream.

## Test placement (hard requirement, not a style preference)

**Never put `.test.ts` files inside `agent/tools/`, `agent/hooks/`, `agent/channels/`, `agent/schedules/`, or `agent/subagents/`.** Discovery treats every `.ts` file in those slots as a tool/hook/channel source and uses the file stem as the runtime slug. The slug validator rejects dots, so `register_package.test.ts` → slug `register_package.test` → **fatal `ash build` error**:

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

**Safe vs. unsafe:**
- ✅ `lib/foo.test.ts` — `lib/` at the repo root is not an Ash-scanned slot
- ✅ `agent/agent.test.ts` — `agent.test.ts` doesn't match the `agent.ts` slot pattern, silently ignored
- ✅ `tests/**/*.test.ts` — outside all slots
- ❌ `agent/tools/foo.test.ts` — fatal slug validation error
- ❌ `agent/hooks/foo.test.ts` — same, and `hooks/` walks recursively so `agent/hooks/__tests__/` doesn't help either
- ❌ `agent/tools/__tests__/` — slug validation still rejects `__tests__` (starts with underscore, not a letter)

**Dynamic import paths in moved tests:** `await import("./foo.js")` becomes `await import("../../agent/tools/foo.js")`. The `"../../lib/redis.js"` mocks usually survive verbatim because both `agent/tools/` and `tests/tools/` sit 2 levels below the repo root.

## Vercel Agent Runs observability — wire-up

Two preconditions for the Agent Runs tab to populate Trigger / Tokens / Cost / Turns columns. Code-side fix alone is not enough.

### 1. `agent/instrumentation.ts` MUST call `registerOTel`

Without `registerOTel` in `setup`, AI SDK records spans in memory but nothing exports them to Vercel's ingestion pipeline. `recordInputs` / `recordOutputs` only tune *what* gets recorded — they don't wire transport.

Minimum viable file:

```ts
import { defineInstrumentation } from "experimental-ash/instrumentation";
import { registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  recordInputs: true,
  recordOutputs: true,
  metadata: { "vercel.env": process.env.VERCEL_ENV ?? "" },
  setup: ({ agentName }) => registerOTel({ serviceName: agentName }),
});
```

`agentName` comes from the `setup` callback argument — never hard-code a service name. `@vercel/otel` is a **runtime** dependency (`pnpm add @vercel/otel`), not devDependency. Canonical internal agents (d0, vi, help-ash) gate `registerOTel` behind `BRAINTRUST_API_KEY` — that gate is for the Braintrust *exporter*, not for OTEL itself. Default to ungated.

### 2. The `enable-agent-runs-observability` feature flag

Per the Ash team's Slack channel: even with correctly-wired `instrumentation.ts`, the **Agent Runs UI stays empty until the account is flagged in**. Request via the Ash Slack with team slug + project name. Code-side fix without the flag = invisible.

## Schedule + channel patterns that affect what shows in Agent Runs

Two related patterns lifted from `internal-agents/agents/*` — both shape the row volume and attribution in the UI:

- **Prefer handler-based schedules** (`async run({ receive, waitUntil, appAuth })` calling `receive(channel, { ... })`) over fire-and-forget `defineSchedule({ markdown })`. Markdown schedules with conditional early-exit produce zero-turn rows that dominate the view; handler schedules only invoke the agent when there's real work.
- **Anti-pattern: AI calls from inside a channel handler before delegating to the agent.** Those calls land outside the `ash.turn` span — visible in AI Gateway logs, invisible in Agent Runs. Promote that work into a tool the agent invokes.

## DropMate-specific gotchas

- **Telegram webhook `allowed_updates`** must include `callback_query` — otherwise every button tap is silently dropped by the Bot API before reaching the channel. See `memory/telegram_webhook_allowed_updates.md`.
