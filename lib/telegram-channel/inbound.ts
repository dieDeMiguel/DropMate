/**
 * Inbound Telegram update parsing.
 *
 * Narrows a raw Telegram webhook update into the canonical
 * `TelegramInboundMessage` shape the agent's session API understands.
 * The Phase 1 spike webhook (`agent/channels/telegram.ts`) and the
 * upcoming Phase 2 Ash channel (`lib/telegram-channel/`) both call
 * through here so the long-tail update types (edits, reactions,
 * channel posts, etc.) get rejected in exactly one place.
 *
 * Phase 2 will extend the result type with `photo` / `caption` fields
 * once `parse_label` (issue #20) lands. For now we keep it text-only
 * so the surface stays small.
 *
 * @see https://core.telegram.org/bots/api#update
 */

export interface TelegramInboundMessage {
  readonly chatId: number;
  readonly text: string;
  readonly isGroup: boolean;
  readonly fromUserId: number | null;
  readonly fromLanguageCode: string | null;
}

/**
 * Telegram webhook payload shape we currently care about. Many optional
 * fields are intentionally omitted — extending the type is a Phase 2
 * concern (#20 for photos, #24 for callback queries, …).
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
