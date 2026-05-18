/**
 * Inline-keyboard Bot API primitives — the endpoints the
 * callback-query pipeline (#24) and the volunteer-accept pipeline
 * (#52) need beyond `sendMessage`:
 *
 *   - `answerCallbackQuery` — required by the Bot API spec to clear
 *     the spinner that appears on the user's tap. Without this the
 *     client keeps showing "loading…" until it times out.
 *   - `editMessageReplyMarkup` — strip (or replace) the inline keyboard
 *     on the originating message so the same button can't be tapped
 *     twice, satisfying the "buttons disappear after action is taken"
 *     acceptance criterion on #24.
 *   - `editMessageText` — replace the text of a previously-posted
 *     message. The /receive group card is rewritten in place when a
 *     volunteer accepts ("✅ angenommen von <name>") and when the
 *     request times out ("⏰ Zeit abgelaufen, niemand konnte
 *     annehmen.") so the public card always reflects current state.
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

import type {
  InlineKeyboardMarkup,
  TelegramMessageEntity,
} from "./send.js";

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
 * Replace the text of a previously-posted message. When `entities`
 * is supplied the API renders them alongside the new text (used to
 * keep a `text_mention` pinging the volunteer when the card edits to
 * "✅ angenommen von <name>"). The keyboard on the original message
 * is left untouched — the caller strips it separately via
 * `editMessageReplyMarkup` so a partial edit failure can't leave a
 * stale button visible without the new text.
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
    throw new Error("Telegram editMessageText: text must not be empty.");
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
