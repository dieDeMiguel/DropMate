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
 * Bot token comes from `TELEGRAM_BOT_TOKEN`; both env vars are
 * required, and the tool throws clearly if either is missing.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { postToGroup } from "../../lib/telegram-channel/notify.js";

const inputSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "Short summary line for the group. Holder name + carrier + " +
        "recipient names is plenty — never include buzzer or floor.",
    ),
});

export default defineTool({
  description:
    "Post a single short message to the street group chat. Use for " +
    "package-arrival summaries and pickup announcements only. The text " +
    "should already be in the group's dominant language. Returns " +
    "`{ delivered: true }`.",
  inputSchema,
  async execute({ text }) {
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
    await postToGroup(token, groupChatId, text);
    return { delivered: true };
  },
});
