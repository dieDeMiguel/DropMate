/**
 * Inline-keyboard Bot API primitives — the three endpoints the
 * callback-query pipeline (#24) + Flow 2 v2 (#68) need beyond
 * `sendMessage`:
 *
 *   - `answerCallbackQuery` — required by the Bot API spec to clear
 *     the spinner that appears on the user's tap. Without this the
 *     client keeps showing "loading…" until it times out.
 *   - `editMessageReplyMarkup` — strip (or replace) the inline keyboard
 *     on the originating message so the same button can't be tapped
 *     twice, satisfying the "buttons disappear after action is taken"
 *     acceptance criterion on #24.
 *   - `editMessageText` — rewrite the body of a previously-posted
 *     message in place. The Flow 2 v2 volunteer-accept path uses it
 *     to flip the neutral group card from "Kann jemand annehmen?" to
 *     "✅ angenommen von <volunteer>" without posting a second
 *     message. Same primitive will be reused by the 4h/48h timeout
 *     schedules to flip the card to "⏰ Zeit abgelaufen" /
 *     "❌ Paket nie angekommen" in place. See `notify.ts`'s
 *     `editGroupCard` composition.
 *
 * The shape mirrors `sendTelegramMessage`: token passed in explicitly,
 * thin wrapper, throw on non-2xx so the caller decides whether to
 * swallow the failure (the orchestrator does — see
 * `process-update.ts`, callback path).
 *
 * @see lib/telegram-channel/send.ts — the `sendMessage` sibling
 * @see https://core.telegram.org/bots/api#answercallbackquery
 * @see https://core.telegram.org/bots/api#editmessagereplymarkup
 * @see https://core.telegram.org/bots/api#editmessagetext
 */

import type { InlineKeyboardMarkup, TelegramMessageEntity } from "./send.js";

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  if (token.length === 0) {
    throw new Error("Telegram bot token is empty.");
  }
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text && text.length > 0) body.text = text;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const failureBody = await res.text().catch(() => "");
    throw new Error(
      `Telegram answerCallbackQuery failed: ${res.status} ${res.statusText} ${failureBody}`,
    );
  }
}

/**
 * Edit (or remove) the inline keyboard on a previously-posted message.
 * Pass `undefined` for `replyMarkup` to strip the keyboard entirely —
 * Telegram interprets the omission as "no keyboard".
 */
export async function editMessageReplyMarkup(
  token: string,
  chatId: number,
  messageId: number,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  if (token.length === 0) {
    throw new Error("Telegram bot token is empty.");
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/editMessageReplyMarkup`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const failureBody = await res.text().catch(() => "");
    throw new Error(
      `Telegram editMessageReplyMarkup failed: ${res.status} ${res.statusText} ${failureBody}`,
    );
  }
}

/**
 * Rewrite the body of a previously-posted message. Used by the
 * Flow 2 v2 volunteer-accept callback path to flip the neutral group
 * card from "Kann jemand annehmen?" to "✅ angenommen von <volunteer>"
 * in place, without posting a second message that would split the
 * conversation thread.
 *
 * `entities` carries any `text_mention` MessageEntity covering the
 * volunteer's name (so it renders as a tap-to-DM link and pings them
 * even when they have no public `@username`). Omitted when an empty
 * array is supplied — the Bot API rejects empty `entities` arrays.
 *
 * Refuses an empty `text` because Telegram returns `400: text is empty`
 * with no further detail, and surfacing the precondition here gives
 * the caller a clearer stack trace.
 */
export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  entities?: ReadonlyArray<TelegramMessageEntity>,
): Promise<void> {
  if (token.length === 0) {
    throw new Error("Telegram bot token is empty.");
  }
  if (text.length === 0) {
    throw new Error("Telegram editMessageText: text is empty.");
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };
  if (entities && entities.length > 0) body.entities = entities;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/editMessageText`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const failureBody = await res.text().catch(() => "");
    throw new Error(
      `Telegram editMessageText failed: ${res.status} ${res.statusText} ${failureBody}`,
    );
  }
}
