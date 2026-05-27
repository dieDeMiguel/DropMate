import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const [, , planAndPrd, maxIterations, explicitBranch] = process.argv;

// Worktree isolation per branch.
//
// Sandcastle's `docker()` provider defaults to `branchStrategy: { type: "head" }`
// which BIND-MOUNTS THE HOST REPO ROOT DIRECTLY into the container. Any commit
// the agent makes lands on the host's currently-checked-out branch, and parallel
// sandcastle runs share the same .git directory. We hit both failure modes once:
// a Slice 2 attempt committed straight onto local `main` and closed the issue
// from inside the container without any PR review.
//
// `branchStrategy: { type: "branch", branch }` instead tells sandcastle to
// `git worktree add` an isolated worktree on the named branch and bind-mount
// THAT. Each invocation gets its own filesystem state. Parallel runs on
// different branches no longer race on the host's working tree or .git.
//
// Branch name precedence:
//   1. 3rd CLI arg if provided (e.g. `pnpm sandcastle "133" 3 feat/foo`)
//   2. `sandcastle/<issue-or-prd-slug>` derived from the 1st arg
const branch =
  explicitBranch ?? `sandcastle/${planAndPrd ?? "default"}`;

await run({
  sandbox: docker(),
  agent: claudeCode("claude-sonnet-4-6"),
  promptFile: `.sandcastle/sandcastle-prompt.md`,
  branchStrategy: { type: "branch", branch },
  maxIterations: Number(maxIterations) ?? 3,
  promptArgs: {
    INPUTS: planAndPrd,
  },
  hooks: {
    onSandboxReady: [{ command: "pnpm install" }],
  },
  completionSignal: "<promise>NO MORE TASKS</promise>",
});
