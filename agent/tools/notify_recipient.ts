/**
 * `notify_recipient` — DM a resident privately.
 *
 * Use after `register_package` returned `recipientResolution.kind:
 * "resident"`, to tell the recipient where their package is (holder
 * name, house number,
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
 * Optional `buttons` arg (#24): when supplied, the DM is sent with an
 * inline keyboard. The model uses this to attach quick-action buttons
 * to pickup notifications ("Mark as picked up") and reception-request
 * candidate DMs ("Yes, I can receive" / "No"). Each button carries
 * `callback_data` formatted as `"<action>:<id>"` — e.g.
 * `"confirm_pickup:pkg_42"`, `"accept_reception_request:req_99"`. The
 * orchestrator parses this on tap to route the action through the
 * agent. Button text MUST already be in the recipient's language.
 *
 * Bot token comes from `TELEGRAM_BOT_TOKEN`; the tool throws clearly if
 * it's unset rather than silently sending with `undefined`.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { dmResident } from "../../lib/telegram-channel/notify.js";
import type { InlineKeyboardMarkup } from "../../lib/telegram-channel/send.js";
import { getResident } from "../../lib/redis.js";

const buttonSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "Button label in the recipient's language. Keep short — Telegram " +
        "wraps long labels poorly.",
    ),
  callbackData: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Encoded action to fire when the button is tapped. Convention: " +
        '"<action>:<id>" — e.g. "confirm_pickup:pkg_42", ' +
        '"accept_reception_request:req_99", ' +
        '"decline_reception_request:req_99". Max 64 bytes per Bot API spec.',
    ),
});

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
  buttons: z
    .array(z.array(buttonSchema).min(1).max(3))
    .min(1)
    .max(3)
    .optional()
    .describe(
      "Optional inline-keyboard rows attached to the DM. Each inner " +
        'array is one row; up to 3 rows of up to 3 buttons. Use for ' +
        "quick actions like pickup confirmation or reception-request " +
        "yes/no. Omit for plain text DMs.",
    ),
});

export default defineTool({
  description:
    "Send a 1:1 Telegram DM to a registered resident. Use after a " +
    "`register_package` call whose `recipientResolution.kind` was " +
    "`'resident'` (or any time a private message is appropriate). The " +
    "text must already be in the recipient's language. Optionally " +
    "attach inline-keyboard `buttons` for quick actions (pickup " +
    "confirmation, reception-request yes/no). Returns " +
    "`{ delivered: true, language }`.",
  inputSchema,
  async execute({ recipientResidentId, text, buttons }) {
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
    const replyMarkup: InlineKeyboardMarkup | undefined = buttons
      ? {
          inline_keyboard: buttons.map((row) =>
            row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
          ),
        }
      : undefined;
    await dmResident(token, recipient, text, replyMarkup);
    return { delivered: true, language: recipient.language ?? null };
  },
});
