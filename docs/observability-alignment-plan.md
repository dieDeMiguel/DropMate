# DropMate ↔ canonical Ash alignment plan

Goal: get DropMate's Vercel Observability → Agent Runs view to tell the whole story (Trigger, Tokens, Cost, Turns all populated for every interaction), and bring repo structure in line with the patterns used by every other Ash agent in `internal-agents/agents/*`.

Comparison baseline: `internal-agents/agents/{d0, vi, sre, help-ash, penny, recon, g0}` — twelve shipping agents, all using the same conventions.

## What's broken today

Symptoms in the Agent Runs view (Production, last 12h, all envs):

- 25 `workflowEntry` rows.
- Trigger column: `—` everywhere.
- Input / Output / Tokens / Cost / Turns: all `0`.
- Duration: populated (3–12s, occasional 0ms).

Three independent causes stacked:

1. **No `agent/instrumentation.ts`.** Without `recordInputs`/`recordOutputs`, Vercel's collector records the `ash.turn` parent span but doesn't capture AI-SDK usage data, so token/cost columns are empty by design.
2. **Five markdown schedules early-exit on empty work.** The `*/15` reception-timeout cron etc. instruct the model "if entries is empty, stop" — when the scan returns nothing the workflow completes without a model call. Real behaviour, but it dominates the row count.
3. **Custom Telegram channel does pre-turn AI work and lacks trigger attribution.** `lib/telegram-channel/process-update.ts` calls `parseLabel` (Gemma → Claude fallback via Vercel AI Gateway) *before* handing the synthetic text to the agent. Those model calls land outside `ash.turn` and never appear in Agent Runs. The custom channel also doesn't emit a Trigger attribute.

## Target state

Architecturally, the canonical agents look like this:

```
agent/
  agent.ts
  instructions.md
  instrumentation.ts          ← every production agent has one
  channels/
    slack.ts                  ← one-liner using framework adapter
    twilio.ts                 ← one-liner using framework adapter
  schedules/
    daily-digest.ts           ← async run({ receive, waitUntil, appAuth })
  tools/
    ...                       ← all model-invoking work lives here
```

No custom channel implementations exist in any of the 12 reference agents. No fire-and-forget markdown schedules with branching. No model calls outside the agent loop.

## Migration — three phases, ordered by ROI

### Phase 1 — instrumentation file (today, 5 min, biggest visible win)

**Why first:** populates Tokens/Cost/Turns columns for *all existing infrastructure* with zero code changes elsewhere. The data already exists in spans; we're just telling Vercel to record it.

**Action:**

1. Create `agent/instrumentation.ts`:

   ```ts
   import { defineInstrumentation } from "experimental-ash/instrumentation";

   export default defineInstrumentation({
     recordInputs: true,
     recordOutputs: true,
     metadata: { "vercel.env": process.env.VERCEL_ENV ?? "" },
   });
   ```

