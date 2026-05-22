# Booth demo — live diagram

Rendered at `https://drop-mate-delta.vercel.app/` (root). Static files
live in `public/`; the diagram consumes the SSE feed at `/api/trace`
served by `lib/telegram-channel/trace-routes.ts`.

## Box layout (v2.1)

| Box           | Code surface                                                           | Lights on                                                                  |
| ------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| TELEGRAM      | Bot API (inbound webhook + outbound `sendMessage`)                    | Every inbound; every channel-deterministic DM; every agent-drain message   |
| CHANNEL       | `lib/telegram-channel/process-update.ts::processInboundTelegramUpdate` | Every inbound past verify+parse                                            |
| REGISTRATION  | `handleRegistrationDm` + `lib/registration.ts`                         | `/register` or free-text registration DMs                                  |
| CLASSIFIER    | `routeDmTextThroughClassifier` + `agent/tools/classify_dm_intent.ts`   | DM text that passes through the vision-free classifier                     |
| VISION        | `routeDmPhoto` (DM photos via `parse_tracking_page`)                   | DM photo inbound. Group photos call `parse_label` from inside the agent's turn (#79), so they light AGENT + a tool sub-cell rather than VISION. |
| FLOW 2 LIB    | `lib/reception-request.ts`                                             | Flow 2 create (free-text + `/receive` + photo); volunteer-accept callbacks |
| AGENT         | `ash.turn`                                                             | Only fallthrough: Flow 1, Flow 3, language/pickup/delete, cron synthetics  |
| REDIS         | `lib/redis.ts`                                                         | (currently aggregated under the lib box that called it)                    |
| AI GATEWAY    | Vercel AI Gateway                                                      | (currently aggregated under VISION / AGENT)                                |

## Trace event vocabulary

Each `emitTrace(stage, phase, extras?)` call in
`lib/telegram-channel/process-update.ts` names a stage; the engine
(`public/diagram.js`) looks up `STAGE_PLAN[stage]` to decide which box
to ignite and which cable to run.

| Stage          | Phases used                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `channel`      | `start`                                                                              |
| `registration` | `start`, `end`                                                                       |
| `classifier`   | `start`, `end`, `error`                                                              |
| `vision`       | `start`, `end`, `error`                                                              |
| `flow2`        | `create.start`, `create.end`, `accept.start`, `accept.end`, `vlc`, `reject.self`, `reject.cross-street`, `reject.redis-hiccup` |
| `agent`        | `start` (the channel falls through to `sendToAsh`)                                   |
| `dm`           | `start`, `end`, `error` (channel-side deterministic outbound DMs)                    |

Phases ending in `.start` ignite the box + run the cable; phases ending
in `.end` lock the box in hold state; `error`, `vlc`, and any
`reject.*` flash the box red briefly.

## The v2.1 narrative

The diagram exists to make one structural fact visible to a booth
visitor: **on channel-deterministic paths, the AGENT box does not
light up.** Registration, Flow 2 free-text, `/receive`, Flow 2 photo,
and volunteer-accept all return from `processInboundTelegramUpdate`
before reaching `deps.sendToAsh(...)`. The agent is a sidekick called
for Flow 1, Flow 3, language/pickup/delete, and cron synthetics — not
for the common case.

## Verification

Pre-deploy:

- `pnpm typecheck` and `pnpm test` must be green.
- `tests/diagram.test.ts` is the smoke test for `public/diagram.js`.

Post-deploy:

- `vercel --prod` then open the root URL.
- Send a real Flow 2 DM from a registered Telegram account; watch
  CHANNEL → FLOW 2 LIB → TELEGRAM light up while AGENT stays unlit.
- Send a group photo (Flow 1); confirm CHANNEL → VISION → AGENT lights
  up.
