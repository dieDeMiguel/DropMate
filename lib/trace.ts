/**
 * Live-diagram tracer — the smoke-test slice for issue #58.
 *
 * Three exports the rest of the pipeline cares about:
 *
 *   - `runWithTrace(ctx, fn)` — enters an AsyncLocalStorage scope so
 *     every nested async call shares the same `traceId` + `kind`.
 *     Wrap one of these around the webhook orchestrator's entry point;
 *     no other layer needs to pass the trace id through by hand.
 *
 *   - `emitTrace(stage, phase, extras?)` — publishes an event onto a
 *     process-wide bus iff we're inside a `runWithTrace` scope. Outside
 *     a scope it's a no-op, so instrumentation never crashes (or even
 *     allocates) code paths that haven't entered the tracer yet — e.g.
 *     unit tests, cron schedules, the built-in Ash API channel.
 *
 *   - `subscribe(handler)` — registers a listener for emitted events.
 *     The SSE route uses this to push events to the browser; tests use
 *     it to assert events fire from the right scope.
 *
 * Why a Node EventEmitter on `globalThis` instead of a service-y class:
 *
 *   - Stealth-mode app; one Vercel function instance handles all the
 *     traffic at booth scale. A cross-instance bus would need Upstash
 *     pub/sub, which is overkill and adds infra surface for nothing.
 *   - Sticking the bus on `globalThis.__traceBus` survives module-graph
 *     duplication that hot-reloaders sometimes cause (`ash dev`'s Nitro
 *     watcher reloads route modules but not the global scope). One bus
 *     instance per process is what we want.
 *
 * AsyncLocalStorage propagation note: Vercel's `waitUntil` is the only
 * boundary in the inbound pipeline that historically broke ALS
 * propagation (depended on Promise wrapping). When wiring instrumentation
 * inside `drainSession`, log `getStore()` to confirm the trace context
 * survives — if not, the fallback is explicit `traceId` threading per
 * #59's acceptance criteria. For this smoke-test slice we only emit at
 * the orchestrator's synchronous entry point so the question doesn't
 * come up yet.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";

/**
 * The shape of an event that lands on the bus. `traceId` + `kind`
 * come from the surrounding `runWithTrace` scope; `stage`/`phase`/
 * `extras` come from the `emitTrace` call site; `ts` is stamped at
 * publication time so subscribers don't need their own clock.
 */
export interface TraceEvent {
  readonly traceId: string;
  readonly kind: TraceKind;
  readonly stage: string;
  readonly phase: string;
  readonly ts: number;
  readonly extras?: Readonly<Record<string, unknown>>;
}

/**
 * Trace kinds drive the page's accent colour (text=cyan, photo=amber,
 * callback=magenta — slices #59-61 add the latter two). Stored on the
 * ALS context so every downstream `emitTrace` inherits it for free.
 */
export type TraceKind = "text" | "photo" | "callback";

/**
 * What `runWithTrace` carries through the async chain. Intentionally
 * minimal — anything bigger would tempt callers to thread business
 * state through the tracer, which conflates concerns.
 */
export interface TraceContext {
  readonly traceId: string;
  readonly kind: TraceKind;
}

const als = new AsyncLocalStorage<TraceContext>();

/**
 * One global bus per process, stashed on `globalThis` so module-graph
 * duplication (Nitro's dev-time watcher) doesn't end up with two
 * independent emitters. The cast through a brand symbol keeps the
 * surface narrow without requiring TypeScript declaration merging on
 * the global namespace.
 */
const BUS_KEY = "__dropmateTraceBus" as const;
type BusHolder = { [BUS_KEY]?: EventEmitter };

function getBus(): EventEmitter {
  const holder = globalThis as unknown as BusHolder;
  let bus = holder[BUS_KEY];
  if (!bus) {
    bus = new EventEmitter();
    // Subscribers per process: SSE clients + tests. The default cap of
    // 10 trips warnings at booth scale; raise it to a small bounded
    // value so we still notice runaway-listener bugs.
    bus.setMaxListeners(64);
    holder[BUS_KEY] = bus;
  }
  return bus;
}

const EVENT_NAME = "trace";

/**
 * Enter a tracing scope. Every `emitTrace` invoked inside `fn`
 * (including across awaits) inherits the same `traceId` + `kind`.
 *
 * The function's return value is forwarded so callers can write
 * `return runWithTrace({...}, () => processInboundTelegramUpdate(...))`
 * without splitting the orchestrator entry into two statements.
 */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/**
 * Emit a trace event. Silently no-ops when called outside a
 * `runWithTrace` scope — instrumentation calls are safe to leave in
 * code paths that aren't always traced (cron schedules, unit tests).
 */
export function emitTrace(
  stage: string,
  phase: string,
  extras?: Readonly<Record<string, unknown>>,
): void {
  const store = als.getStore();
  if (!store) return;
  const event: TraceEvent = {
    traceId: store.traceId,
    kind: store.kind,
    stage,
    phase,
    ts: Date.now(),
    ...(extras !== undefined ? { extras } : {}),
  };
  getBus().emit(EVENT_NAME, event);
}

/**
 * Subscribe a handler to the trace bus. Returns an `unsubscribe`
 * function so callers (the SSE route, tests) clean up listeners on
 * disconnect without leaking entries.
 */
export function subscribe(handler: (event: TraceEvent) => void): () => void {
  const bus = getBus();
  bus.on(EVENT_NAME, handler);
  return () => {
    bus.off(EVENT_NAME, handler);
  };
}

/**
 * Test-only helper: read the current ALS store. Exposed for unit tests
 * that need to assert the scope propagates across awaits without
 * having to call `emitTrace` and observe a side effect.
 */
export function getCurrentTraceContext(): TraceContext | undefined {
  return als.getStore();
}
