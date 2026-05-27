import type { PackageCarrier } from "../../redis.js";
import type { ReceptionRequest, Resident } from "../../redis.js";
import type { ConfirmPickupResult } from "../../pickup.js";
import type { AcceptReceptionRequestResult } from "../../reception-request.js";
import type { RegisterPackageResult } from "../../package.js";
import type {
  TelegramInboundCallback,
  TelegramInboundMessage,
} from "../inbound.js";

/**
 * Vision tool output — the discriminated union returned by
 * `deps.parsePackagePhoto`. Mirrors the shape declared on
 * `ProcessUpdateDeps.parsePackagePhoto` without importing from the
 * legacy dispatcher so the orchestrator stays decoupled.
 */
export type VisionVerdict =
  | {
      readonly kind: "shipping_label";
      readonly carrier: PackageCarrier;
      readonly recipientName?: string;
      readonly recipientHouseNumber?: string;
      readonly trackingNumber?: string;
      readonly confidence: "high" | "medium" | "low";
      readonly reason: string;
    }
  | {
      readonly kind: "tracking_page";
      readonly carrier: PackageCarrier;
      readonly trackingNumber?: string;
      readonly expectedWindowStartAt?: string;
      readonly expectedWindowEndAt?: string;
      readonly confidence: "high" | "medium" | "low";
      readonly reason: string;
    }
  | { readonly kind: "unknown"; readonly confidence: "low"; readonly reason: string };

/**
 * DM intent classifier output. Mirrors `DmIntentClassificationResult`
 * from the legacy dispatcher without importing from it.
 */
export type DmIntentKind =
  | "flow2-reception"
  | "flow2-volunteer-early-arrival"
  | "pickup-confirmation"
  | "registration"
  | "other";

