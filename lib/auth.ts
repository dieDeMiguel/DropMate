/**
 * Auth helpers for tools that need a Telegram-authenticated, registered
 * caller. All package-related tools share this preamble:
 *
 *   1. Resolve the current/initiator principal from session auth.
 *   2. Reject if the authenticator isn't "telegram" (the spike webhook
 *      only ever sets this authenticator; anything else is a bug).
 *   3. Look up the caller's Resident record and reject if they haven't
 *      run `/register` yet.
 *
 * Centralised here so each tool stays focused on its business logic
 * and so the auth invariant has exactly one place to evolve.
 */

import { getSession } from "experimental-ash/context";

import { getResident, type Resident } from "./redis.js";

/**
 * Returns the Resident record for the currently-authenticated Telegram
 * caller. Throws — with a `toolName`-tagged message intended for the
 * orchestrating model — when the caller isn't Telegram-authenticated
 * or isn't yet a registered resident.
 */
export async function requireRegisteredTelegramCaller(
  toolName: string,
): Promise<Resident> {
  const session = getSession();
  const principal = session.auth.current ?? session.auth.initiator;
  if (!principal || principal.authenticator !== "telegram") {
    throw new Error(
      `${toolName} requires a Telegram-authenticated caller; got authenticator=` +
        (principal?.authenticator ?? "<none>"),
    );
  }
  const resident = await getResident(principal.principalId);
  if (!resident) {
    throw new Error(
      `${toolName}: caller is not a registered resident yet — ask them to /register first.`,
    );
  }
  return resident;
}
