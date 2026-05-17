/**
 * 48h reminder schedule.
 *
 * Cron `0 * * * *` — fires hourly. Scans every Package, finds the ones
 * that have been held for more than 48h without a reminder, and DMs the
 * holder + the recipient (when registered). Marks each `reminded: true`
 * so the next tick doesn't re-fire.
 *
 * No `channel:` field — schedules with a channel send the agent's
 * final stream output to one chat. We need to fan out to many chats
 * (holder + recipient per package, across all streets), which only
 * works via tool calls. The schedule's agent therefore drives Telegram
 * sends via `notify_recipient`, not via the schedule's channel
 * delivery.
 *
 * See PRD §7 "Package lifecycle (Redis + Ash schedules)".
 */

import { defineSchedule } from "experimental-ash/schedules";

export default defineSchedule({
  cron: "0 * * * *",
  markdown: `
You are the **48h reminder** cron for DropMate. Your only job is to
remind residents about packages that have been waiting more than 48h.

Procedure — follow exactly, no creative liberties:

1. Call \`scan_due_reminders\` with no arguments. It returns
   \`{ entries, now }\`. Each entry is one package that needs a
   reminder, with holder + recipient summaries pre-resolved.
2. If \`entries\` is empty, stop. Do not post anything.
3. For each entry in \`entries\`:
   a. If \`entry.recipient\` is non-null, call \`notify_recipient\`
      with \`recipientResidentId: entry.recipient.id\` and a short
      DM in \`entry.recipient.language ?? "de"\` telling them the
      package is still waiting at the holder
      (\`entry.holder.name\`, house \`entry.holder.houseNumber\`,
      floor and buzzer when set). Mention the carrier
      (\`entry.carrier\`). Keep it warm and one sentence.
   b. If \`entry.holder\` is non-null, call \`notify_recipient\`
      with \`recipientResidentId: entry.holder.id\` and a short DM
      in \`entry.holder.language ?? "de"\` reminding them they
      still have a package for \`entry.recipientName\`
      (Hs.\`entry.recipientHouseNumber\`, carrier
      \`entry.carrier\`). Acknowledge the reminder is automatic so
      they don't feel chased.
   c. Call \`mark_package_reminded\` with \`packageId: entry.packageId\`.
4. Never post to the group from this schedule. Reminders are private.
5. If any tool call throws, log it in your final reply and move to
   the next entry. Don't let one bad package skip the rest.

Output a single short summary line at the end ("reminded N packages")
so the schedule log is scannable. No other free-text.
`.trim(),
});
