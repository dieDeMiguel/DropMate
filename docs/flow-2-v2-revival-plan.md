# Flow 2 v2 — revival plan

Goal: ship the "I will receive a package but won't be at home, could someone please pick it up?" flow at last, by taking the structurally-correct v2 design out of PR limbo and verifying it end-to-end against the four failure modes that killed v1.

Success criterion (unchanged since #66): *when a resident posts that a package is coming and they won't be home, the application connects two people together — the one not going to be at home, and someone willing to help.*

## Two prior attempts

### Attempt 1 — `feat/receive-flow` / PR #54 (CLOSED 2026-05-19)

Multi-turn form-fill state machine: `/receive` slash + natural language + screenshot converged into a Q&A walking the requester through `carrier → tracking → window → confirm → group card`.

Tested live, broke four ways:

1. Flow 2 prompts leaking into the **group chat** (PRD §9 privacy violation).
2. **Duplicate bot replies** (2–3× per inbound).
3. **Ghost "Ich kann das Bild nicht direkt lesen" fallback** on text-only group messages.
4. **Stuck mid-form-fill** — conversations never reached `create_reception_request`.

Six follow-up bug tickets (#55, #56, #57, #63, #64, #65) papered over symptoms. Closure note: *the shape was wrong, not the bugs*.

### Attempt 2 — `feat/flow-2-v2` / PR #70 (OPEN, stalled)

One-shot DM → neutral group card. Single LLM call extracts `carrier`, `expectedWindowStart/EndAt`, `absenceSignal` from the first message. No multi-turn state machine. Mirrors Flow 1's UX shape.

Four commits, 18 files, +2728 / −467, all green:

| Commit | Issue | Scope |
|---|---|---|
| `438bbe3` | #66 | Foundations — one-shot DM → neutral group card, schema deltas, instructions rewrite |
| `5030999` | #67 | Session-continuity port — `tg:<chatId>` unconditional continuation tokens |
| `16f7fca` | #68 | Volunteer accept loop — callback handler + `editGroupCard` primitive + `edit_group_card` tool + dual DMs |
| `3e797e0` | #69 | Screenshot entry — `parse_tracking_page` vision tool routing for DM photos |

Vitest 314/314, typecheck clean, preview deploy green. **NOT live-verified.** Every issue closure note says "code-side done — live test deferred to operator". So Attempt 2 isn't failed — it's stalled.

## Why v2's shape is right

| | v1 (form-fill) | v2 (one-shot) |
|---|---|---|
| User turns | 3–4 | 1 |
| Bot state | Multi-step machine | Stateless extraction |
| Missing fields | Ask one by one | Post card without them |
| Failure surface | Each turn can break | Single point (extraction) |
| Group-leak risk | High (per-step prompts) | None (only neutral card posts to group) |
| Mirrors Flow 1? | No | Yes |

Each v1 failure is structurally prevented by v2's shape: no form → no group-leaking form prompts; no state → nothing to dupe-replay; no photo branch in the requester text path → no ghost-photo fallback; no form → can't stall in one.

## What the framework knowledge adds

Three deltas the `use-ash` + `ash-agent` skills surfaced. None of these block v2's ship; they're observability polish that lands separately.

1. **`parse_label` should be agent-invoked, not channel-handler-invoked** (#79 open). v2's `parse_tracking_page` follows the canonical shape; `parse_label` doesn't yet.
2. **Reception timeouts (4h/48h) are markdown schedules** (#76 open). Handler-pattern refactor.
3. **Callback-driven runs lack `trigger` attribution** (#74 open). Volunteer-tap `ash.turn` shows "Unknown" in Agent Runs.

## Plan

### Phase A — Framework audit (read-only, on the v2 branch)

Goal: confirm v2 doesn't carry a hidden anti-pattern from v1 into prod.

- [ ] `lib/telegram-channel/process-update.ts` on v2 — channel handler does NOT call an LLM directly. All vision work is in `agent/tools/parse_tracking_page.ts` / `parse_label.ts`, invoked from inside `ash.turn`.
- [ ] `agent/tools/create_reception_request.ts` — server-builds the card text. Model never writes the card body. Confirms the "model invents German John-Doe holder placeholder" failure class (#43) stays dead.
- [ ] `agent/instructions.md` Flow 2 stanza — explicit "do NOT call `post_to_group` anywhere in Flow 2".
- [ ] Test placement — every `.test.ts` lives in `tests/**` or `lib/**`, never in `agent/tools/`, `agent/hooks/`, `agent/channels/`, `agent/schedules/`, `agent/subagents/`.
- [ ] Session continuity — `tg:<chatId>` is the unconditional continuation token (#67 port).
- [ ] `agent/instrumentation.ts` — `registerOTel` in `setup`, present on main, brought along by the rebase.

Phase A is read-only. If anything fails the audit, file a targeted bug ticket and ralph it before Phase B.

### Phase B — Rebase + ship to prod

`feat/flow-2-v2` is behind `main` by PRs #80 (observability alignment), #83 (ash-agent skill install), #84 (registerOTel fix). Rebase consolidates everything into one production deploy.

```bash
git checkout feat/flow-2-v2
git fetch origin
git rebase origin/main
# Resolve conflicts; expect collisions in:
#   - lib/telegram-channel/process-update.ts  (v2 + observability touched the same file)
#   - agent/instructions.md                    (v2 + #80 both rewrote sections)
git push --force-with-lease origin feat/flow-2-v2
```

Then deploy via `vercel --prod` from the rebased branch. PR #70 stays open as the merge target after live verification passes.

Decision point: deploy `vercel --prod` from the branch directly (faster trace-grabbing on real prod traffic, no merge gate), or run live verification on the preview URL first and only ship to prod after Phase C clears. The user's stated preference is direct-to-prod via `vercel --prod`. Recording it here so the choice is explicit.

### Phase C — Live verification (Traces A–E from PR #70)

For each trace: do the action, then check (1) the Telegram side did the right thing, (2) Agent Runs shows a populated row, (3) the four v1 failure modes don't recur.

- **Trace A — natural-language DM.** Registered DE-speaking resident DMs `Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause`. Expected: DE DM ack + neutral group card `📦 DHL-Paket erwartet morgen 14:00–16:00. Kann jemand annehmen?` with `[Ich kann helfen]`. **Watch:** no requester name on card, no absence wording, no duplicate replies.
- **Trace B — volunteer tap (registered).** A second registered resident on the same street taps `[Ich kann helfen]`. Expected: card edits to `✅ angenommen von <Name>` via `text_mention`, button stripped, volunteer DM'd with operational handoff, requester DM'd with the named volunteer.
- **Trace C — volunteer tap (unregistered).** Non-resident taps. Expected: ephemeral toast `Bitte zuerst /register`, button stays on card.
- **Trace D — screenshot entry.** Registered DM-er sends DHL tracking-page screenshot. Expected: vision extracts carrier + window, posts group card. Low-confidence → confirmation prompt first.
- **Trace E — Vercel logs.** Confirm no `[ash:channel.send] deliver failed, starting new session` lines on any webhook (session-continuity fix).

Cross-cutting checks:

- [ ] Group never receives Flow 2 prompts (PRD §9 holds).
- [ ] No multi-turn Q&A on the requester side.
- [ ] No duplicate bot messages.
- [ ] No ghost-photo fallback on text-only messages.
- [ ] `Ein Paket kommt heute` (no absence signal) → Flow 0 silent ack, NO group card.

### Phase D — Triage & merge

For each regression found in Phase C: file targeted bug ticket, ralph it AFK, re-verify the failing trace. Bar = the four v1 failures don't recur, not zero new bugs ever.

When Phase C is clean, merge PR #70. Close #66, #67, #68, #69.

### Phase E — Post-ship observability polish

Parked, deliberately not bundled into v2's ship:

- **#79** — promote `parse_label` to an agent-invoked tool (matches `parse_tracking_page`'s shape now).
- **#76** — refactor `reception_request_4h_timeout` + `reception_request_48h_timeout` to handler-based schedules.
- **#74** — emit `trigger` attribute on the volunteer-tap callback `ash.turn`.

These don't change product behaviour. They populate the Trigger column and surface the callback-driven turn in Agent Runs. Pick them up once Vercel turns on `enable-agent-runs-observability` (#82).

## Open decisions

1. **Direct-to-prod vs preview-first.** Current call: rebase, `vercel --prod`, run Phase C against the production URL. Alternative: run Phase C on the preview URL first, only promote to prod after sign-off. Direct-to-prod gets real traces faster but has no undo besides rollback.
2. **Phase A audit depth.** Read-only inspection of six points above. If any fail, hold Phase B until they're fixed — do NOT ship a flow with a known anti-pattern.
3. **Rollback plan.** If Phase C surfaces something v1-class, `vercel rollback` to the pre-v2 production deployment. Don't try to live-fix from prod.
