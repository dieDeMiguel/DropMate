---
description: Load when a resident DMs the bot that they're expecting a package and won't be home — "ich erwarte morgen ein Paket und bin nicht da", "I'm expecting a delivery tomorrow but won't be in", "morgen kommt ein DHL aber ich bin nicht zuhause", or any language equivalent. Also load when a candidate neighbor replies to such a request with "ja, ich kann das annehmen" / "yes, I can be in" / "until 6pm".
---

# Expecting package (Flow 2a)

The "I won't be home" flow. Two roles share this skill: the **requester**
(the resident who pre-announces they're away) and the **volunteer** (a
candidate neighbor who replies yes).

## Privacy rule (the whole reason this is a DM-only flow)

Per PRD §9, "I'm not home" messages are NEVER posted to the group. The
group must not learn that a specific resident will be away from home.
All coordination here happens in private DMs. Do not call `post_to_group`
anywhere in this flow.

## Requester path — "I won't be home tomorrow"

Trigger: a DM that signals the resident is expecting a package and
won't be available to receive it. Examples:

- "Ich erwarte morgen ein DHL-Paket und bin nicht da."
- "I'm expecting a package tomorrow but won't be home — can you help?"
- "Morgen kommt ein Päckchen aber ich bin im Büro bis 18 Uhr."

### Step 1 — call `find_available_neighbors`

No arguments needed (defaults to 3 candidates). The caller is read from
session auth. The result has `candidates: [{ id, name, houseNumber,
availabilityPatterns }]` ordered by house-number proximity.

If `count === 0`, reply in the resident's language: "I couldn't find any
registered neighbors on your street yet — try asking in the group when
the package is closer to arriving." Stop. No reception request to
write.

### Step 2 — DM each candidate via `notify_recipient`

For each `candidate` returned by Step 1, call `notify_recipient` with:

- `recipientResidentId`: `candidate.id`
- `text`: a short ask in the **candidate's** language. The requester's
  name + house number + the carrier + the expected date are the only
  context. Substitute the real values from the tool result; never the
  placeholders below. Example (de):
  > "<requester-name> (Hs.<requester-house>) erwartet morgen ein
  > DHL-Paket und ist nicht zu Hause. Könntest du das Paket annehmen,
  > falls der Bote klingelt? Antworte mir kurz, ob es klappt und bis
  > wann du erreichbar bist."

Translate per-candidate. Don't batch.

### Step 3 — call `create_reception_request`

After the candidate DMs are out, write the request so volunteer replies
have something to claim. Pass:

- `expectedDate`: `"YYYY-MM-DD"` if the resident stated one
- `carrier`: from the request, default omit ("unknown")
- `notes`: any extra context the resident gave ("signature required",
  "Geburtstag von Mama")
- `candidateResidentIds`: the exact `id`s from Step 1's result

### Step 4 — confirm to the requester

Short DM in the requester's language naming the actual candidates from
Step 1's result (never the placeholders below). Example shape:
"I asked <candidate-a-name> (Hs.<candidate-a-house>) and
<candidate-b-name> (Hs.<candidate-b-house>) — I'll let you know as
soon as someone confirms." Name the candidates explicitly so the
requester knows who to expect a follow-up from.

## Volunteer path — "ja, ich kann das annehmen"

Trigger: a DM reply from a candidate. Examples:

- "Ja, ich bin bis 15 Uhr da."
- "Yes, I can take it — I'm in until 6pm."
- "Klar, ich bin den ganzen Nachmittag zuhause."

### Step 1 — extract the availability window

The volunteer's free-text window ("bis 15 Uhr", "until 6pm", "all
afternoon"). Pass it through to the tool verbatim — the requester reads
it as the volunteer's own words.

### Step 2 — call `accept_reception_request`

- `availability`: the extracted window
- omit `requestId` — the tool will pick the most recent open request on
  the volunteer's street where the volunteer is a candidate. Only pass
  an explicit `requestId` if the volunteer references one specifically
  (rare today).

If the tool throws "no open reception request", the volunteer responded
to something that no longer matches — apologise briefly and stop.

### Step 3 — DM the requester via `notify_recipient`

The tool returned `requester: { id, name, houseNumber, language }`. Use
`requester.id` and write the text in `requester.language`. Substitute
the volunteer's real name + house number from session auth; never the
placeholders below. Example (de):

> "<volunteer-name> (Hs.<volunteer-house>) kann morgen dein DHL-Paket
> annehmen — sie ist bis 15 Uhr da."

### Step 4 — short acknowledgement to the volunteer

One sentence in the volunteer's own language naming the actual
requester from the tool result (never the placeholder below). Example
shape: "Danke! Ich habe <requester-name> Bescheid gegeben." That's it.

## What this skill does NOT do

- It does not write the eventual Package record. That happens when the
  volunteer actually receives the package and the `register_package`
  flow runs. `register_package` now detects matching open / matched
  requests on the recipient's name + house number, flips the request
  to `"fulfilled"`, links the new Package via `receptionRequestId`,
  and returns a `receptionRequestFulfilled` block so the model can DM
  the requester the holder's location. See Flow 1 Step 5 in
  `agent/instructions.md` for the model-side procedure.
- It does not handle 4h-no-response timeouts. A future schedule (#25)
  will scan for stale open requests and DM the requester "no one was
  available." For now, the request just stays open.
- It does not post to the group, ever. See the privacy rule above.
