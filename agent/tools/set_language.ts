/**
 * `set_language` — explicit `/language <code>` override per PRD §6.
 *
 * The model recognises `/language en`, `/language tr`, "/language
 * deutsch", "switch to English", etc. and calls this tool with the
 * normalised ISO 639-1 code. The tool writes that code to the caller's
 * `Resident.language` field, which the `language_detection` hook will
 * then pick up on subsequent turns (and refuse to overwrite, thanks to
 * `onlyIfUnset`).
 *
 * The caller is identified via Telegram session auth — same pattern as
 * every other tool in this directory — so the model never passes a
 * principal id in.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import { updateResidentLanguage } from "../../lib/redis.js";

const inputSchema = z.object({
  language: z
    .string()
    .min(2)
    .max(3)
    .regex(/^[a-z]{2,3}$/, "ISO 639-1/639-2 lowercase code, e.g. 'en', 'de', 'tr'.")
    .describe(
      "Two- or three-letter lowercase ISO 639 code. Normalise inputs " +
        "yourself before calling: '/language English' → 'en', " +
        "'/language Deutsch' → 'de', '/language türkçe' → 'tr'.",
    ),
});

export default defineTool({
  description:
    "Set the calling resident's preferred reply language. Use when the " +
    "user sends `/language <code>` or otherwise asks (in any language) " +
    "to be addressed in a specific language. The caller must already be " +
    "a registered resident — ask them to /register first if not. " +
    "Returns the updated Resident's `language` field.",
  inputSchema,
  async execute({ language }) {
    const caller = await requireRegisteredTelegramCaller("set_language");
    const updated = await updateResidentLanguage(caller.platformId, language);
    // `updated` is non-null because the auth helper already proved the
    // Resident exists. The narrow refinement keeps TypeScript honest.
    if (!updated) {
      throw new Error(
        "set_language: Resident disappeared between auth check and update.",
      );
    }
    return { language: updated.language, residentId: updated.id };
  },
});
