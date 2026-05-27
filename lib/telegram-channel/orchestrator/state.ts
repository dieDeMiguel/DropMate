import type { PackageCarrier } from "../../redis.js";
import type { Resident } from "../../redis.js";
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
 */
export type State =
  | {
      readonly kind: "dm-photo";
      readonly inbound: TelegramInboundMessage;
      readonly resident: Resident | null;
      readonly vision: VisionVerdict;
    }
  | {
      readonly kind: "dm-text";
      readonly inbound: TelegramInboundMessage;
      readonly resident: Resident;
      readonly classifier: ClassifierVerdict;
    }
  | {
      readonly kind: "dm-receive-cmd";
      readonly inbound: TelegramInboundMessage;
      readonly resident: Resident | null;
    }
  | {
      readonly kind: "dm-registration";
      readonly inbound: TelegramInboundMessage;
    }
  | {
      readonly kind: "callback-pickup";
      readonly inbound: TelegramInboundCallback;
      readonly resident: Resident;
      readonly packageId: string;
    }
  | {
      readonly kind: "callback-accept";
      readonly inbound: TelegramInboundCallback;
      readonly resident: Resident;
      readonly requestId: string;
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
