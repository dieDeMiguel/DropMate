/**
 * `edit_group_card` — rewrite a previously-posted `/receive` card and
 * strip its inline keyboard.
 *
 * Thin agent-facing surface over the `editGroupCard` channel-layer
 * primitive from `lib/telegram-channel/notify.ts`. Two Bot API
 * round-trips happen under the hood: `editMessageText` (the visible
 * state change neighbours read) followed by `editMessageReplyMarkup`
 * (button strip so the same card can't be tapped twice).
 *
 * Used by the timeout schedules (#53):
 *
 *   - `reception_request_4h_timeout` — closes out group cards whose
 *     4h "can someone help?" window passed without anyone tapping
 *     [Ich kann helfen]. Replaces the card text with something like
 *     "⏰ Zeit abgelaufen, niemand konnte annehmen."
 *   - `reception_request_48h_timeout` — closes out `matched` cards
 *     whose volunteer accepted but no package actually arrived
 *     within 48h. The button is already stripped at accept time
 *     (slice #52), so this is purely a text replacement to
 *     "❌ Paket nie angekommen — abgelaufen.".
 *
 * Records created via the soft-deprecated DM-3-candidates path don't
 * have a `groupCardMessageId` — the schedule's markdown tells the
 * model to skip the edit step on those.
 *
 * If the Bot API call fails (message deleted by the user, chat lost,
 * permissions revoked), this tool throws. The schedule's prompt tells
 * the model to log the error and continue — the canonical state lives
 * in Redis, not in the Telegram message body, so a stale card is a
 * cosmetic regression, not a correctness one.
 *
 * No session auth — schedules run from cron, not a user message. The
 * tool reads `TELEGRAM_BOT_TOKEN` from env and throws clearly when
 * it's unset.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { editGroupCard } from "../../lib/telegram-channel/notify.js";

const inputSchema = z.object({
  chatId: z
    .number()
    .describe(
      "Telegram chat id of the group where the card was posted — the " +
        "`groupCardChatId` field returned by " +
        "`scan_due_unanswered_requests` or `scan_due_unfulfilled_requests`.",
    ),
  messageId: z
    .number()
    .int()
    .describe(
      "Telegram message id of the card to rewrite — the " +
        "`groupCardMessageId` field returned by the scan tools.",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "Replacement text for the card. Already-localised; the tool " +
        "sends it verbatim. Keep it short and matter-of-fact — e.g. " +
        '"⏰ Zeit abgelaufen, niemand konnte annehmen." or ' +
        '"❌ Paket nie angekommen — abgelaufen.".',
    ),
});

export default defineTool({
  description:
    "Rewrite a previously-posted `/receive` group card and strip its " +
    "inline keyboard. Use only from the `reception_request_4h_timeout` " +
    "and `reception_request_48h_timeout` schedules, and only on entries " +
    "whose `groupCardMessageId` is non-null (records on the " +
    "soft-deprecated DM-3-candidates path don't have a card to edit). " +
    "Throws when the Bot API rejects the edit (deleted message, lost " +
    "chat, etc.) — the schedule's prompt tells you to log the error " +
    "and move on, since the Redis record is the source of truth for " +
    "what the card SHOULD say.",
  inputSchema,
  async execute({ chatId, messageId, text }) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "edit_group_card: TELEGRAM_BOT_TOKEN is not set; cannot edit the group card.",
      );
    }
    await editGroupCard(token, chatId, messageId, text);
    return { edited: true };
  },
});
