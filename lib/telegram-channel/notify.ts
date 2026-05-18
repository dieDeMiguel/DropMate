/**
 * Outbound notification primitives — the seam between tool calls
 * (`notify_recipient`, `post_to_group`) and the `sendTelegramMessage`
 * Bot API wrapper.
 *
 * Three paths land here:
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
 *   - `editGroupCard(token, chatId, messageId, text, entities?)` —
 *     rewrites a previously-posted card and strips its keyboard. Used
 *     by the volunteer-accept flow (#52) to flip "Kann jemand
 *     annehmen?" → "✅ angenommen von <name>" with a `text_mention`
 *     pinging the volunteer, and by the timeout schedules (#53) to
 *     close out cards nobody acted on. Errors propagate so the caller
 *     can decide whether a failed edit (message deleted, chat lost)
 *     should halt or just be logged.
 */

import {
  editMessageReplyMarkup,
  editMessageText,
} from "./keyboards.js";
import {
  sendTelegramMessage,
  type InlineKeyboardMarkup,
  type SendTelegramMessageResult,
  type TelegramMessageEntity,
} from "./send.js";
import type { Resident } from "../redis.js";

export async function dmResident(
  token: string,
  resident: Resident,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<SendTelegramMessageResult> {
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
): Promise<SendTelegramMessageResult> {
  return sendTelegramMessage(token, groupChatId, text, replyMarkup, entities);
}

/**
 * Rewrite a previously-posted group card and strip its inline keyboard.
 * Two Bot API round-trips: `editMessageText` first (the visible-state
 * change neighbours actually read), `editMessageReplyMarkup` second to
 * remove the button. If the text edit throws, the keyboard strip is
 * skipped — the caller's `try/catch` decides what to do about a
 * partial failure; either way the record's state on Redis is the
 * source of truth for what the card SHOULD say.
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
