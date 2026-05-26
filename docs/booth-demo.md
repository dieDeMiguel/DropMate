# Booth demo — live diagram

Rendered at `https://drop-mate-delta.vercel.app/` (root). Static files
live in `public/`; the diagram consumes the SSE feed at `/api/trace`
served by `lib/telegram-channel/trace-routes.ts`.

## Box layout (v2.1 #124 — Vercel-primitives GTM redesign)

The diagram boxes name Vercel primitives, not application-internal
roles. The story a sales-engineering audience walks away with: an
Ash agent on Vercel takes very few primitives to ship.

| Box                  | Vercel primitive    | Code surface                                                           | Lights on                                                                  |
| -------------------- | ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| TELEGRAM             | external            | Bot API (inbound webhook + outbound `sendMessage`)                    | Every inbound; every channel-deterministic DM; every agent-drain message   |
| ASH CHANNEL          | `defineChannel`     | `lib/telegram-channel/*` (entry: `processInboundTelegramUpdate`)       | Every inbound past verify+parse                                            |
| ASH TOOLS            | `defineTool`        | `agent/tools/*` invoked deterministically by the channel                | `flow1`, `flow2`, `registration`, `pickup` stages                          |
| ASH AGENT            | `defineAgent`       | `ash.turn` — `agent/agent.ts` instructions + tool loop                  | Fallthrough: Flow 1 photo + recipient resolution, Flow 3, language, cron   |
| VERCEL AI GATEWAY    | external (Vercel)   | `@ai-sdk/gateway` — model routing layer                                 | Either child badge fires (frame lights when gemini OR claude fires)        |
| · gemini-2.5-flash   | model badge         | `classify_dm_intent`, `parse_label`, `parse_tracking_page` calls       | `classifier`, `vision` stages                                              |
| · claude-opus-4.7    | model badge         | `ash.turn` chooses claude for the agent loop                            | `agent` stage                                                              |
| ASH SCHEDULES        | `defineSchedule`    | `agent/schedules/*` (4h / 48h / 3d / 7d reception-request timers)       | `schedule` stage (wired in Slice 2 of #123, not emitted today)             |
| UPSTASH REDIS        | Vercel Marketplace  | `lib/redis.ts`                                                          | `redis` stage (forward-looking; not emitted today)                          |

Below the grid, a dim always-on substrate strip names the runtime
substrate: `Running on Vercel · Fluid Compute · Sandbox · OTel
@vercel/otel`.

The right-side log panel is now headed `VERCEL OBSERVABILITY · AGENT
RUNS TRACE`.

## Trace event vocabulary

Each `emitTrace(stage, phase, extras?)` call in
`lib/telegram-channel/process-update.ts` names a stage; the engine
(`public/diagram.js`) looks up `STAGE_PLAN[stage]` to decide which
box(es) to ignite and which cable to run. Multi-target stages light
a primary box plus secondary badges/frames; error flashes target the
primary.

| Stage          | Lights up                                                  | Phases used                                                                          |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `channel`      | ASH CHANNEL                                                | `start`                                                                              |
| `registration` | ASH TOOLS                                                  | `start`, `end`                                                                       |
| `classifier`   | AI GATEWAY · gemini-2.5-flash badge + frame                | `start`, `end`, `error`                                                              |
| `vision`       | AI GATEWAY · gemini-2.5-flash badge + frame                | `start`, `end`, `error`                                                              |
| `flow1`        | ASH TOOLS                                                  | `register.start`, `register.end`, `register.error`, `silent`, `fallthrough`, `reject.holder-not-registered` |
| `flow2`        | ASH TOOLS                                                  | `create.start`, `create.end`, `accept.start`, `accept.end`, `vlc`, `reject.self`, `reject.cross-street`, `reject.redis-hiccup` |
| `agent`        | ASH AGENT (primary) + AI GATEWAY · claude-opus-4.7 + frame | `start` (the channel falls through to `sendToAsh`)                                   |
| `dm`           | TELEGRAM (channel→telegram return cable)                   | `start`, `end`, `error` (channel-side deterministic outbound DMs)                    |
| `pickup`       | ASH TOOLS                                                  | forward-looking — not emitted today                                                  |
| `redis`        | UPSTASH REDIS                                              | forward-looking — not emitted today                                                  |
| `schedule`     | ASH SCHEDULES                                              | wired in Slice 2 of #123                                                             |

Phases ending in `.start` ignite the box + run the cable; phases
ending in `.end` lock the box in hold state; `error`, `vlc`, and any
`reject.*` flash the primary box red briefly.

## The booth narrative

The diagram exists to make two structural facts visible to a booth
visitor:

1. **On channel-deterministic paths, the ASH AGENT box does not
   light up.** Registration, Flow 2 free-text, `/receive`, Flow 2
   photo, and volunteer-accept all return from
   `processInboundTelegramUpdate` before reaching
   `deps.sendToAsh(...)`. The agent is a sidekick called for Flow 1
   photo + recipient resolution, Flow 3, language, and cron — not
   for the common case.
2. **The expensive AI model only fires when it has to.** The two AI
   Gateway badges light INDEPENDENTLY — `gemini-2.5-flash` carries
   every tool-style LLM call (classify, parse_label,
   parse_tracking_page), and the more expensive `claude-opus-4.7`
   only lights on the agent fallthrough path.

## Verification

Pre-deploy:

- `pnpm typecheck` and `pnpm test` must be green.
- `tests/diagram.test.ts` is the smoke test for `public/diagram.js`.

Post-deploy:

- `vercel --prod` then open the root URL.
- Send a real Flow 2 DM from a registered Telegram account; watch
  ASH CHANNEL → ASH TOOLS → TELEGRAM light up while ASH AGENT and
  the claude-opus badge stay unlit.
- Send a group photo (Flow 1); confirm ASH CHANNEL → AI GATEWAY
  (gemini badge) → ASH AGENT (+ claude badge) lights up.

## Local-dev iteration (#104)

The bot's webhook URL points at the production deploy, so a localhost
`pnpm dev` session never sees real Telegram traffic — the diagram
renders correctly but nothing ever ignites. Iterating on box layout,
cable timing, or ignite/heartbeat tuning would otherwise require
ngrok + repointing the Telegram webhook, or deploying every tweak to
preview.

To unblock that loop, the channel exposes a dev-only synthetic seed:

```bash
pnpm dev                         # in one terminal
pnpm seed-diagram                # in another — lights every box once

# Loop the seed 5 times, rotating text → photo → callback accents:
pnpm seed-diagram --loop 5

# Different host or port? Override the emit URL:
EMIT_URL=http://127.0.0.1:3001/api/trace/dev/emit pnpm seed-diagram
```

What the script does:

- POSTs synthetic events to `/api/trace/dev/emit` with a shared
  `traceId` so the diagram groups them into one trace.
- Walks the canonical sequence `channel → registration → classifier
  → vision → flow2 (create + accept) → agent → redis → schedule →
  dm`, lighting every actor box on the v2.1 #124 layout (including
  `ASH SCHEDULES` and `UPSTASH REDIS`) with a 600ms hop delay
  matching the diagram's `MIN_HOP_MS`.

