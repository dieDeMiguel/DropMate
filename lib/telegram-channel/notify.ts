/**
 * Outbound notification primitives — the seam between tool calls
 * (`notify_recipient`, `post_to_group`) and the `sendTelegramMessage`
 * Bot API wrapper.
 *
 * Two paths land here:
 *
 *   - `dmResident(token, resident, text)` — sends a 1:1 DM. Telegram
 *     1:1 chat ids are identical to the recipient's user id (already
 *     relied on by `process-update.ts` when resolving inbound sessions),
 *     so `Number(resident.platformId)` is the canonical chat id with no
 *     extra Redis lookup.
 *   - `postToGroup(token, groupChatId, text)` — posts to the street
 *     group. The group chat id is a numeric configuration value the
 *     caller (the tool) resolves from `TELEGRAM_GROUP_CHAT_ID` for the
 *     single-street MVP; a later ticket can swap this for a per-street
 *     Redis lookup without touching the helper.
 */

import {
  editMessageReplyMarkup,
  editMessageText,
} from "./keyboards.js";
import {
  sendTelegramMessage,
  type InlineKeyboardMarkup,
  type SendMessageResult,
  type TelegramMessageEntity,
} from "./send.js";
import type { Resident } from "../redis.js";

export async function dmResident(
  token: string,
  resident: Resident,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<SendMessageResult> {
  return sendTelegramMessage(
    token,
    Number(resident.platformId),
    text,
    replyMarkup,
  );
}

export async function postToGroup(
  token: string,
  groupChatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
  entities?: ReadonlyArray<TelegramMessageEntity>,
): Promise<SendMessageResult> {
  return sendTelegramMessage(token, groupChatId, text, replyMarkup, entities);
}

/**
 * Rewrite a neutral Flow 2 reception-request group card in place and
 * strip its inline keyboard so the `[Ich kann helfen]` button can't
 * be tapped twice.
 *
 * Two Bot API calls because Telegram exposes text + reply-markup edits
 * on separate endpoints — `editMessageText` rewrites the visible body
 * (and any `text_mention` entities) and `editMessageReplyMarkup`
 * removes the keyboard. The keyboard strip lands second so a partial
 * failure leaves the visible state correct (the card already reads
 * "✅ angenommen von …") even if the button stays attached.
 *
 * Used by:
 *   - the Flow 2 v2 volunteer-accept callback path (#68) — flips the
 *     card to "✅ angenommen von <volunteer>" and removes the button;
 *   - the 4h / 48h reception-request timeout schedules (#53, follow-on)
 *     — flips the card to "⏰ Zeit abgelaufen" or "❌ Paket nie
 *     angekommen" when no volunteer claimed it in time, or when a
 *     matched request expired without a Package showing up.
 */
export async function editGroupCard(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  entities?: ReadonlyArray<TelegramMessageEntity>,
): Promise<void> {
  await editMessageText(token, chatId, messageId, text, entities);
  await editMessageReplyMarkup(token, chatId, messageId);
}