2. Deploy to Production.
3. Open Agent Runs in 5 minutes — schedule rows will still be zero-turn (they don't call the model), but any real Telegram-driven turn should now show non-zero Input/Output/Cost.

**No Braintrust setup yet** — defer until the team decides whether to dual-export. The minimal file is enough to fix the demo.

**Validation:** trigger one DM that requires the model (not a button tap that short-circuits) and verify the resulting row has Turns ≥ 1 and non-zero Tokens.

### Phase 2 — trigger labelling on the custom Telegram channel (pre-demo, 15–30 min)

**Why next:** ends the `—` mystery in the Trigger column without requiring a full channel rewrite. Buys time for Phase 3.

**Action:** in `lib/telegram-channel/process-update.ts`, when wrapping the agent call with `runWithTrace`, attach a `trigger: "telegram"` (or finer-grained `"telegram-message"` / `"telegram-callback"` / `"telegram-photo"`) attribute on the parent span. Verify against Ash's attribute conventions — fetch `https://ash.labs.vercel.dev/docs/observability` for the exact key name before guessing.

**Validation:** real DM turns in Agent Runs show `telegram` (or chosen value) in the Trigger column.

### Phase 3 — convert schedules to handler-based, gate on real work (post-demo, ~1 day)

**Why:** halves the row noise. Today's 25 rows are mostly cron beats with no work — they hide the handful of real interactions. With handler schedules, the cron is silent when there's nothing to do; rows only appear when a real reception request is being timed out.

**Action:** for each schedule under `agent/schedules/`:

1. Move the "scan for due work" call from the markdown to the handler's `run()` body (it becomes a plain function call, no LLM needed).
2. If `entries.length === 0`, return — no agent invocation, no row.
3. If there's work, `receive(channel, { message: <per-entry instructions>, args: {...}, auth: appAuth })` once per entry (or once with a digest message), as in `agents/d0/agent/schedules/daily-slack-digest.ts`.

**Catch:** the current schedules have no associated channel — DropMate's `agent/channels/` has `ash.ts` (built-in) and `telegram.ts` (custom). The handler can either receive into the custom Telegram channel (preferred, matches user-facing flow) or just call tools directly without a channel handoff. The first option is what d0 does with Slack and is what makes the resulting rows demo-worthy.

**Validation:** between cron fires with no work, the Agent Runs row count stops growing. When a real 4h-aged request exists, exactly one row appears with non-zero turns and proper Trigger.

### Phase 4 — Telegram channel migration (next sprint, ~2–3 days)

**Why:** removes the custom-channel exception. Aligns DropMate with every other agent's channel-as-data convention. Also unlocks consistent telemetry without manual trace plumbing.

**Action:**

1. Replace `lib/telegram-channel/{verify,inbound,outbound,send,process-update,factory}.ts` with a thin wrapper around `@chat-adapter/telegram` (already in `package.json`).
2. Model the wrapper on `agents/d0/agent/lib/channels/d0-slack-adapter.ts` — adapter wraps an `experimental-ash/channels` primitive, channel file exports a one-liner factory call.
3. The new `agent/channels/telegram.ts` should look like:

   ```ts
   import { telegramChannel } from "../../lib/channels/telegram-adapter.js";
   export default telegramChannel({
     token: process.env.TELEGRAM_BOT_TOKEN!,
     webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
   });
   ```
4. Migrate tests in `lib/telegram-channel/__tests__/` to cover the adapter, not the hand-rolled pipeline.

**Risk:** the photo / callback-query paths have non-trivial logic (label parsing, keyboard stripping, recipient gating). Audit `@chat-adapter/telegram`'s extension points before committing. If it doesn't support what's needed, this phase becomes "contribute upstream" rather than "delete custom code".

### Phase 5 — promote `parseLabel` into a tool (with Phase 4 or right after)

**Why:** the photo-parsing model call is the single biggest hidden-spend leak today — it runs through Vercel AI Gateway from inside the channel handler, so it shows in AI Gateway logs but not in Agent Runs. Promoting it to a tool means every Telegram interaction's full cost rolls up under one `ash.turn`.

**Action:**

1. Move `agent/tools/parse_label.ts` body to be invoked by the model, not pre-called by `process-update.ts`.
2. When the channel sees a photo, hand it to the agent as a `FilePart` (or as a structured "photo received" message) and let the model decide to call `parse_label`. Vision happens inside a tool call → `ai.toolCall` span → child of `ash.turn` → fully attributed.
3. The previous failure mode (Gemini Flash hallucinating "I cannot read images") was the *reason* for the pre-call. Re-test under the current Gemini model — if it still hallucinates, configure the model on `parse_label` to be the vision-capable one and have the conversational agent invoke it explicitly, rather than working around the limitation in the channel.

**Validation:** an inbound photo produces an Agent Runs row with `parse_label` listed in the run detail's Tool Calls panel, non-zero token spend, and a single end-to-end trace from webhook to reply.

## Definition of done

The repo is "aligned" when:

- [ ] `agent/instrumentation.ts` exists and exports `defineInstrumentation({ recordInputs: true, recordOutputs: true })`.
- [ ] Every Agent Runs row has a non-`—` Trigger value.
- [ ] Schedule rows only exist when the schedule actually invoked the model.
- [ ] `lib/telegram-channel/` is either gone or reduced to a thin adapter wrapping `@chat-adapter/telegram`.
- [ ] No tool-equivalent work (vision, classification, extraction) happens outside an Ash tool invocation.
- [ ] The Run detail page for any user-facing Telegram interaction shows the full chain: instructions → tools called → tokens per step → final message.

## Open questions

- Is there a Vercel Observability filter today that hides zero-turn schedule rows? If yes, Phase 3 is lower priority — we'd just save a saved view and move on.
- Does `@chat-adapter/telegram` support button-tap callback queries with the "ack + strip keyboard + route to model" semantics DropMate needs? Confirm before committing to Phase 4.
- Should the Braintrust exporter (`@braintrust/otel`) be wired in Phase 1 already, or is Vercel's native ingestion enough for the team's needs?
