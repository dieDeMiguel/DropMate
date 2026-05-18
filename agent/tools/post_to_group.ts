/**
 * `post_to_group` — post a short summary line to the street group chat.
 *
 * Use once per package-arrival or pickup event to keep the group
 * informed (public credit / coordination signal). Logistics details
 * (buzzer, floor, availability) MUST go via `notify_recipient` in a DM
 * instead — see `agent/instructions.md` "Public vs private".
 *
 * Single-street MVP: the group chat id comes from
 * `TELEGRAM_GROUP_CHAT_ID` (negative integer for supergroups, e.g.
 * `-1001234567890`). When DropMate grows to multiple streets, a
 * follow-up ticket will swap this for a per-street Redis lookup keyed
 * on the holder's `streetId`.
 *
 * Optional `buttons` (#24): attach an inline-keyboard row. The
 * recipient-scoped "Picked up" button on a package-arrival summary
 * uses this — callback data carries the package id; the orchestrator
 * rejects taps from anyone other than the package's recipient (so the
 * group post can show the button to everyone but only fire for the
 * right person).
 *
 * Bot token comes from `TELEGRAM_BOT_TOKEN`; both env vars are
 * required, and the tool throws clearly if either is missing.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { postToGroup } from "../../lib/telegram-channel/notify.js";
import type {
  InlineKeyboardMarkup,
  TelegramMessageEntity,
} from "../../lib/telegram-channel/send.js";

/**
 * Compute Telegram `text_mention` entities for the supplied names. The
 * Bot API spec requires `offset` + `length` to be expressed in UTF-16
 * code units (the same unit JavaScript strings use natively). Using
 * `String.indexOf` and `name.length` on the JS string therefore lands
 * the correct offsets without manual code-point arithmetic — JS strings
 * are already UTF-16-indexed, surrogate pairs and all.
 *
 * Each mention pins to the first occurrence of `name` in `text`. Names
 * not found are silently skipped (with a `console.warn`) so a typo'd
 * mention doesn't fail the whole post — the worst case is the recipient
 * doesn't get pinged, which is better than the group post not appearing.
 * The model owns producing matching text + mentions; the rejection log
 * is the diagnostic trail.
 */
export function computeMentionEntities(
  text: string,
  mentions: ReadonlyArray<{ readonly name: string; readonly telegramUserId: number }>,
): ReadonlyArray<TelegramMessageEntity> {
  const out: TelegramMessageEntity[] = [];
  for (const mention of mentions) {
    const offset = text.indexOf(mention.name);
    if (offset < 0) {
      console.warn(
        `[post_to_group] mention name not found in text — skipping. name='${mention.name}' userId=${mention.telegramUserId}`,
      );
      continue;
    }
    out.push({
      type: "text_mention",
      offset,
      length: mention.name.length,
      user: { id: mention.telegramUserId },
    });
  }
  return out;
}

const mentionSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Exact substring of `text` to wrap as a tap-to-DM mention. Must " +
        "appear in `text` verbatim — if it doesn't, the mention is " +
        "silently skipped.",
    ),
  telegramUserId: z
    .number()
    .int()
    .describe(
      "Telegram numeric `user_id` of the person being mentioned. Comes " +
        "from `recipientResolution.telegram.userId` on a " +
        "`register_package` result whose `recipientResolution.kind` was " +
        "`'known_telegram'`.",
    ),
});

const buttonSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "Button label in the group's dominant language. Keep short.",
    ),
  callbackData: z
    .string()
    .min(1)
    .max(64)
    .describe(
      'Encoded action to fire when the button is tapped. Convention: ' +
        '"<action>:<id>" — e.g. "confirm_pickup:pkg_42". Max 64 bytes ' +
        "per Bot API spec.",
    ),
});

const inputSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "Short summary line for the group. Holder name + carrier + " +
        "recipient names is plenty — never include buzzer or floor.",
    ),
  mentions: z
    .array(mentionSchema)
    .min(1)
    .optional()
    .describe(
      "Optional list of names to render as Telegram `text_mention` " +
        "entities — each one is rewritten as a tap-to-DM link that " +
        "pings the user. Use when `register_package` returned " +
        "`recipientResolution.kind: 'known_telegram'`: the recipient " +
        "can't receive a DM (they haven't started a chat with the bot) " +
        "but they CAN be pinged in the group via this entity. The " +
        "`name` MUST appear verbatim in `text`; mentions whose name " +
        "isn't found are silently skipped. Omit when there's nobody to " +
        "ping (registered residents already get a DM; unknown names " +
        "have no `user_id`).",
    ),
  buttons: z
    .array(z.array(buttonSchema).min(1).max(3))
    .min(1)
    .max(3)
    .optional()
    .describe(
      "Optional inline-keyboard rows attached to the group post. Use " +
        "sparingly — buttons in the group are scoped server-side to the " +
        "specific recipient via callback data (e.g. a 'Picked up' button " +
        "only fires when the package's recipient taps it).",
    ),
});

export default defineTool({
  description:
    "Post a single short message to the street group chat. Use for " +
    "package-arrival summaries and pickup announcements only. The text " +
    "should already be in the group's dominant language. Optionally " +
    "attach `mentions` to ping unregistered recipients via " +
    "`text_mention` entities, and `buttons` for recipient-scoped " +
    "actions. Returns `{ delivered: true }`.",
  inputSchema,
  async execute({ text, mentions, buttons }) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "post_to_group: TELEGRAM_BOT_TOKEN is not set; cannot post to the group.",
      );
    }
    const groupId = process.env.TELEGRAM_GROUP_CHAT_ID;
    if (!groupId) {
      throw new Error(
        "post_to_group: TELEGRAM_GROUP_CHAT_ID is not set; cannot resolve the group chat id.",
      );
    }
    const groupChatId = Number(groupId);
    if (!Number.isFinite(groupChatId)) {
      throw new Error(
        `post_to_group: TELEGRAM_GROUP_CHAT_ID=${groupId} is not a valid number.`,
      );
    }
    const replyMarkup: InlineKeyboardMarkup | undefined = buttons
      ? {
          inline_keyboard: buttons.map((row) =>
            row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
          ),
        }
      : undefined;
    const entities = mentions
      ? computeMentionEntities(text, mentions)
      : undefined;
    await postToGroup(
      token,
      groupChatId,
      text,
      replyMarkup,
      entities && entities.length > 0 ? entities : undefined,
    );
    return { delivered: true };
  },
});
