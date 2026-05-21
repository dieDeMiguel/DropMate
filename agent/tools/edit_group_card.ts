/**
 * `edit_group_card` — rewrite the body of a neutral Flow 2
 * reception-request group card and strip its inline keyboard.
 *
 * Thin wrapper over `editGroupCard` in `lib/telegram-channel/notify.ts`.
 * The channel layer's volunteer-accept callback handler now calls
 * `editGroupCard` directly without going through the agent (v2.1
 * Slice 4 / #89), so this tool is reserved for schedule contexts —
 * the 4h / 48h reception-request timeout schedules flip the card to
 * `"⏰ Zeit abgelaufen"` / `"❌ Paket nie angekommen"` when no
 * volunteer claimed it in time or when a matched request expired
 * without a Package arriving.
 *
 * Bot token comes from `TELEGRAM_BOT_TOKEN`; tool throws clearly if
 * unset rather than silently sending with `undefined`. The Bot API's
 * `editMessageText` will reject any attempt to edit a message older
 * than 48h with `400: Bad Request: message can't be edited` — that's
 * acceptable here because every consumer fires well within that
 * window.
 *
 * Why no `entities` arg yet: the two closing strings the schedules
 * produce ("⏰ Zeit abgelaufen", "❌ Paket nie angekommen") have no
 * `text_mention` target — nobody to ping.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { editGroupCard } from "../../lib/telegram-channel/notify.js";

const inputSchema = z.object({
  chatId: z
    .number()
    .int()
    .describe(
      "The chat id where the group card lives. Always negative for " +
        "supergroups (e.g. `-1001234567890`). Read from the relevant " +
        "ReceptionRequest's `groupCardChatId` field.",
    ),
  messageId: z
    .number()
    .int()
    .positive()
    .describe(
      "The Telegram `message_id` of the original card. Read from the " +
        "relevant ReceptionRequest's `groupCardMessageId` field.",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "Replacement body for the card. Keep it short; the language " +
        "should match what the card was originally posted in (German " +
        "for the MVP street). Examples: `✅ angenommen von <volunteer>` " +
        "(after accept), `⏰ Zeit abgelaufen, niemand konnte annehmen.` " +
        "(after the 4h timeout), `❌ Paket nie angekommen — abgelaufen.` " +
        "(after the 48h timeout). Substitute the actual volunteer name " +
        "where applicable — never emit the literal `<volunteer>` token.",
    ),
});

export default defineTool({
  description:
    "Rewrite the body of a neutral Flow 2 reception-request group card " +
    "and strip its inline keyboard so the `[Ich kann helfen]` button " +
    "can't be tapped again. Used by the 4h / 48h reception-request " +
    "timeout schedules to flip the card to '⏰ Zeit abgelaufen' or " +
    "'❌ Paket nie angekommen'. The `chatId` and `messageId` come from " +
    "the ReceptionRequest's `groupCardChatId` / `groupCardMessageId` " +
    "fields. Returns `{ edited: true }`.",
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
