/**
 * `language_detection` — lifecycle.turn hook that decides which
 * language the agent should reply in for the current turn and
 * passively backfills the caller's `Resident.language`.
 *
 * Resolution order, highest priority first:
 *
 *   1. `Resident.language` if a record exists and the field is set —
 *      this is the authoritative value, written either by `/register`
 *      (which seeds from the Telegram attribute through the same
 *      `normaliseLanguageCode` helper) or by `/language <code>` (the
 *      `set_language` tool). The hook never overwrites this.
 *
 *   2. Telegram's `attributes.languageCode` on the current principal,
 *      normalised through `lib/language.ts` so "de-AT" becomes "de".
 *      Used both as the live reply-language signal for unregistered
 *      callers and as the backfill value when a Resident exists but
 *      has no `language` set yet.
 *
 * Whichever wins is injected as a single `system` modelContext message
 * for the current turn. If no signal exists at all (no Telegram
 * principal, no Resident record, no attribute), the hook returns
 * undefined and the model picks the language itself.
 *
 * Channel-agnostic in shape: hooks run for every channel (the spike
 * Telegram webhook today, the first-class Ash channel after #19). The
 * Telegram authenticator gate lives in `getTelegramPrincipal` —
 * adapting to a WhatsApp principal will be one helper, not a hook
 * rewrite.
 */

import { defineHook } from "experimental-ash/hooks";

import { getTelegramPrincipal } from "../../lib/auth.js";
import { normaliseLanguageCode } from "../../lib/language.js";
import { getResident, updateResidentLanguage } from "../../lib/redis.js";

export default defineHook({
  lifecycle: {
    async turn() {
      const principal = getTelegramPrincipal();
      if (!principal) return; // Not a Telegram-authenticated turn.

      const detected = normaliseLanguageCode(principal.attributes.languageCode);

      // The persisted Resident.language is authoritative: it reflects
      // either an explicit `/language <code>` (set_language tool) or
      // the result of an earlier backfill. The Telegram client's
      // current `language_code` is only used as a fallback for users
      // who haven't been seen / registered yet, OR to backfill an
      // existing Resident whose record predates language tracking.
      const resident = await getResident(principal.principalId);
      const effective = resident?.language ?? detected;
      if (!effective) return; // No signal at all — let the agent guess.

      if (resident && !resident.language && detected) {
        // Passive backfill: only set `language` when the Resident has
        // no value yet. Explicit overrides win on subsequent turns.
        try {
          await updateResidentLanguage(principal.principalId, detected, {
            onlyIfUnset: true,
          });
        } catch (err) {
          // A Redis hiccup must not fail the turn — language is a
          // preference, not a correctness invariant.
          console.error("language_detection: failed to persist language", err);
        }
      }

      return {
        modelContext: [
          {
            role: "system",
            content:
              `The current user's preferred language code is "${effective}". ` +
              "Reply in that language when you address this user directly " +
              "(DMs or group replies that name them). Group messages that " +
              "don't single out one recipient may stay in the dominant " +
              "language of the street.",
          },
        ],
      };
    },
  },
});
