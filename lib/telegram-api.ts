/**
 * Minimal Telegram Bot API client for the Phase 1 spike.
 *
 * Phase 2 (issue #19) replaces this with a first-class Ash channel
 * built on `@chat-adapter/telegram`. For Phase 1 we only need
 * `sendTelegramMessage(chatId, text)` to post the agent's reply back to
 * the user/group.
 *
 * Inbound parsing + webhook signature verification moved to
 * `lib/telegram-channel/` so the spike and Phase 2 channel share one
 * implementation. See `lib/telegram-channel/index.ts`.
 */

export async function sendTelegramMessage(
  chatId: number,
  text: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN env var is missing.");
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
