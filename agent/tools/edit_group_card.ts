/**
 * `edit_group_card` — rewrite the body of the neutral group card
 * posted by `create_reception_request` and strip its inline keyboard.
 *
 * Thin wrapper over `editGroupCard` in `lib/telegram-channel/notify.ts`.
 * Two callers today:
 *
 *   - The Flow 2 v2 volunteer-accept callback path (#68). When a
 *     resident taps `[Ich kann helfen]`, the orchestrator instructs
 *     the agent to (a) call `accept_reception_request`, (b) call this
 *     tool with the response's `groupCardChatId`/`groupCardMessageId`
 *     and the new text `"✅ angenommen von <volunteer-name>"`.
 *   - The 4h / 48h reception-request timeout schedules (#53). Same
 *     primitive flips the card to `"⏰ Zeit abgelaufen"` /
 *     `"❌ Paket nie angekommen"` when no volunteer claimed it in time
 *     or when a matched request expired without a Package arriving.
 *
 * Bot token comes from `TELEGRAM_BOT_TOKEN`; tool throws clearly if
 * unset rather than silently sending with `undefined`. The Bot API's
 * `editMessageText` will reject any attempt to edit a message older
 * than 48h with `400: Bad Request: message can't be edited` — that's
 * acceptable here because every consumer fires well within that
 * window (the schedules use 4h / 48h thresholds; the accept callback
 * fires moments after the card was posted).
 *
 * Why no `entities` arg yet: the two closing strings the schedules
 * produce ("⏰ Zeit abgelaufen", "❌ Paket nie angekommen") have no
 * `text_mention` target — nobody to ping. The accept-flow path that
 * COULD use a `text_mention` over the volunteer's name lives in
 * `agent/instructions.md`'s Flow 2 procedure; if/when the agent
 * needs to surface a clickable name in the edited card, this tool's
 * input schema will gain an optional `mentions: { name, telegramUserId }[]`
 * field that pipes through `computeMentionEntities`. For now the
 * volunteer's name is plain text — the named confirmation DM to the
 * requester is where the `text_mention` lives.
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
        "supergroups (e.g. `-1001234567890`). Comes verbatim from a " +
        "previous `create_reception_request` response's `groupCard.chatId` " +
        "or `accept_reception_request` response's `groupCardChatId`.",
    ),
  messageId: z
    .number()
    .int()
    .positive()
    .describe(
      "The Telegram `message_id` of the original card. Comes verbatim " +
        "from `create_reception_request`'s `groupCard.messageId` or " +
        "`accept_reception_request`'s `groupCardMessageId`.",
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
    "Rewrite the body of the neutral group card posted by " +
    "`create_reception_request` and strip its inline keyboard so the " +
    "`[Ich kann helfen]` button can't be tapped again. Use after a " +
    "successful `accept_reception_request` call (flip to '✅ angenommen " +
    "von <volunteer-name>') or when a reception-request timeout fires " +
    "(flip to '⏰ Zeit abgelaufen' / '❌ Paket nie angekommen'). The " +
    "`chatId` and `messageId` come verbatim from the relevant response. " +
    "Returns `{ edited: true }`.",
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
