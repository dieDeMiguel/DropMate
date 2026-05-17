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

export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  if (token.length === 0) {
    throw new Error("Telegram bot token is empty.");
  }
  if (text.length === 0) return;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Telegram sendMessage failed: ${res.status} ${res.statusText} ${body}`,
    );
  }
}
