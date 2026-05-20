/**
 * Sets the inbound-shape `trigger` attribute on the currently-active
 * OpenTelemetry span so Vercel's Agent Runs view can populate the
 * Trigger column.
 *
 * Why this lives separately from `process-update.ts`: the orchestrator
 * doesn't need to know whether OTel is loadable at runtime — it just
 * calls `deps.setTriggerAttribute?.("telegram-message")` and trusts
 * the factory to wire a real implementation. This module is that wire.
 *
 * Production wiring resolves the OTel `trace` namespace lazily through
 * `experimental-ash`'s bundled `@opentelemetry/api` (the framework's
 * own instrumentation runtime registers the global provider, so by the
 * time inbound webhooks fire there's always an active span). When the
 * peer dependency is missing — unit tests, the spike webhook before
 * Ash is fully wired — the resolver returns `undefined` and the helper
 * is a no-op. The orchestrator's optional-chaining at every call site
 * (`deps.setTriggerAttribute?.(...)`) gives callers a second layer of
 * defence, but the no-op behaviour here is what makes it safe to inject
 * the real helper unconditionally from the factory.
 *
 * The attribute key `trigger` matches the issue's working name (#74).
 * If a framework-canonical alternative key surfaces in
 * `@experimental-ash` later (the docs at ash.labs.vercel.dev/docs do
 * not document one as of writing), swap it here in one place rather
 * than at every call site.
 */

import type { TelegramTriggerKind } from "./process-update.js";

type SetAttributeFn = (key: string, value: string) => void;

interface MinimalSpan {
  setAttribute(key: string, value: string): unknown;
}

interface MinimalTraceApi {
  getActiveSpan(): MinimalSpan | undefined;
}

/**
 * Cached OTel `trace` namespace. `null` means "tried and failed to
 * resolve" — we don't retry on every call. `undefined` means "haven't
 * tried yet". Lazy first-use avoids paying the dynamic-import cost
 * during cold start when no inbound webhook has arrived yet.
 */
let cachedTraceApi: MinimalTraceApi | null | undefined;

async function resolveTraceApi(): Promise<MinimalTraceApi | null> {
  if (cachedTraceApi !== undefined) return cachedTraceApi;
  try {
    // `@opentelemetry/api` is an optional peer dependency of
    // `experimental-ash`. In production deployments it's pulled in
    // transitively through the framework's instrumentation runtime
    // and resolved by the bundler. In unit tests and the spike
    // webhook the import throws; we cache `null` and become a no-op
    // for the rest of the process lifetime.
    //
    // The dynamic-specifier indirection (`String("@opentelemetry/api")`)
    // hides the module name from TypeScript's resolver so typecheck
    // passes without declaring `@opentelemetry/api` as a direct dep.
    // The bundler resolves the real module at build time when it's
    // present and gracefully reports a runtime resolution error when
    // it isn't — the `catch` block below absorbs both cases identically.
    const moduleName = "@opentelemetry/api";
    const otel = (await import(moduleName)) as {
      trace?: MinimalTraceApi;
    };
    cachedTraceApi = otel.trace ?? null;
  } catch {
    cachedTraceApi = null;
  }
  return cachedTraceApi;
}

/**
 * Production wiring for `ProcessUpdateDeps.setTriggerAttribute`. The
 * resolver fires lazily on the first inbound webhook, then every
 * subsequent call is a cheap cached lookup.
 *
 * Best-effort: any failure to find the OTel API or the active span
 * is silently swallowed. The attribute is observability metadata —
 * losing it must never crash a webhook delivery.
 */
export function setTelegramTriggerAttribute(trigger: TelegramTriggerKind): void {
  // Fire-and-forget — we don't await the resolver because the resolver
  // is a microtask-cheap cached lookup after the first call, and the
  // span is needed synchronously inside the inbound handler. The first
  // delivery on a cold start may race the import; subsequent deliveries
  // hit the cache. A miss on the first delivery is acceptable — the
  // dashboard's other observability signals (turn count, tokens) still
  // populate.
  void resolveTraceApi().then((api) => {
    if (api === null) return;
    try {
      api.getActiveSpan()?.setAttribute("trigger", trigger);
    } catch {
      // setAttribute on a no-op span throws on some bundler shims —
      // swallow rather than crash an inbound delivery.
    }
  });
}

// Exported only for test injection: lets callers compose their own
// span-attribute target around an arbitrary `setAttribute` callback.
// Currently unused by production code but kept as a documented seam
// for future migration to a typed Ash-canonical key.
export function makeTriggerAttributeSetter(setAttribute: SetAttributeFn): (
  trigger: TelegramTriggerKind,
) => void {
  return (trigger) => setAttribute("trigger", trigger);
}
