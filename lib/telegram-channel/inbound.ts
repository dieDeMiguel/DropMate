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
 * Photo support (#20): a message with a `photo[]` array is admitted
 * even when it has no `text`. Telegram orders `photo[]` smallest →
 * largest; we pick the variant with the largest `file_size` (falling
 * back to the last entry when `file_size` is absent on every variant)
 * to maximise label legibility for the multimodal model.
 *
 * Callback queries (#24): an update with `callback_query` (a tap on an
 * inline-keyboard button) is admitted by `extractInboundCallback`. It
 * surfaces the originating message id + chat id so the orchestrator
 * can edit / strip the keyboard, and the callback `id` so it can `answerCallbackQuery`
 * to clear the client-side spinner.
 *
 * @see https://core.telegram.org/bots/api#update
 */

export interface TelegramInboundMessage {
  readonly chatId: number;
  readonly text: string;
  readonly isGroup: boolean;
  readonly fromUserId: number | null;
  readonly fromLanguageCode: string | null;
  /**
   * `file_id` of the largest photo variant on this message, or `null`
   * when the inbound update has no `photo[]`. The orchestrator turns
   * this into a downloadable URL via Bot API `getFile` before handing
   * it to the agent.
   */
  readonly photoFileId: string | null;
}

/**
 * Canonical shape for a button-tap update. The orchestrator turns this
 * into a synthetic user message into the same Ash session and uses the
 * `messageId` / `callbackId` fields to clean up the originating
 * keyboard and ack the tap.
 *
 * @see https://core.telegram.org/bots/api#callbackquery
 */
export interface TelegramInboundCallback {
  readonly callbackId: string;
  readonly chatId: number;
  readonly messageId: number;
  readonly fromUserId: number;
  readonly fromLanguageCode: string | null;
  readonly isGroup: boolean;
  readonly data: string;
}

/**
 * Telegram photo variant — Telegram returns several down-scaled copies
 * of the same image; `photo[]` is ordered small → large. We persist the
 * fields we actually use to pick the best variant.
 *
 * @see https://core.telegram.org/bots/api#photosize
 */
export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_size?: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Telegram webhook payload shape we currently care about. Many optional
 * fields (edited_message, channel_post, reactions, …) are intentionally
 * omitted — adding them is just more `extract*` branches when needed.
 */
export interface TelegramUpdatePayload {
  readonly update_id?: number;
  readonly message?: {
    readonly message_id?: number;
    readonly chat: { readonly id: number; readonly type: string };
    readonly text?: string;
    readonly caption?: string;
    readonly photo?: ReadonlyArray<TelegramPhotoSize>;
    readonly from?: {
      readonly id: number;
      readonly language_code?: string;
    };
  };
  readonly callback_query?: {
    readonly id: string;
    readonly data?: string;
    readonly from: {
      readonly id: number;
      readonly language_code?: string;
    };
    readonly message?: {
      readonly message_id: number;
      readonly chat: { readonly id: number; readonly type: string };
    };
  };
}

/**
 * Pick the largest photo variant by `file_size`. Telegram orders the
 * array small → large, so the last entry is a safe fallback when no
 * variant exposes a `file_size`. Returns `null` for an empty array.
 */
function pickLargestPhoto(
  photos: ReadonlyArray<TelegramPhotoSize>,
): TelegramPhotoSize | null {
  if (photos.length === 0) {
    return null;
  }
  let best: TelegramPhotoSize = photos[photos.length - 1]!;
  let bestSize = best.file_size ?? -1;
  for (const photo of photos) {
    const size = photo.file_size ?? -1;
    if (size > bestSize) {
      best = photo;
      bestSize = size;
    }
  }
  return best;
}

/**
 * Narrow a `callback_query` update into our canonical shape. Returns
 * `null` if the payload has no `callback_query`, no `data`, or no
 * originating `message` (the rare "inline mode" tap from an inline
 * query — we don't post those, so we ignore taps on them).
 */
export function extractInboundCallback(
  update: TelegramUpdatePayload,
): TelegramInboundCallback | null {
  const cb = update.callback_query;
  if (!cb) return null;
  if (typeof cb.data !== "string" || cb.data.length === 0) return null;
  if (!cb.message) return null;
  return {
    callbackId: cb.id,
    chatId: cb.message.chat.id,
    messageId: cb.message.message_id,
    fromUserId: cb.from.id,
    fromLanguageCode: cb.from.language_code ?? null,
    isGroup: cb.message.chat.type !== "private",
    data: cb.data,
  };
}

export function extractInboundMessage(
  update: TelegramUpdatePayload,
): TelegramInboundMessage | null {
  const msg = update.message;
  if (!msg) {
    return null;
  }

  const photo = msg.photo && msg.photo.length > 0 ? pickLargestPhoto(msg.photo) : null;
  const rawText =
    typeof msg.text === "string" && msg.text.length > 0
      ? msg.text
      : typeof msg.caption === "string" && msg.caption.length > 0
        ? msg.caption
        : "";

  // No text, no caption, no photo → nothing actionable. Edited messages,
  // reactions, stickers, and other update types land here.
  if (rawText.length === 0 && photo === null) {
    return null;
  }

  return {
    chatId: msg.chat.id,
    text: rawText,
    isGroup: msg.chat.type !== "private",
    fromUserId: msg.from?.id ?? null,
    fromLanguageCode: msg.from?.language_code ?? null,
    photoFileId: photo?.file_id ?? null,
  };
}
