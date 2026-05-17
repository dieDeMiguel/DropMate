/**
 * Inline-keyboard Bot API primitives — the two endpoints the
 * callback-query pipeline (#24) needs beyond `sendMessage`:
 *
 *   - `answerCallbackQuery` — required by the Bot API spec to clear
 *     the spinner that appears on the user's tap. Without this the
 *     client keeps showing "loading…" until it times out.
 *   - `editMessageReplyMarkup` — strip (or replace) the inline keyboard
 *     on the originating message so the same button can't be tapped
 *     twice, satisfying the "buttons disappear after action is taken"
 *     acceptance criterion on #24.
 *
 * The shape mirrors `sendTelegramMessage`: token passed in explicitly,
 * thin wrapper, throw on non-2xx so the caller decides whether to
 * swallow the failure (the orchestrator does — see
 * `process-update.ts`, callback path).
 *
 * @see lib/telegram-channel/send.ts — the `sendMessage` sibling
 * @see https://core.telegram.org/bots/api#answercallbackquery
 * @see https://core.telegram.org/bots/api#editmessagereplymarkup
 */

import type { InlineKeyboardMarkup } from "./send.js";

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
