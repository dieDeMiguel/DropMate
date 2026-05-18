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
  sendTelegramMessage,
  type InlineKeyboardMarkup,
  type TelegramMessageEntity,
} from "./send.js";
import type { Resident } from "../redis.js";

export async function dmResident(
  token: string,
  resident: Resident,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  await sendTelegramMessage(
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
): Promise<void> {
  await sendTelegramMessage(token, groupChatId, text, replyMarkup, entities);
}
