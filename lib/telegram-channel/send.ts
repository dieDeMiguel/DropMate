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

/**
 * `text_mention` Telegram MessageEntity — used to render a user's name
 * in a group post as a tap-to-DM link that also pings them. Offsets are
 * measured in UTF-16 code units (Telegram's spec), so the caller must
 * convert from UTF-8/Unicode-grapheme positions before constructing
 * this. Currently only `text_mention` is supported because it's the
 * only entity type DropMate produces; adding bold/italics later is just
 * widening this union.
 *
 * @see https://core.telegram.org/bots/api#messageentity
 */
export interface TelegramMessageEntity {
  readonly type: "text_mention";
  readonly offset: number;
  readonly length: number;
  readonly user: { readonly id: number };
}

/**
 * Result of a successful `sendMessage` call.
 *
 * `messageId` is populated when the Bot API responds with `ok: true`
 * and a parseable `result.message_id`. It is left undefined when the
 * caller passed an empty text (early-return path) so the helper can
 * always return the same shape without branching at the call site.
 *
 * Flow 2 v2 needs the message id of the neutral group card so a later
 * volunteer-accept callback (and the 4h / 48h timeout schedules) can
 * edit the card in place. Every other caller of `sendTelegramMessage`
 * (DMs, group-summary posts, schedule outbound) currently ignores the
 * return value, so promoting it from `void` to `SendMessageResult` is
 * a no-op for them.
 */
export interface SendMessageResult {
  readonly messageId?: number;
}

export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
  entities?: ReadonlyArray<TelegramMessageEntity>,
): Promise<SendMessageResult> {
  if (token.length === 0) {
    throw new Error("Telegram bot token is empty.");
  }
  if (text.length === 0) return {};
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (entities && entities.length > 0) body.entities = entities;
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
  const parsed = (await res
    .json()
    .catch(() => null)) as { ok?: boolean; result?: { message_id?: number } } | null;
  const messageId =
    parsed && parsed.ok && typeof parsed.result?.message_id === "number"
      ? parsed.result.message_id
      : undefined;
  return messageId !== undefined ? { messageId } : {};
}
