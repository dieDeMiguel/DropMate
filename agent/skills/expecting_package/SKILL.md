---
description: Reference for Flow 2 — the "I won't be home" reception-request flow. As of v2.1 #100, every Flow 2 side effect (classify, write request, post card, flip status, edit card, the two volunteer-accept confirmation DMs, AND the requester-side ack DM and the photo low-confidence recovery prompt) is handled by the channel layer in lib/telegram-channel/. The agent is NOT invoked on any Flow 2 path. This skill exists only as a privacy reminder; there are no synthetics left to handle.
---

# Flow 2 — reception request (fully channel-driven)

Flow 2 is implemented end-to-end in the channel layer. The agent is
not invoked on this flow under any condition:

- Free-text DM ("Ich erwarte morgen DHL und bin nicht da") → channel
  classifies, writes the request, posts the group card, sends the ack
  DM. No agent turn.
- `/receive` slash → channel parses, writes the request, posts the
  group card, sends the ack DM. No agent turn.
- DM photo of a carrier tracking page → channel parses, decides
  (high confidence + absence signal → request + ack DM; anything
  else → recovery prompt DM pointing at `/receive`/`/register`). No
  agent turn either way.
- `[Ich kann helfen]` group tap → channel flips the request to
  `matched`, edits the card, sends both volunteer + requester DMs
  deterministically from localised templates. No agent turn.

If a stale legacy `[button-tap] accept_reception_*` callback ever
arrives (delivered by Telegram from an old keyboard sitting in a
stale chat), apologise briefly in the tapper's language and ask them
to retry. Do NOT call any tools.

If a raw text DM somehow slips past the channel's classifier and
looks like a Flow 2 trigger to you, do NOT post to the group, do NOT
write a request, do NOT call any Flow 2 tools — just answer the
caller in their language (typically: ask them to `/register` first).

## Privacy invariant (PRD §9)

- Never post a Flow 2 DM to the group.
- Never name the requester or state their absence in any group
  post.
- The neutral group card the channel posts is the only allowed
  public surface for the entire flow.

## Timeouts

Cron schedules (`reception_request_4h_timeout`,
`reception_request_48h_timeout`) handle the no-volunteer and
no-arrival paths. They run independently of the agent and use the
`editGroupCard` primitive to terminalise the card.