export interface ClassifierVerdict {
  readonly kind: DmIntentKind;
  readonly absenceSignal: boolean;
  readonly carrier?: PackageCarrier;
  readonly expectedDate?: string;
  readonly expectedWindowStartAt?: number;
  readonly expectedWindowEndAt?: number;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

/**
 * Group message classifier output. Mirrors `ClassifyGroupMessageResult`
 * from the legacy dispatcher without importing from it.
 */
export interface GroupClassifierRecipient {
  readonly name: string;
  readonly houseNumber?: string;
}

export interface GroupClassifierVerdict {
  readonly isPackageRegistration: boolean;
  readonly recipients: ReadonlyArray<GroupClassifierRecipient>;
  readonly carrier?: PackageCarrier;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

/**
 * State discriminated union — one variant per inbound shape (ADR D2).
 * Each variant carries exactly the fields its `match` branch needs.
 *
 * Nonsensical field access (e.g. `state.classifier` inside `dm-photo`)
 * is a TypeScript error. Adding a new inbound shape without a
 * corresponding `match` branch fails `tsc` via the `never`-typed default.
 *
 * Callback variants (#135 Slice 4): `buildState` pre-calls the
 * lib-level side effect (`confirmPickup` / `acceptReceptionRequest`) and
 * encodes the outcome as a state variant. This keeps `match` purely
 * synchronous + lets it dispatch on the success/error class. The
 * action-outcome traces (`flow1.pickup.start/end/error`,
 * `flow2.accept.start/end/error`) fire from `buildState` next to the
 * call rather than via the runner's auto-trace — same stage names,
 * same shape on the bus.
 */
export type State =
  // ---------------------------------------------------------------------
  // DM photo (Slice 5 / #136). The agent is NEVER invoked on the photo
  // surface — every branch resolves channel-deterministically.
  // ---------------------------------------------------------------------
  // Flow 1 success — recipient is a registered resident. Sends the
  // group ack (or holder confirmation DM when the registration LINKS to
  // a Flow 2 RR, per #116) and the recipient DM with the [Abgeholt]
  // keyboard.
  | {
      readonly kind: "dm-photo-flow1-resident";
      readonly inbound: TelegramInboundMessage;
      readonly result: RegisterPackageResult;
      readonly groupChatId: number | null;
    }
  // Flow 1 success — recipient name doesn't resolve to anyone known. The
  // street group chat id resolved, so we post the deterministic "kennt
  // jemand X?" question (#109) there.
  | {
      readonly kind: "dm-photo-flow1-unknown";
      readonly inbound: TelegramInboundMessage;
      readonly recipientName: string;
      readonly holderLanguage: string | null;
      readonly groupChatId: number;
    }
  // Flow 1 success — silent. Either recipient is `known_telegram` (no DM
  // channel to a non-Resident) or recipient is `unknown` with no group
  // chat id resolved. Package row landed; cron sweep ages it out.
  | {
      readonly kind: "dm-photo-flow1-silent";
      readonly inbound: TelegramInboundMessage;
      readonly reason: "known_telegram" | "unknown";
    }
  // Flow 1 rejected — registerPackage threw HOLDER_NOT_REGISTERED. Sends
  // the localised /register nudge DM.
  | {
      readonly kind: "dm-photo-flow1-holder-not-registered";
      readonly inbound: TelegramInboundMessage;
      readonly language: string | null;
    }
  // Flow 2 success — tracking page parsed at high-conf, registered caller,
  // createReceptionRequest succeeded. Sends the localised ack DM.
  | {
      readonly kind: "dm-photo-flow2-created";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // Fallback — 3-path VLC recovery DM. Used for: vision kind=unknown,
  // getFileUrl/vision throw, low confidence, missing fields, medium-conf
  // non-resident, registerPackage non-typed error, createReceptionRequest
  // error, unregistered/anonymous Flow 1 photo, etc.
  | {
      readonly kind: "dm-photo-vlc";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }

  // ---------------------------------------------------------------------
  // DM text (Slice 5 / #136). The agent is invoked only on the explicit
  // `dm-text-agent` variant; every other variant emits a bounded action.
  //
  // Welcome-wall fix: medium/low-confidence classifier with a registered
  // resident must NOT fall through to the agent (the v2 regression class
  // #130 closed). `dm-text-vlc` is the structural guarantee.
  // ---------------------------------------------------------------------
  // High-conf flow2-reception + registered + createReceptionRequest
  // succeeded — sends the localised Flow 2 ack DM.
  | {
      readonly kind: "dm-text-flow2-reception-created";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // High-conf pickup-confirmation, exactly 1 open package, confirmPickup
  // succeeded — sends the caller confirmation DM + holder thanks DM.
  | {
      readonly kind: "dm-text-pickup-confirmed";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
      readonly result: ConfirmPickupResult;
    }
  // Pickup-confirmation, 1 package, PICKUP_ALREADY_DONE — idempotent DM.
  | {
      readonly kind: "dm-text-pickup-already-done";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // Pickup-confirmation, 1 package, retry-class error — retry DM. No
  // agent fallthrough (the agent on this surface is more likely to
  // misroute than to add value).
  | {
      readonly kind: "dm-text-pickup-retry";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // Pickup-confirmation, 0 open packages + no matched RR as requester.
  | {
      readonly kind: "dm-text-pickup-no-open";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // Pickup-confirmation, 0 open packages + ≥1 matched RR as requester
  // (v2.1 #122). Sends the context-aware "waiting on volunteer" DM,
  // naming the volunteer when resolvable.
  | {
      readonly kind: "dm-text-pickup-waiting";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
      readonly volunteerName: string | null;
    }
  // Pickup-confirmation, 2+ open packages — disambiguation DM.
  | {
      readonly kind: "dm-text-pickup-multiple";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // High-conf flow2-volunteer-early-arrival, exactly 1 matched RR as
  // volunteer, registerPackage succeeded — DMs recipient (with
  // [Abgeholt]) + DMs volunteer ack (v2.1 #121).
  | {
      readonly kind: "dm-text-volunteer-early-arrival";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
      readonly result: RegisterPackageResult;
      readonly req: ReceptionRequest;
    }
  // Flow2-volunteer-early-arrival registerPackage threw — retry DM to
  // volunteer; RR stays in `matched` so they can re-DM.
  | {
      readonly kind: "dm-text-volunteer-early-arrival-retry";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // Welcome-wall fix — medium/low-confidence classifier on a registered
  // resident, on any flow2/pickup-related intent kind. Sends the bounded
  // 3-path VLC recovery DM instead of falling through to the agent.
  | {
      readonly kind: "dm-text-vlc";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // Fallthrough to the agent. Used for: anonymous DM (no fromUserId),
  // classifier outage, unregistered caller, high-conf "other" /
  // "registration" intent, or flow2-volunteer-early-arrival with 0 or
  // 2+ matched RRs.
  | {
      readonly kind: "dm-text-agent";
      readonly inbound: TelegramInboundMessage;
    }

  // ---------------------------------------------------------------------
  // /receive slash command (Slice 5 / #136).
  // ---------------------------------------------------------------------
  // Registered caller + createReceptionRequest succeeded — ack DM.
  | {
      readonly kind: "dm-receive-cmd-created";
      readonly inbound: TelegramInboundMessage;
      readonly language: string;
    }
  // Fallthrough to the agent — unregistered, anonymous, or
  // createReceptionRequest threw. The agent typically asks the user to
  // /register first.
  | {
      readonly kind: "dm-receive-cmd-agent";
      readonly inbound: TelegramInboundMessage;
    }

  | {
      readonly kind: "dm-registration";
      readonly inbound: TelegramInboundMessage;
    }
  // Callback `confirm_pickup:<packageId>` success — `buildState` resolved
  // the caller and confirmPickup flipped the package status. `result`
  // carries the holder + recipient summaries needed for the holder
  // thanks DM.
  | {
      readonly kind: "callback-pickup";
      readonly inbound: TelegramInboundCallback;
      readonly caller: Resident;
      readonly result: ConfirmPickupResult;
    }
  // Callback `confirm_pickup` rejected because the caller isn't the
  // recipient of the package (lib threw `PICKUP_NOT_RECIPIENT`). Same
  // toast applies when the caller is unregistered (an unregistered
  // user is by definition not the recipient).
  | {
      readonly kind: "callback-pickup-not-recipient";
      readonly inbound: TelegramInboundCallback;
      readonly caller: Resident;
    }
  // Callback `confirm_pickup` rejected because the package is already
  // in `picked_up` status (lib threw `PICKUP_ALREADY_DONE`).
  | {
      readonly kind: "callback-pickup-already-done";
      readonly inbound: TelegramInboundCallback;
      readonly caller: Resident;
    }
  // Callback `confirm_pickup` failed with a generic (recoverable) error
  // — Redis hiccup, Bot API outage, etc. Carries only the resolved
  // language because the toast is the sole user-visible output (the
  // caller's Resident record may not even exist if the lookup threw).
  | {
      readonly kind: "callback-pickup-error";
      readonly inbound: TelegramInboundCallback;
      readonly language: string | null;
    }
  // Callback `confirm_pickup` from an unregistered or anonymous tapper.
  // Treated as not-recipient (same toast) per v2.1 #108.
  | {
      readonly kind: "callback-pickup-unregistered";
      readonly inbound: TelegramInboundCallback;
    }
  // Callback `accept_reception_group:<requestId>` success — the lib
  // flipped the request to `matched`. `result` carries the requester +
  // volunteer summaries and the group-card location.
  | {
      readonly kind: "callback-accept";
      readonly inbound: TelegramInboundCallback;
      readonly volunteer: Resident;
      readonly result: AcceptReceptionRequestResult;
    }
  // `accept_reception_request` rejected because the volunteer is the
  // request's own requester (lib threw `ACCEPT_RECEPTION_SELF_NOT_ALLOWED`).
  // Dedicated toast, keyboard stays live (#101 — another neighbour can still claim).
  | {
      readonly kind: "callback-accept-self";
      readonly inbound: TelegramInboundCallback;
      readonly volunteer: Resident;
    }
  // `accept_reception_request` rejected because the volunteer is on a
  // different street (lib threw `ACCEPT_DIFFERENT_STREET`). Dedicated
  // toast + keyboard stripped (#96 Part B — permanent rejection).
  | {
      readonly kind: "callback-accept-cross-street";
      readonly inbound: TelegramInboundCallback;
      readonly volunteer: Resident;
    }
  // `accept_reception_request` failed with a generic (recoverable) error.
  // Generic retry toast; keyboard stays live so the volunteer can re-tap.
  // Carries only the resolved language because the toast is the sole
  // user-visible output (the volunteer's Resident record may not even
  // exist if the lookup threw or returned null after the gate).
  | {
      readonly kind: "callback-accept-error";
      readonly inbound: TelegramInboundCallback;
      readonly language: string | null;
    }
  // `accept_reception_group` tap from an unregistered tapper (the
  // `isRegisteredResident` gate failed). German /register nudge toast;
  // keyboard stays live so the tapper can register and retry.
  | {
      readonly kind: "callback-accept-unregistered";
      readonly inbound: TelegramInboundCallback;
    }
  // Any callback action that still falls through to the agent (legacy
  // `accept_reception_request`, `decline_reception_request`,
  // `remind_later`, unknown actions, malformed accept_reception_group).
  // `synthetic` is the engineered user-message handed to `sendToAsh`.
  | {
      readonly kind: "callback-agent";
      readonly inbound: TelegramInboundCallback;
      readonly synthetic: string;
    }
  | {
      readonly kind: "group-photo";
      readonly inbound: TelegramInboundMessage;
      readonly resident: Resident | null;
      readonly vision: VisionVerdict;
    }
  | {
      readonly kind: "group-text";
      readonly inbound: TelegramInboundMessage;
      readonly resident: Resident | null;
      readonly classifier: GroupClassifierVerdict;
    };