Local dev (`NODE_ENV` unset or `development`) is permissive — no
token required.

## Production demo seeding (#125 — Slice 2 of #123)

Sales-engineering demos hit production directly. The `4h / 48h / 3d
/ 7d` schedules fire too rarely to be observable in a ~10-minute
pitch, so without a way to trigger synthetic events on prod the
`ASH SCHEDULES` box never lights up during a demo. The same dev-emit
endpoint accepts authenticated production traffic when a demo token
is configured.

### `DEMO_TRACE_TOKEN`

- **What it is:** a random shared secret. The `/api/trace/dev/emit`
  endpoint accepts a POST in production iff the request includes an
  `X-Demo-Token` header whose value matches `DEMO_TRACE_TOKEN`. Any
  other request (missing header, wrong header, or unset env var)
  receives a plain `404 Not Found` — byte-identical to a missing
  route, so an outsider can't tell whether an authenticated endpoint
  lives at this path.
- **Where to set it:** Vercel project env (Project → Settings →
  Environment Variables → Production). Keep it out of the repo; the
  `.env`/`vercel env pull` flow is the operator's tool of choice.
- **Blast radius if it leaks:** the only side effect of a successful
  call is publishing trace events on the in-process bus that the SSE
  feed (`/api/trace`) drains. No Redis writes, no Telegram sends,
  no Package or ReceptionRequest mutations. The worst an attacker
  can do is pollute the booth-demo diagram's visible log for the
  duration of their session. Rotate the token periodically; a single
  page reload recovers from any contamination.

### Usage from a laptop

```bash
DEMO_TRACE_TOKEN=… \
EMIT_URL=https://drop-mate-delta.vercel.app/api/trace/dev/emit \
pnpm seed-diagram
```

Or pass the token explicitly via `--token`:

```bash
EMIT_URL=https://drop-mate-delta.vercel.app/api/trace/dev/emit \
pnpm seed-diagram --token "$(vercel env pull --yes && grep ^DEMO_TRACE_TOKEN .env.local | cut -d= -f2)"
```

### Smoke-check the production guard

```bash
# Wrong / missing token → 404 (byte-identical to a missing route).
curl -i -X POST https://drop-mate-delta.vercel.app/api/trace/dev/emit \
  -H 'content-type: application/json' \
  -d '{"stage":"channel","phase":"start"}'
# → HTTP/2 404
# → Not Found
```

### Implementation

- `lib/telegram-channel/trace-dev-routes.ts` — handler, production
  guard, constant-time token check.
- `lib/telegram-channel/factory.ts` — mounts the POST route.
- `scripts/seed-diagram.sh` — canonical seed sequence; accepts
  `--token` and reads `DEMO_TRACE_TOKEN` from the environment;
  attaches `X-Demo-Token` automatically when present.
