# CONTEXT

You are running inside ONE iteration of a host loop driven by
`scripts/docker-sandbox/run-claude-afk.sh --source github-issues`. Each
iteration spawns a fresh `claude` process; when it ends, you are killed
and a new instance starts for the next iteration. Your scope is exactly
one open GitHub Issue.

You receive at the top of context:

- The output of `gh issue list --state open --json number,title,body,comments`
- The last 5 git commits (so you know what previous iterations already did)

If there are zero open issues, output exactly:

    <promise>NO MORE TASKS</promise>

The host watches for this token and exits the loop. Do not output it
otherwise.

# TASK SELECTION

Pick exactly one open issue, prioritized in this order:

1. **Critical bugfixes** — anything blocking other work.
2. **Development infrastructure** — tests, types, dev scripts. These gate
   everything else; build them before features.
3. **Tracer bullets for new features** — a thin end-to-end slice through
   every layer (service + route + UI + tests) that produces a thing a
   human can open in a browser at the end of the iteration. Strongly
   prefer these over horizontal-layer issues. See
   `docs/ISSUE-GUIDELINES.md` for what a well-shaped issue looks like.
4. **Polish and quick wins.**
5. **Refactors.**

If you spot a horizontal-layer issue ("build the service" with no caller,
"build the UI" with no data) and a vertical-slice alternative exists in
the queue, pick the vertical slice. If the only open issues are
horizontal, leave a comment proposing the rewrite rather than silently
executing the layer.

# EXPLORATION

Read the issue body and any comments carefully — they are the spec.
Then walk the codebase to understand existing patterns: naming, file
structure, test conventions, imports. Do not start editing until you've
read at least one comparable existing example to pattern-match against.

# IMPLEMENTATION

Complete the task. Edit code directly — no subagents, no Task tool
delegation.

If touching testable business logic, follow red-green-refactor: write
the failing test first, make it pass with the simplest code, then
refactor under green.

# FEEDBACK LOOPS

Run sequentially. Fix before moving on:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm lint` (if the project has one)

Do not commit if any check fails. If a feedback loop hits an error that
matches a skill in `.claude/skills/` (e.g. `cross-platform-deps-rebuild`,
`better-sqlite3-rebuild`), follow that skill's remediation rather than
inventing your own.

If the pre-commit hook fails because of a pre-existing error outside
your scope, make the minimal fix to unblock and document it explicitly
in the commit message under a "Pre-existing fix" section. Do not skip
the hook with `--no-verify`.

# COMMIT

Make ONE git commit before closing the issue. Commit message format:

    RALPH: <one-line summary>

    - Issue: #<number>
    - Decisions: <key decisions made>
    - Files: <files changed>
    - Notes: <blockers or notes for next iteration>

# THE ISSUE

After the commit lands:

- If the task **fully resolves** the issue:

      gh issue close <number> --comment "<short summary of what shipped>"

- If the task **partially resolves** it:

      gh issue comment <number> --body "<what was done, what remains>"

Then stop your turn.

# FINAL RULES

- ONLY WORK ON ONE ISSUE PER ITERATION.
- Do not pre-emptively pick a "next" issue while you have an active one.
- Do not amend prior commits — always create new ones.
- Do not skip hooks (`--no-verify`).
- Do not spawn subagents or use the Task tool. Work directly.
- Do not start long-running processes (`pnpm dev`, `npm start`) — they
  hang the sandbox.
