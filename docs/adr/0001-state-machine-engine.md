# ADR 0001 — State machine engine for the Telegram channel orchestrator

- **Status**: Accepted
- **Date**: 2026-05-27
- **Decision maker**: Diego (HITL via `/grill-me` session)
- **Slice**: This ADR is the deliverable of **Slice 1** of the state-machine refactor umbrella. Slices 2–7 implement what's locked here.

## Context

The 2026-05-26 repository audit (full report in conversation history) found `lib/telegram-channel/process-update.ts` (~3700 lines) carries ~35% accidental complexity, surfaced as:

1. A 10-arm if/else dispatcher inside `processInboundTelegramUpdate`.
2. Per-route helpers (`routeDmPhoto`, `routeDmTextThroughClassifier`, `routeGroupTextThroughClassifier`, etc.) each returning their own discriminated-union result type, with duplicated error handling, copy composition, and trace emission across surfaces.
3. A welcome-wall failure mode on Flow 2 DM text (medium-confidence classifier → agent fallthrough → model regresses to training prior), which the dispatcher's runtime checks cannot prevent.

The audit's Choice C — **replace the dispatcher with an explicit state machine** — was selected over Choice A (locale registry) and Choice B (delete agent's write tools). Headline goal: **compile-time impossibility for the welcome-wall failure class** by exhaustiveness-checking every `(inbound × residentState × classifierVerdict) → action[]` pair.

This ADR locks the engine shape so Slice 2 has a definite specification.

## Decisions

### D1. Engine: hand-rolled `match` over xstate

A pure function `match(state: State): { state: State; actions: Action[] }` implemented as a `switch` on the `state.kind` discriminator. No runtime dependency.

**Why hand-rolled:**

- DropMate is server-side request-response. Every webhook is independent; no cross-request state, no actor spawning, no statechart hierarchy.
- xstate's value (actors, visualizer, parent/child, history states) maps to zero DropMate use cases.
- TypeScript's `never`-typed default branch gives exhaustiveness for free.
- ~200 LOC ceiling vs. xstate's 50KB+ runtime + 400–500 LOC of idiomatic config for the same surface.
- Slice 7's test migration is "replace orchestrator calls with `match` calls" — no SDK setup.

**Trade-off accepted:** no visualizer (DropMate has no UI to consume it); no ecosystem familiarity discount.

### D2. State vocabulary: variant-per-inbound-kind discriminated union

`State` is a discriminated union with one variant per inbound shape. Each variant carries exactly the fields its `match` branch needs.

```ts
type State =
  | { kind: "dm-photo";        inbound: DmInbound;     resident: Resident | null; vision: VisionVerdict }
  | { kind: "dm-text";         inbound: DmInbound;     resident: Resident;        classifier: ClassifierVerdict }
  | { kind: "dm-receive-cmd";  inbound: DmInbound;     resident: Resident | null }
  | { kind: "dm-registration"; inbound: DmInbound }
  | { kind: "callback-pickup"; inbound: CallbackInbound; resident: Resident; packageId: string }
  | { kind: "callback-accept"; inbound: CallbackInbound; resident: Resident; requestId: string }
  | { kind: "group-photo";     inbound: GroupInbound;  resident: Resident | null; vision: VisionVerdict }
  | { kind: "group-text";      inbound: GroupInbound;  resident: Resident | null; classifier: GroupClassifierVerdict };
```

**Why variant over flat-with-optionals:**

- Touching `state.classifier` inside the `dm-photo` branch is a TypeScript error. Nonsensical access at compile time is the win.
- The `absenceSignal === undefined` class of bug (field exists but is sometimes undefined) becomes structurally impossible.
- Each branch's exhaustiveness is self-contained.

**Trade-off accepted:** more types to import; harder to grep for "all fields a state can carry" (use the discriminated union definition as the authoritative reference).

### D3. I/O placement: pre-compute the context, `match` is pure synchronous

