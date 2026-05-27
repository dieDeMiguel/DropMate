import type { Resident } from "../../redis.js";
import type { ClassifierVerdict, GroupClassifierVerdict, State, VisionVerdict } from "./state.js";
import type { Inbound } from "./event.js";

/**
 * Dependencies the `buildState` I/O orchestrator needs.
 *
 * These mirror the relevant fields on `ProcessUpdateDeps` so the
 * factory can wire the same dep handles. Defined here rather than
 * importing from the legacy dispatcher so the orchestrator module
 * stays decoupled from `process-update.ts`.
 */
export interface BuildStateDeps {
  readonly getRegisteredResident: (userId: number) => Promise<Resident | null>;
  readonly parsePackagePhoto: (input: {
    imageUrl: string;
    caption?: string;
  }) => Promise<VisionVerdict>;
  readonly getFileUrl: (fileId: string) => Promise<string>;
  readonly classifyDmIntent: (input: {
    text: string;
    languageHint?: string;
  }) => Promise<ClassifierVerdict>;
  readonly classifyGroupMessage: (input: {
    text: string;
    languageHint?: string;
  }) => Promise<GroupClassifierVerdict>;
}

/**
 * Pre-computes the full context for an inbound update and returns the
 * appropriate `State` variant (ADR D3). `match` is pure-synchronous;
 * all async I/O happens here before `match` is called.
 *
 * The builder is a mechanical dispatch on inbound kind only — no
 * business logic. All arms currently throw because Slices 3–6 have
 * not landed. Once a slice lands, its arm is replaced with the real
 * I/O fan-out and the `throw` is deleted.
 *
 * Orchestration entry point:
 *
 *   const state   = await buildState(inbound, deps);
 *   const { actions } = match(state);
 *   await runActions(actions, deps);
 */
export async function buildState(
  inbound: Inbound,
  _deps: BuildStateDeps,
): Promise<State> {
  switch (inbound.kind) {
    case "dm":
      throw new Error(
        "buildState dm: not yet migrated — see Slices 3–5 (#134–#136)",
      );

    case "group":
      throw new Error(
        "buildState group: not yet migrated — see Slice 6 (#137)",
      );

    case "callback":
      throw new Error(
        "buildState callback: not yet migrated — see Slice 4 (#135)",
      );

    default: {
      const _exhaustive: never = inbound;
      throw new Error(`buildState: unhandled inbound kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
