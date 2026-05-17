/**
 * Minimal Telegram Bot API client for the Phase 1 spike.
 *
 * Phase 2 (issue #19) replaces this with a first-class Ash channel
 * built on `@chat-adapter/telegram`. For Phase 1 we only need:
 *
 *   - `sendTelegramMessage(chatId, text)` — post the agent's reply
 *     back to the user/group.
 *   - `extractInboundMessage(update)` — narrow a raw Telegram update
 *     to `{ chatId, text }` (or `null` for updates we don't handle
 *     yet, e.g. photos, edits, reactions).
 */

export interface TelegramInboundMessage {
  readonly chatId: number;
  readonly text: string;
  readonly isGroup: boolean;
  readonly fromUserId: number | null;
  readonly fromLanguageCode: string | null;
}

/**
 * Telegram webhook payload shape we care about for the spike. Many
 * fields are omitted intentionally — Phase 2 handles the long tail.
 */
export interface TelegramUpdatePayload {
  readonly update_id?: number;
  readonly message?: {
    readonly chat: { readonly id: number; readonly type: string };
    readonly text?: string;
    readonly from?: {
      readonly id: number;
      readonly language_code?: string;
    };
  };
}

export function extractInboundMessage(
  update: TelegramUpdatePayload,
): TelegramInboundMessage | null {
  const msg = update.message;
  if (!msg || typeof msg.text !== "string" || msg.text.length === 0) {
    return null;
  }
  return {
    chatId: msg.chat.id,
    text: msg.text,
    isGroup: msg.chat.type !== "private",
    fromUserId: msg.from?.id ?? null,
    fromLanguageCode: msg.from?.language_code ?? null,
  };
}

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
