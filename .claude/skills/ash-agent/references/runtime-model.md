# Runtime Model Reference

Key runtime ideas for app authors:

- `ash info` resolves and validates the authored surface
- `ash build` compiles artifacts and host output
- `ash dev` starts local development and the REPL
- `POST /.well-known/ash/v1/message` starts or resumes a run
- `GET /.well-known/ash/v1/runs/:runId/stream` streams lifecycle events

Important mental model:

- message execution is durable
- follow-up turns can resume the same run
- tools execute inside framework-owned runtime wrappers
- subagents run as child runs
- channels own auth, delivery policy, and per-turn context seeding
- `onDeliver()` can write durable serializable context before the step runs
- channel classes can declare `static readonly contextProviders = [...]` to rebuild live
  non-serializable step-local values after `onDeliver()`
- Slack channels handle custom `block_actions` inline via `handleInteraction(ctx, interaction)` and
  use `getSlackThread()` / `editMessage(messageTs, renderable)` for Slack-native reads and updates
- tools and other authored step code read those values through unified context helpers such as
  `requireContext(...)`
