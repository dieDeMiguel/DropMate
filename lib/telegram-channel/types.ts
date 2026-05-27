/**
 * Shared ash-channel session types for the Telegram channel.
 *
 * Both `process-update.ts` (the legacy dispatcher) and the
 * `orchestrator/*` modules (the state-machine engine, ADR 0001) need
 * the auth + state shapes handed to `send(...)`. Keeping them in a
 * separate file lets the orchestrator stay decoupled from
 * `process-update.ts` — no type-only import that contradicts the
 * runner's "decoupled" design intent.
 */

/**
 * Subset of an Ash `SessionAuthContext` we hand `send(...)`. Kept
 * loose (Record-typed) so this module doesn't pull in Ash's full
 * `SessionAuthContext` type — the spike's `defineChannel` call site
 * already enforces the contract at the route boundary.
 */
export interface TelegramSessionAuth {
  readonly principalId: string;
  readonly principalType: "user";
  readonly authenticator: "telegram";
  readonly attributes: Record<string, string>;
}

/**
 * State passed through `send(...)` and surfaced to tools via the
 * channel's `context(state)` projection. Mirrors the spike's
 * existing shape so the factory can drop in without changing tool
 * expectations.
 */
export interface TelegramChannelState {
  readonly chatId: number;
  readonly isGroup: boolean;
  readonly fromUserId: number | null;
  readonly fromLanguageCode: string | null;
}

/**
 * Trigger-attribute kind set the channel stamps on each inbound so the
 * agent's tools can dispatch on the original Telegram shape. Mirrors the
 * union used by `setTelegramTriggerAttribute` in the factory.
 *
 * `telegram.photo` was retired in Slice 7 (#138): photo turns are now
 * fully channel-deterministic (DM photo → Flow 1 register / Flow 2 create
 * / VLC; group photo → privacy nudge), so no photo inbound reaches the
 * agent and no inbound stamps `telegram.photo` anymore.
 */
export type TelegramTriggerKind =
  | "telegram.text-dm"
  | "telegram.group"
  | "telegram.slash-receive"
  | "telegram.callback";
