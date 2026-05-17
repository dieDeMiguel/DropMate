/**
 * 4h "no volunteer accepted" reception-request timeout schedule.
 *
 * Cron `*\/15 * * * *` — fires every 15 minutes. A 4h SLA needs fine
 * granularity; hourly would skew the worst-case wait to almost 5h. Six
 * minute on the cron is at :00 / :15 / :30 / :45 — the issue spec named
 * these exact minutes, so we don't nudge for cache-window politeness.
 *
 * Scans every open `ReceptionRequest`, finds the ones older than 4h
 * with no volunteer, DMs the requester that no match was found, then
 * flips status to `"expired"`.
 *
 * No `channel:` field — schedules with a channel send the agent's
 * final stream to one chat; we fan out to many requesters, which only
 * works via tool calls.
 *
 * See PRD-ASH §7 + issue #40.
 */

import { defineSchedule } from "experimental-ash/schedules";

export default defineSchedule({
  cron: "*/15 * * * *",
  markdown: `
You are the **4h reception-request timeout** cron for DropMate. Your
only job is to expire reception requests that have been waiting more
than 4 hours without a volunteer accepting.

Procedure — follow exactly, no creative liberties:

1. Call \`scan_due_unanswered_requests\` with no arguments. It returns
   \`{ entries, now }\`. Each entry is one open request that has aged
   past the 4h SLA, with the requester resident summary pre-resolved.
2. If \`entries\` is empty, stop. Do not post anything.
3. For each entry in \`entries\`:
   a. If \`entry.requester\` is non-null, call \`notify_recipient\`
      with \`recipientResidentId: entry.requester.id\` and a short DM
      in \`entry.requester.language ?? "de"\` letting them know no
      neighbor was available to receive the package. Mention the
      carrier (\`entry.carrier\`) if it isn't \`"unknown"\`. Tone:
      apologetic but matter-of-fact, one sentence. Suggest they DM
      again if they want to retry. Example (de):

          "Leider hat sich kein Nachbar für dein DHL-Paket gefunden —
          schreib mir wieder, wenn du es nochmal versuchen möchtest."

   b. Call \`mark_reception_request_expired\` with
      \`requestId: entry.requestId\`. Order matters — DM first, then
      expire, so a mid-run crash leaves the requester informed rather
      than silently flipping records.
4. Never post to the group from this schedule. Reception requests are
   strictly private (PRD §9).
5. If any tool call throws, log it in your final reply and move on to
   the next entry. Don't let one bad request poison the rest.

Output a single short summary line at the end ("expired N requests")
so the schedule log is scannable. No other free-text.
`.trim(),
});