I/O lives in a `buildState(inbound, deps): Promise<State>` function that runs BEFORE `match`. The builder is a mechanical dispatch on inbound kind only — no business logic — and runs the fixed I/O graph for that kind (always-resident-lookup; classifier/vision as needed).

```ts
async function buildState(inbound: Inbound, deps: Deps): Promise<State> {
  if (isDmPhoto(inbound)) {
    const [resident, vision] = await Promise.all([
      deps.getRegisteredResident(inbound.fromUserId),
      deps.parsePackagePhoto({ imageUrl: await deps.getFileUrl(inbound.photoFileId), caption: inbound.text }),
    ]);
    return { kind: "dm-photo", inbound, resident, vision };
  }
  // ...other inbound kinds, each a fixed-graph I/O fetch
}

const state = await buildState(inbound, deps);
const { actions } = match(state);
await runActions(actions, deps);
```

**Why pre-compute over multi-step machine:**

- DropMate's decision tree doesn't actually need multi-step branching — the resident's existence doesn't change which classifier we'd call. The full context is knowable upfront.
- `match` stays pure-synchronous, trivially testable (assert on returned `actions` array given a `state` literal).
- The runner stays a single loop over `actions`; no event-feedback dance.

**Trade-off accepted:** the builder owns the fixed I/O graph (one function, no decisions). If a future flow legitimately needs "based on classifier result, decide whether to also call vision", that's the day to revisit — for now no such flow exists.

#### Amendment (2026-05-27, after Slice 4 / #135)

`buildState` MAY invoke a canonical-state mutation directly **when, and only when, the routing decision in `match` depends on the outcome of that mutation** (e.g. error-code dispatch vs success class). The outcome is then encoded as a State variant. This is the *only* permitted deviation from "mechanical dispatch, no business logic":

- **Reads** (resident lookup, vision, classifier) remain unconstrained — already permitted by D3.
- **Mutations whose outcome is not load-bearing for `match`'s dispatch** stay as runner-executed actions (Tier 2 per D6).

Introduced by Slice 4's callback handling: `confirm_pickup` / `accept_reception_group` taps dispatch on `PICKUP_NOT_RECIPIENT` / `PICKUP_ALREADY_DONE` / `ACCEPT_SELF_NOT_ALLOWED` / `ACCEPT_DIFFERENT_STREET`. The rejected alternatives (multi-step machine with event feedback; impure runner cases routing on error codes) were re-evaluated; the same conclusions held — putting the mutation in `buildState` was the simplest correct shape.

### D4. Trace topology: hybrid — auto-trace side-effect actions, explicit `EmitTrace` actions for decision-only signals

Two trace flavors exist in today's code:

1. **Action-outcome traces** (`flow1.register.start/end/error`, `dm.start/end/error`) wrap a side-effect call. The phase depends on success/failure of the action.
2. **Decision-only traces** (`flow1.fallthrough`, `flow1.silent`, `flow1.reject.holder-not-registered`) mark a routing decision with no side effect.

Under the new shape:

- **Side-effect actions** (`Action.SendDirectMessage`, `Action.RegisterPackage`, etc.) carry a `traceStage` field. The runner emits `<stage>.start` before execution, then `<stage>.end` or `<stage>.error` based on outcome. The engine never sees success/failure.
- **Decision-only traces** are first-class `Action.EmitTrace` actions returned by `match`. The runner emits them in array order alongside other actions.

```ts
type Action =
  | { kind: "register-package"; input: RegisterPackageInput; traceStage: "flow1.register" }
  | { kind: "send-direct-message"; chatId: number; text: string; keyboard?: Keyboard; traceStage: "dm" }
  | { kind: "create-reception-request"; input: CreateReceptionRequestInput; traceStage: "flow2.create" }
  | { kind: "confirm-pickup"; packageId: string; caller: Resident; traceStage: "flow1.pickup" }
  | { kind: "answer-callback"; callbackId: string; text?: string }
  | { kind: "strip-keyboard"; chatId: number; messageId: number }
  | { kind: "emit-trace"; stage: string; phase: string; extras?: Readonly<Record<string, unknown>> }
  | { kind: "log-error"; message: string; meta?: unknown };
```

