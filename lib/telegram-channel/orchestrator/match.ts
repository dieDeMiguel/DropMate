import type { Action } from "./action.js";
import type { State } from "./state.js";

/**
 * Pure synchronous dispatcher (ADR D1).
 *
 * Takes a fully-built `State` and returns the ordered list of `Action`
 * values the runner should execute. Every `state.kind` arm must be
 * present — the `never`-typed default enforces exhaustiveness at
 * compile time. Adding a new inbound shape to `State` without a
 * corresponding arm here is a TypeScript error.
 *
 * All arms currently throw "not yet migrated" because Slices 3–6 have
 * not landed. Once a slice lands, its arm is replaced with the real
 * action list and the `throw` is deleted.
 */
export function match(state: State): { state: State; actions: Action[] } {
  switch (state.kind) {
    case "dm-registration":
      throw new Error("dm-registration: not yet migrated — see Slice 3 (#134)");

    case "callback-pickup":
      throw new Error("callback-pickup: not yet migrated — see Slice 4 (#135)");

    case "callback-accept":
      throw new Error("callback-accept: not yet migrated — see Slice 4 (#135)");

    case "dm-photo":
      throw new Error("dm-photo: not yet migrated — see Slice 5 (#136)");

    case "dm-text":
      throw new Error("dm-text: not yet migrated — see Slice 5 (#136)");

    case "dm-receive-cmd":
      throw new Error("dm-receive-cmd: not yet migrated — see Slice 5 (#136)");

    case "group-photo":
      throw new Error("group-photo: not yet migrated — see Slice 6 (#137)");

    case "group-text":
      throw new Error("group-text: not yet migrated — see Slice 6 (#137)");

    default: {
      const _exhaustive: never = state;
      throw new Error(`match: unhandled state kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
