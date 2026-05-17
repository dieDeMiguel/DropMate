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
 * fields are intentionally omitted — extending the type is a Phase 2
 * concern (#24 for callback queries, …).
 */
export interface TelegramUpdatePayload {
  readonly update_id?: number;
  readonly message?: {
    readonly chat: { readonly id: number; readonly type: string };
    readonly text?: string;
    readonly caption?: string;
    readonly photo?: ReadonlyArray<TelegramPhotoSize>;
    readonly from?: {
      readonly id: number;
      readonly language_code?: string;
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
