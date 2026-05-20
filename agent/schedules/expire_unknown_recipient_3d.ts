/**
 * 3-day auto-expiry schedule for held packages whose recipient was
 * never identified.
 *
 * Cron `15 * * * *` — fires hourly at :15, staggered from the
 * `reminder_48h` schedule (`:00`) and `escalate_7d` (every 6h on the
 * hour) so the three crons don't race for Redis on the same minute.
 *
 * Scans every Package, finds the ones held > 3 days with
 * `recipientResidentId === null` and a `recipientResolutionDeadline`
 * that has elapsed, DMs the holder a short heads-up, then hard-deletes
 * the record so future scans don't keep tripping over it.
 *
 * No `channel:` field — schedules with a channel send the agent's
 * final stream output to one chat. We need to fan out a DM per
 * unresolved package, which only works via tool calls. The schedule's
 * agent drives Telegram sends via `notify_recipient`, not via the
 * schedule's channel delivery.
 *
 * See issue #46.
 */

import { defineSchedule } from "experimental-ash/schedules";

export default defineSchedule({
  cron: "15 * * * *",
  markdown: `
You are the **3d unknown-recipient expiry** cron for DropMate. Your
only job is to clean up held packages whose recipient was never
identified, 3 days after registration.

Procedure — follow exactly, no creative liberties:

1. Call \`scan_unresolved_recipient_packages\` with no arguments. It
   returns \`{ entries, now }\`. Each entry is one held package whose
   3-day resolution deadline has elapsed without anyone identifying
   the recipient, with the holder summary pre-resolved.
2. If \`entries\` is empty, stop. Do not post anything.
3. For each entry in \`entries\`:
   a. If \`entry.holder\` is non-null, call \`notify_recipient\` with
      \`recipientResidentId: entry.holder.id\` and a short DM in
      \`entry.holder.language ?? "de"\` letting them know the entry
      for the package addressed to \`entry.recipientName\`
      (Hs.\`entry.recipientHouseNumber\`, carrier \`entry.carrier\`)
      was auto-removed because nobody identified the recipient in
      3 days. Tell them to re-register the package if and when the
      recipient surfaces. Keep it warm and one or two sentences.
   b. Call \`delete_package\` with \`packageId: entry.packageId\`.
4. Never post to the group from this schedule. The DM to the holder
   is the only outbound message; the recipient (by definition
   unknown) cannot be reached.
5. If any tool call throws, log it in your final reply and move to
   the next entry. Don't let one bad package skip the rest.

Output a single short summary line at the end ("expired N unresolved
packages") so the schedule log is scannable. No other free-text.
`.trim(),
});
