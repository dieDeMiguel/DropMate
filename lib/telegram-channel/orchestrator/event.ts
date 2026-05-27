import type {
  TelegramInboundCallback,
  TelegramInboundMessage,
} from "../inbound.js";

/**
 * Discriminated union of the raw inbound shapes that reach the
 * orchestrator. `buildState` receives one of these and fans out the
 * fixed I/O graph for that kind before calling `match`.
 *
 * `kind: "dm"` — private message to the bot (not a group).
 * `kind: "group"` — message in a group chat.
 * `kind: "callback"` — inline-keyboard button tap.
 */
export type Inbound =
  | { readonly kind: "dm"; readonly message: TelegramInboundMessage }
  | { readonly kind: "group"; readonly message: TelegramInboundMessage }
  | { readonly kind: "callback"; readonly callback: TelegramInboundCallback };
