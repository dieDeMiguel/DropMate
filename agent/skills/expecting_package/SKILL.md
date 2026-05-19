---
description: Load when a candidate neighbour replies to a reception request with "ja, ich kann das annehmen" / "yes, I can be in" / "until 6pm". The REQUESTER side of this skill (someone DMing the bot that they won't be home) is now handled by Flow 2 v2 in agent/instructions.md — one-shot DM → neutral group card. Don't drive the multi-turn DM-3 requester flow from this skill anymore.
---

# Expecting package (volunteer path only)

The "I won't be home" flow has split into two halves. The requester
half — someone DMing the bot that they're expecting a package and
won't be home — is now Flow 2 v2 (one-shot: extract carrier + window +
absence signal, post a neutral group card with `[Ich kann helfen]`,
DM the requester an ack). That logic lives in `agent/instructions.md`
under "Flow 2 — 'I won't be home' (reception request, one-shot)" and
in the `create_reception_request` tool. Do not re-implement it here.

The volunteer half — someone replying "yes I can take it" — still
needs a procedure, so the volunteer branch stays in this skill.

## Privacy rule (still applies)

Per PRD §9, "I'm not home" messages are never posted to the group.
The neutral group card the requester flow posts NEVER names the
requester or states their absence. Do not call `post_to_group`
anywhere in this skill.

## Volunteer path — "ja, ich kann das annehmen"

Trigger: a DM reply from a candidate, OR (downstream) a synthetic
button-tap message with `action=accept_reception_group` /
`action=accept_reception_request`. Examples of the DM trigger:

- "Ja, ich bin bis 15 Uhr da."
- "Yes, I can take it — I'm in until 6pm."
- "Klar, ich bin den ganzen Nachmittag zuhause."

### Step 1 — extract the availability window

The volunteer's free-text window ("bis 15 Uhr", "until 6pm", "all
afternoon"). Pass it through to the tool verbatim — the requester reads
it as the volunteer's own words.

### Step 2 — call `accept_reception_request`

- `availability`: the extracted window.
- omit `requestId` — the tool will pick the most recent open request
  on the volunteer's street where the volunteer is a candidate. Only
  pass an explicit `requestId` if the volunteer references one
  specifically (rare today, and natural to pass when handling a
  button-tap synthetic message that names the id).

If the tool throws "no open reception request", the volunteer
responded to something that no longer matches — apologise briefly
and stop.

### Step 3 — DM the requester via `notify_recipient`

The tool returned `requester: { id, name, houseNumber, language }`.
Use `requester.id` and write the text in `requester.language`.
Substitute the volunteer's real name + house number from session
auth. Example (de):

> "<volunteer-name> (Hs.<volunteer-house>) kann dein Paket annehmen —
> sie ist bis 15 Uhr da."

### Step 4 — short acknowledgement to the volunteer

One sentence in the volunteer's own language naming the actual
requester from the tool result. Example shape: "Danke! Ich habe
<requester-name> Bescheid gegeben." That's it.

## Soft-deprecated DM-3 requester branch

The OLD requester path (`find_available_neighbors` → DM 3 candidates
individually → `create_reception_request` with `candidateResidentIds`)
is no longer the default and should not be triggered from a fresh
inbound DM. The `create_reception_request` tool still accepts
`candidateResidentIds` so legacy callers continue to work, but the
agent should NOT drive that branch for a new requester turn — Flow 2
v2 in `agent/instructions.md` is authoritative.

The DM-3 path stays in the tool surface so the 4h / 48h timeout
schedules and any in-flight legacy records keep functioning. New
work in this iteration's branch shouldn't write fresh records via
the DM-3 path.

## What this skill does NOT do

- It does not write the eventual Package record. That happens when
  the volunteer actually receives the package and `register_package`
  fires. `register_package` detects matching open / matched requests
  on the recipient's name + house number, flips the request to
  `"fulfilled"`, links the new Package via `receptionRequestId`, and
  returns a `receptionRequestFulfilled` block so the model can DM
  the requester the holder's location.
- It does not handle the 4h-no-response or 48h-no-arrival timeouts.
  Those are cron-driven schedules (`reception_request_4h_timeout`,
  `reception_request_48h_timeout`).
- It does not post to the group, ever. See the privacy rule above.
