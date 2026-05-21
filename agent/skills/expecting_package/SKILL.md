---
description: Reference for Flow 2 — the "I won't be home" reception-request flow. As of v2.1 Slice 5, every Flow 2 side effect (classify, write request, post card, flip status, edit card) is handled by the channel layer in lib/telegram-channel/process-update.ts. This skill exists only as a pointer to the synthetics the agent receives; the procedural detail lives in agent/instructions.md under "Flow 2".
---

# Flow 2 — reception request (channel-driven)

Flow 2 is fully implemented in the channel layer. The agent's job
is to react to one of four synthetic messages and emit DMs in the
right languages.

Authoritative procedure lives in `agent/instructions.md` under
"Flow 2 — 'I won't be home' (reception request, channel-driven)".
This skill is intentionally short — there is no multi-turn logic
left to load.

## Synthetics the channel emits

- `[FLOW_2 DONE language=<lang>]` — request written + card posted.
  Reply to the requester with ONE short ack sentence in `<lang>`.
- `[VISION_LOW_CONFIDENCE language=<lang>] …` — DM-photo path
  couldn't extract enough fields. Ask the requester in `<lang>` to
  retry via `/receive`.
- `[VOLUNTEER_ACCEPTED card_id=… volunteer={…} requester={…} …]` —
  a volunteer tapped `[Ich kann helfen]`. Emit TWO DMs in one turn
  (operational handoff to the volunteer + named confirmation to the
  requester) and nothing else.
- `[button-tap] … could not be processed` — channel-side accept
  errored. Apologise briefly in the tapper's language and ask them
  to retry. Do NOT call any tools.

## Privacy invariant (PRD §9)

- Never post a Flow 2 DM to the group.
- Never name the requester or state their absence in any group
  post.
- The neutral group card the channel posted is the only allowed
  public surface for the entire flow.

## Timeouts

Cron schedules (`reception_request_4h_timeout`,
`reception_request_48h_timeout`) handle the no-volunteer and
no-arrival paths. They run independently of the agent and use the
`editGroupCard` primitive to terminalise the card.
