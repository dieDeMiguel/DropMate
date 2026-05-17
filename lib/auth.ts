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

import { getSession, type SessionAuthContext } from "experimental-ash/context";

import { getResident, type Resident } from "./redis.js";

/**
 * Returns the current/initiator principal if the active session is
 * Telegram-authenticated, otherwise `null`. Single source of truth for
 * the "is this a Telegram-authenticated turn?" check so the principal
 * lookup shape (current vs initiator priority, the authenticator
 * string literal) lives in exactly one place.
 *
 * Non-throwing — hooks tolerate non-Telegram principals (other channels
 * might be added later) and need a way to detect them quietly. Tools
 * that REQUIRE a Telegram caller wrap this in
 * `requireRegisteredTelegramCaller`.
 */
export function getTelegramPrincipal(): SessionAuthContext | null {
  const session = getSession();
  const principal = session.auth.current ?? session.auth.initiator;
  if (!principal || principal.authenticator !== "telegram") return null;
  return principal;
}

/**
 * Returns the Resident record for the currently-authenticated Telegram
 * caller. Throws — with a `toolName`-tagged message intended for the
 * orchestrating model — when the caller isn't Telegram-authenticated
 * or isn't yet a registered resident.
 */
export async function requireRegisteredTelegramCaller(
  toolName: string,
): Promise<Resident> {
  const principal = getTelegramPrincipal();
  if (!principal) {
    const session = getSession();
    const raw = session.auth.current ?? session.auth.initiator;
    throw new Error(
      `${toolName} requires a Telegram-authenticated caller; got authenticator=` +
        (raw?.authenticator ?? "<none>"),
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
