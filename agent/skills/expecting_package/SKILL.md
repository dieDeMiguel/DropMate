---
description: Reference for Flow 2 — the "I won't be home" reception-request flow. As of v2.1 #96, every Flow 2 side effect (classify, write request, post card, flip status, edit card, AND the two volunteer-accept confirmation DMs) is handled by the channel layer in lib/telegram-channel/process-update.ts. This skill exists only as a pointer to the synthetics the agent receives; the procedural detail lives in agent/instructions.md under "Flow 2".
---

# Flow 2 — reception request (channel-driven)

Flow 2 is fully implemented in the channel layer. The agent's job
is to react to one of two synthetic messages and emit a DM in the
requester's language.

Authoritative procedure lives in `agent/instructions.md` under
"Flow 2 — 'I won't be home' (reception request, channel-driven)".
This skill is intentionally short — there is no multi-turn logic
left to load.

## Synthetics the channel emits

- `[FLOW_2 DONE language=<lang>]` — request written + card posted.
  Reply to the requester with ONE short ack sentence in `<lang>`
  confirming the group was asked. Do NOT mention the carrier,
  date, or window. Do NOT include 📦. Do NOT repeat the card
  text. See the four worked examples in `agent/instructions.md`
  Flow 2 stanza for the exact ack shape per language.
- `[VISION_LOW_CONFIDENCE language=<lang>] …` — DM-photo path
  couldn't extract enough fields. Ask the requester in `<lang>` to
  retry via `/receive`.

The volunteer-accept tap (`[Ich kann helfen]`) is fully
channel-driven: the channel writes both confirmation DMs
deterministically from localised templates. The agent is NOT
invoked on that path and there is no synthetic to handle. If a
stale legacy `[button-tap] accept_reception_*` callback ever
arrives (delivered by Telegram from an old keyboard sitting in a
stale chat), apologise briefly in the tapper's language and ask
them to retry. Do NOT call any tools.

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
