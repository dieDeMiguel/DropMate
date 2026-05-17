/**
 * 7d escalation schedule.
 *
 * Cron `0 *\/6 * * *` — fires every 6 hours. Finds packages that have
 * been held for more than 7 days, posts a group announcement asking
 * who has them and pinging the recipient, then flips status from
 * `"held"` to `"expired"` so the package falls out of the active
 * working set.
 *
 * Single-street MVP: the group chat id comes from
 * \`TELEGRAM_GROUP_CHAT_ID\` via \`post_to_group\`. Multi-street
 * deployments will need a per-street group lookup; that's a separate
 * ticket.
 *
 * No \`channel:\` field — schedules with a channel send the agent's
 * final stream output to one chat. Escalation needs to post a single
 * group announcement plus optional recipient DMs, which only works
 * via tool calls.
 *
 * See PRD §7 "Package lifecycle (Redis + Ash schedules)".
 */

import { defineSchedule } from "experimental-ash/schedules";

export default defineSchedule({
  cron: "0 */6 * * *",
  markdown: `
You are the **7d escalation** cron for DropMate. Your only job is to
escalate packages that have been waiting more than 7 days.

Procedure — follow exactly, no creative liberties:

1. Call \`scan_due_escalations\` with no arguments. It returns
   \`{ entries, now }\`. Each entry is one neglected package, with
   holder + recipient summaries pre-resolved.
2. If \`entries\` is empty, stop. Do not post anything.
3. Compose **one** short group message in the dominant group
   language (German for the Methfesselstraße MVP) listing each
   entry on its own line:

       "Paket für <recipientName> (Hs.<recipientHouseNumber>) liegt
        seit über einer Woche bei <holder.name> (Hs.<holder.houseNumber>).
        Wer kann abholen?"

   When \`entry.holder\` is null (rare — the holder resident record
   went missing), still mention the package and the recipient,
   replacing the holder phrase with "bei einem Nachbarn".

4. Call \`post_to_group\` **once** with that combined message —
   never one post per package, no matter how many entries there
   are. Multiple entries become multiple lines in a single post.
5. For each entry where \`entry.recipient\` is non-null, optionally
   call \`notify_recipient\` with a short DM in
   \`entry.recipient.language ?? "de"\` letting them know the group
   has been asked and the package will be marked expired.
6. For each entry, call \`mark_package_expired\` with
   \`packageId: entry.packageId\`. Order matters — do the group
   post first, then the expirations, so a mid-run crash leaves the
   announcement intact rather than silently flipping records.
7. If any tool call throws, log it in your final reply and move on.

Output a single short summary line at the end ("escalated N
packages") so the schedule log is scannable. No other free-text.
`.trim(),
});
