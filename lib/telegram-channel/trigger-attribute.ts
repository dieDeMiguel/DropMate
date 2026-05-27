/**
 * Sets the inbound-shape `trigger` attribute on the currently-active
 * OpenTelemetry span so Vercel's Agent Runs view can populate the
 * Trigger column.
 *
 * Why this lives separately from `process-update.ts`: the orchestrator
 * doesn't need to know how the attribute lands on the span — it just
 * calls `deps.setTriggerAttribute("telegram.text-dm")` and trusts the
 * factory to wire a real implementation. This module is that wire.
 *
 * Synchronous setAttribute on the active span is the canonical OTel
 * pattern. Earlier revisions of this helper resolved the API via
 * dynamic import + fire-and-forget `.then(...)`, which created a
 * timing ambiguity: the microtask could drain after `sendToAsh` had
 * already advanced past the span-open synchronous block, landing the
 * attribute on a sibling rather than the parent of the `ash.turn`
 * span. With a static import the call site sets the attribute on the
 * span that's active at the precise point of invocation — no
 * microtask delay, no fire-and-forget race.
 *
 * `@opentelemetry/api` is declared as a direct dependency (it's
 * already pulled in transitively via `experimental-ash`'s
 * instrumentation runtime + `@vercel/otel`; declaring it explicitly
 * pins the version we compile against and lets us drop the dynamic-
 * specifier indirection). Failures still propagate as silent no-ops:
 * `setAttribute` throws on some bundler shims and we never want
 * observability metadata to crash an inbound webhook delivery.
 *
 * The attribute key `trigger` matches #74's working name. If a
 * framework-canonical alternative key surfaces in `experimental-ash`
 * later, swap it here in one place rather than at every call site.
 *
 * Coarse channel attribution (`telegram` for the dashboard's channel
 * chip) lives separately via `kindHint: "telegram"` on the channel
 * definition itself; this helper layers the finer-grained per-shape
 * value on top so Agent Runs filters can tell text DMs apart from
 * button taps and photo uploads.
 */

import { trace } from "@opentelemetry/api";

import type { TelegramTriggerKind } from "./process-update.js";

type SetAttributeFn = (key: string, value: string) => void;

/**
 * Production wiring for `ProcessUpdateDeps.setTriggerAttribute`. Reads
 * the active span synchronously via the OTel global trace API and
 * stamps the `trigger` attribute on it. No-op if there's no active
 * span (e.g. unit tests, the spike webhook before Ash's
 * instrumentation runtime registers a global provider).
 *
 * Best-effort: any failure (no active span, span shim that throws on
 * setAttribute) is silently swallowed. Losing the attribute is
 * acceptable; crashing the inbound delivery is not.
 */
export function setTelegramTriggerAttribute(trigger: TelegramTriggerKind): void {
  try {
    trace.getActiveSpan()?.setAttribute("trigger", trigger);
  } catch {
    // setAttribute on a no-op span throws on some bundler shims —
    // swallow rather than crash an inbound delivery.
  }
}

// Exported only for test injection: lets callers compose their own
// span-attribute target around an arbitrary `setAttribute` callback.
// Currently unused by production code but kept as a documented seam
// for future migration to a typed framework-canonical key.
export function makeTriggerAttributeSetter(
  setAttribute: SetAttributeFn,
): (trigger: TelegramTriggerKind) => void {
  return (trigger) => setAttribute("trigger", trigger);
}