**Why hybrid:**

- Engine stays pure — tests assert on the action array without mocking the trace bus.
- Action-outcome phasing (start/end/error) lives in the runner where success/error is known.
- Decision-only signals (the welcome-wall diagnostic clue `flow1.fallthrough`, etc.) survive as first-class declared effects.
- The action list is the single source of truth for "what does this decision cause."

**Rejected alternatives:**

- "Runner emits all" — loses decision-only traces (no side effect to attach them to).
- "Engine emits all inline via `emitTrace(...)`" — engine becomes impure, tests need ALS context propagation, re-introduces exactly the impurity the refactor is killing.

#### Amendment (2026-05-27, after Slice 4 / #135)

When `buildState` owns a canonical-state mutation per D3's amendment, it also owns the corresponding action-outcome trace (`<flow>.<stage>.start/end/error`). **Stage names are identical** to what the runner's auto-trace would have emitted for the equivalent action — emit location is implementation detail; stage names are the contract. Inventing a `buildState.*` namespace is explicitly forbidden — trace consumers (live diagram, observability bus, evals) must not need to know which path emitted a given event.

### D5. Action runner: sequential by default, explicit `Action.parallel([...])` for fan-out

Actions in the returned array execute in array order, awaiting each before the next. Concurrency is opt-in via an `Action.parallel([...])` wrapper.

```ts
const actions: Action[] = [
  Action.sendDirectMessage(recipientChatId, "Hab notiert — danke!",  { traceStage: "dm" }),
  Action.sendDirectMessage(holderChatId,    "Melanie picked up...",  { traceStage: "dm" }),
  Action.parallel([
    Action.recordObservation(...),
    Action.emitTrace("flow1", "pickup.end"),
  ]),
];
```

**Why sequential by default:**

- Today's orchestrator is sequential. Migration slice-by-slice (Slices 3–6) preserves exact semantics with zero behavior change per slice.
- The audit flagged a 2–3 week incident risk window. Inverting the runner default during that window doubles the risk for zero immediate benefit.
- Ordered pairs we just shipped (e.g. recipient confirm before holder thanks, `580cdc7`) keep working without per-slice migration vigilance.
- Concurrency we actually want (observation writes, trace emits) is rare and obvious — easy to wrap in `Action.parallel([...])` at the few spots.

**Rejected alternative:** parallel-by-default with `Action.sequence([...])` for ordering — flips today's semantics, makes every existing ordered pair a migration trap.

### D6. Runner tolerance contract (added 2026-05-27, post Slice 4 / #135)

The runner classifies actions into two tiers:

