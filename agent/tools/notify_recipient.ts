/**
 * `notify_recipient` — DM a resident privately.
 *
 * Use after `register_package` returned `recipientLinked: true`, to tell
 * the recipient where their package is (holder name, house number,
 * floor, buzzer, availability). The model produces the message text
 * already localised to the recipient's language — `language_detection`
 * injects the recipient's stored language into the system message — so
 * this tool just delivers verbatim.
 *
 * `recipientResidentId` is the `id` field of the Resident record
 * (identical to their Telegram `platformId` today, since `register_*`
 * uses `platformId` as the primary key). The tool keys the Redis read
 * on `platformId` and resolves the chat id from
 * `Number(resident.platformId)` — Telegram's 1:1 chat id and user id
 * are identical for DMs.
 *
 * Bot token comes from `TELEGRAM_BOT_TOKEN`; the tool throws clearly if
 * it's unset rather than silently sending with `undefined`.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { dmResident } from "../../lib/telegram-channel/notify.js";
import { getResident } from "../../lib/redis.js";

const inputSchema = z.object({
  recipientResidentId: z
    .string()
    .min(1)
    .describe(
      "Resident id of the person to DM — the `id` field returned by " +
        "`register_package`, `lookup_package`, or `register_resident`.",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "Localised message in the recipient's language. The model is " +
        "responsible for translation — this tool sends the text verbatim.",
    ),
});

export default defineTool({
  description:
    "Send a 1:1 Telegram DM to a registered resident. Use after a " +
    "`register_package` call that linked the recipient (or any time a " +
    "private message is appropriate). The text must already be in the " +
    "recipient's language. Returns `{ delivered: true, language }`.",
  inputSchema,
  async execute({ recipientResidentId, text }) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "notify_recipient: TELEGRAM_BOT_TOKEN is not set; cannot DM the recipient.",
      );
    }
    const recipient = await getResident(recipientResidentId);
    if (!recipient) {
      throw new Error(
        `notify_recipient: no resident found for id=${recipientResidentId}; ` +
          "the recipient may not be registered yet.",
      );
    }
    await dmResident(token, recipient, text);
    return { delivered: true, language: recipient.language ?? null };
  },
});
