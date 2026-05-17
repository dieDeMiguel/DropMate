/**
 * Telegram Bot API outbound primitive.
 *
 * The thinnest possible wrapper around the official `sendMessage`
 * endpoint — just enough for the spike webhook and the eventual
 * `telegramChannel({ token, webhookSecret })` factory (issue #19) to
 * post plain-text replies back to a chat.
 *
 * The bot token is an explicit parameter rather than an env-var read:
 *
 *   - The Phase 2 channel factory will accept `token` in its config
 *     and capture it in closure — passing it through a function
 *     argument is the API shape it'll need anyway.
 *   - Tests don't have to monkey-patch `process.env` to keep the
 *     fetch off the real Bot API; they pass a sentinel string and
 *     assert on the URL.
 *   - Future multi-bot deployments (one Ash app serving several
 *     `telegramChannel({ ... })` instances) get the right isolation
 *     for free.
 *
 * @see lib/telegram-channel/outbound.ts — the only production caller
 *      today (via `drainSessionToTelegram`)
 */

/**
 * Inline keyboard button. The Bot API supports more fields (`url`,
 * `switch_inline_query`, …) but DropMate only uses `callback_data` —
 * the rest are intentionally omitted so the model can't accidentally
 * produce a button that opens an external URL.
 *
 * @see https://core.telegram.org/bots/api#inlinekeyboardbutton
 */
export interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

/**
 * Inline keyboard payload — a 2D array of rows of buttons.
 *
 * @see https://core.telegram.org/bots/api#inlinekeyboardmarkup
 */
export interface InlineKeyboardMarkup {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<InlineKeyboardButton>>;
}

export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  if (token.length === 0) {
    throw new Error("Telegram bot token is empty.");
  }
  if (text.length === 0) return;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const failureBody = await res.text().catch(() => "");
    throw new Error(
      `Telegram sendMessage failed: ${res.status} ${res.statusText} ${failureBody}`,
    );
  }
}