- **Tier 1 — Communication side effects** (`send-direct-message`, `edit-group-card`, `answer-callback`, `strip-keyboard`). The runner catches thrown errors, logs them, emits `<traceStage>.error`, and **continues**. A failed DM never bails a multi-DM flow. Matches the legacy dispatcher's tolerance semantics.
- **Tier 2 — Canonical-state writes** (`register-package`, `create-reception-request`; historically `confirm-pickup` / `accept-reception-request` / `register-resident` until D3's amendment moved them into `buildState`). The runner emits `<traceStage>.error` and **rethrows**. The caller (the webhook handler) decides whether to swallow or surface.

**Compound actions** (e.g. Slice 3's `register-and-confirm-resident`, which atomically writes a resident then DMs the localised confirmation) combine both tiers. Their runner case is the source of truth — it owns the internal try/catch split, deciding which inner step rethrows and which swallows. The runner does **not** auto-classify compound actions; the action's case takes responsibility for the tier mapping.

**Why two tiers:**

- Communication is best-effort by Telegram-channel design: a flaked DM shouldn't roll back canonical state.
- Canonical-state writes are the source of truth; silently swallowing a write failure would diverge the system from reality.
- Single-tier flattening was considered and rejected: always-rethrow breaks the legacy multi-DM tolerance (one flaked DM bails the whole pickup-confirm flow), always-swallow silently loses Redis-write failures.

## Consequences

### Positive

- Compile-time exhaustiveness on `(state.kind) → action[]`. Adding a new inbound shape without a `match` branch fails `tsc`. Welcome-wall class of failure becomes structurally impossible — the agent fallthrough is now one explicit `state.kind === "..."` arm, not a fallthrough in if/else.
- Engine is pure-synchronous; tests assert on the actions array with no async or mock setup.
- Decision-only traces survive (diagnostic signals like `flow1.fallthrough` keep working).
- Migration is incremental — Slices 3–6 each migrate one route family inline; the legacy dispatcher shrinks while the new engine grows.

### Negative

- Slice 7 has to migrate ~220KB of dispatcher-coupled tests (`process-update.test.ts`). Expected, scoped.
- Trace stage strings live in two places (the action's `traceStage` field + the action-runner's stage-phase mapper). Convention: keep the runner's mapper exhaustive over the union of `traceStage` values.
- No visualizer for the booth demo (the live diagram in `public/index.html` already serves that role at a different layer).

## Implementation sketch for Slice 2

Slice 2 lands the foundation only — no route migration:

- `lib/telegram-channel/orchestrator/state.ts` — the `State` discriminated union.
- `lib/telegram-channel/orchestrator/event.ts` — the `Inbound` type (input to `buildState`).
- `lib/telegram-channel/orchestrator/action.ts` — the `Action` discriminated union + helper constructors.
- `lib/telegram-channel/orchestrator/match.ts` — the pure `match(state): { state; actions }` function. Initially empty: every `state.kind` arm throws "not yet migrated — see Slice N". The `never`-typed default at the end pins exhaustiveness.
- `lib/telegram-channel/orchestrator/build-state.ts` — the `buildState(inbound, deps)` I/O orchestrator. Initially empty: throws on every inbound kind.
- `lib/telegram-channel/orchestrator/run-actions.ts` — the runner. Handles every `Action.kind` (action-outcome trace phasing, parallel/sequence semantics, error logging).
- Unit tests for each `Action.kind`'s runner branch (mockable deps).
- Unit tests asserting `match` returns the right `Action[]` for known `State` literals.
- The legacy `processInboundTelegramUpdate` is **untouched** in Slice 2. The new code lives alongside as an unused module.

## Slices 3–6: per-route migration

Each slice picks one inbound-kind family, implements the `buildState` branch + the `match` branch + deletes the corresponding legacy route helper, all in one PR. Coexistence is inline: migrated paths run through the new engine, unmigrated paths stay in the legacy dispatcher.

- **Slice 3**: registration DM (`/start`, `/register`, free-text). Smallest, well-bounded.
- **Slice 4**: callback queries (`confirm_pickup`, `accept_reception_group`).
- **Slice 5**: DM photo + DM text + `/receive`. Largest single migration.
- **Slice 6**: group photo + group text + agent fallthrough. Closes out the migration; the `match` arm for `group-text-classifier-low-conf` (or whatever the explicit fallthrough branch is named) is what kills the welcome wall class of failure.

## Slice 7: legacy dispatcher deletion + dead-code sweep

After Slices 3–6 land, delete the 10-arm if/else in `processInboundTelegramUpdate`, fold the entry shape into the engine entry, migrate the residual tests in `process-update.test.ts`, and clean up the audit's enumerated dead code (orphan `chat-instance.ts`, `@deprecated Flow2ClassificationResult`, unused `absenceSignal`, four `synthesizeCallbackMessage` legacy cases, stale `TEST-PLAN-phase-2.md`).
