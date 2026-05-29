# DropMate

A multilingual Telegram bot that helps neighbors on a single street or in a single
apartment building coordinate the packages that couriers leave with whoever
happens to be home.

DropMate sits inside an existing Telegram group plus the private 1:1 chats each
resident has with it. It is **additive to the group's normal social
conversation** — it only acts on package-related messages, and it keeps
logistics in DMs so the group stays low-noise.

> Origin: observed in a real Hamburg WhatsApp group (Methfesselstraße). Packages
> sit for days because announcements get buried under party flyers and social
> chat. DropMate is the coordination layer the existing trust culture is
> missing.

---

## What it does

Three flows cover ~all of the coordination value:

| Flow | Trigger | Outcome |
| --- | --- | --- |
| **1 — Package received** | Neighbor posts a label photo or "Paket für Meyer" in the group | Group ack with where it is + DM to the recipient in their language, with a `[Abgeholt]` button to confirm pickup |
| **2 — "I won't be home"** | Resident DMs "Ich erwarte morgen DHL und bin nicht da" or `/receive` | Neutral group card asks for a volunteer. First `[Ich kann helfen]` tap pairs them and DMs both sides privately |
| **3 — "Where is my package?"** | Resident DMs "Wo ist mein Paket?" | Lookup against the registry; if nothing found, optionally ask the group on the resident's behalf |

Cron schedules close the loops: 48h reminders on uncollected packages, 7d
escalation in the group, 4h timeout on unanswered reception requests, 48h
timeout on matched-but-never-arrived ones.

---

## Architecture

DropMate is built on [**Ash**](https://ash.labs.vercel.dev/) — Vercel's
agent framework. Ash is "like Next.js for web apps, but for agents":
Markdown for instructions and skills, TypeScript for tools, durable
execution by default. The whole DropMate codebase is structured around
Ash's primitives.

```
Telegram ── webhook ──> ASH CHANNEL ──┬──> Tools (deterministic Flow 1 / 2 / pickup writes)
                                      │
                                      └──> Ash Agent (Flow 1 clarifications, Flow 3, language ops)
                                                  │
                                                  └──> AI Gateway ── gemini-2.5-flash · claude-opus-4.7
                                                                              │
                                                                              └──> Upstash Redis (EU)
```

| Piece | Tech | What it owns |
| --- | --- | --- |
| Agent framework | [`experimental-ash`](https://ash.labs.vercel.dev/) | [`defineAgent`](https://ash.labs.vercel.dev/docs/agent-ts), [tools](https://ash.labs.vercel.dev/docs/tools), [skills](https://ash.labs.vercel.dev/docs/skills), [channels](https://ash.labs.vercel.dev/docs/channels), [schedules](https://ash.labs.vercel.dev/docs/schedules), [runs/streaming](https://ash.labs.vercel.dev/docs/runs-and-streaming) |
| Chat transport | `@chat-adapter/telegram` (Chat SDK) | Bot API: groups, DMs, photos, inline keyboards |
| Custom channel | `lib/telegram-channel/` | Implements Ash's [`ChannelAdapter`](https://ash.labs.vercel.dev/docs/channels); owns the deterministic Flow 1 / Flow 2 / pickup paths |
| Model routing | Vercel AI Gateway | `gemini-2.5-flash` for classification + vision, `claude-opus-4.7` for the agent loop |
| Storage | Upstash Redis (EU region) | Residents, packages, reception requests, language prefs |
| Time triggers | Ash [`defineSchedule`](https://ash.labs.vercel.dev/docs/schedules) | 48h reminder, 7d escalate, 4h + 48h reception-request timeouts |
| Hosting | Vercel (Fluid Compute) | `ash build` → Functions; webhook at `/api/telegram` |
| Observability | `@vercel/otel` + AI Gateway dashboards | Trace topology defined in [ADR-0001](docs/adr/0001-state-machine-engine.md) |

New to Ash? Start at
[ash.labs.vercel.dev/docs/getting-started](https://ash.labs.vercel.dev/docs/getting-started).

### The key design choice: channel-driven, not agent-driven

The agent does **not** decide whether a group message is a package
registration, parse labels, write packages, post to the group, or process
pickup taps. The channel layer (`lib/telegram-channel/`) does all of that
deterministically. The agent only runs when:

1. Flow 1 classification is low-confidence (a clarifying question to the holder).
2. Flow 3 (package search) — pure question-answering.
3. Language preferences (`/language`, "auf Deutsch bitte").
4. Edge inbounds that slipped past the channel's classifier.

Why: two prior welcome-wall regressions where a freely-generated agent reply
violated the privacy boundary or fabricated logistics that didn't exist.
Channel-deterministic paths make those classes of failure structurally
impossible.

### State-machine orchestrator

The channel runs a pure `match(state): { state; actions }` over a discriminated
union with one variant per inbound shape (`dm-photo`, `dm-text`,
`callback-pickup`, `group-text`, …). I/O is pre-computed by `buildState`, the
runner executes the returned `Action[]` in array order, and TypeScript's
exhaustiveness check is what kills the welcome-wall class of failure at
compile time. Full rationale in
[ADR-0001](docs/adr/0001-state-machine-engine.md).

---

## Repo layout

```
DropMate/
├── agent/
│   ├── agent.ts                # defineAgent — model selection
│   ├── instructions.md         # role, tone, multilingual + privacy rules
│   ├── instrumentation.ts      # OTel via @vercel/otel
│   ├── channels/
│   │   ├── telegram.ts         # mounts lib/telegram-channel
│   │   └── ash.ts              # built-in session API for dev + tests
│   ├── tools/                  # register_resident, lookup_package,
│   │                           # notify_recipient, post_to_group,
│   │                           # classify_*, parse_package_photo,
│   │                           # scan_due_*, mark_*, …
│   ├── skills/expecting_package/
│   ├── hooks/language_detection.ts
│   └── schedules/              # reminder_48h, escalate_7d,
│                               # reception_request_{4h,48h}_timeout
├── lib/
│   ├── redis.ts                # typed Upstash wrappers
│   ├── registration.ts         # Resident writes
│   ├── package.ts              # Package writes
│   ├── pickup.ts               # Pickup confirmation
│   ├── reception-request.ts    # Flow 2 state
│   ├── language.ts             # ISO-639-1 detection + override
│   ├── slash-command.ts        # /register, /language, /receive, /delete
│   ├── trace.ts                # OTel + SSE feed for the booth diagram
│   └── telegram-channel/
│       ├── index.ts            # telegramChannel({ token, webhookSecret })
│       ├── verify.ts           # X-Telegram-Bot-Api-Secret-Token check
│       ├── inbound.ts          # raw update → canonical Inbound
│       ├── process-update.ts   # entry — runs buildState → match → runActions
│       ├── orchestrator/       # state.ts · event.ts · action.ts ·
│       │                       # build-state.ts · match.ts · run-actions.ts
│       ├── flow-1-dms.ts       # channel-deterministic Flow 1 DMs
│       ├── flow-2-dms.ts       # channel-deterministic Flow 2 DMs
│       ├── pickup-dms.ts       # [Abgeholt] tap handling
│       ├── volunteer-accept-dms.ts
│       ├── keyboards.ts        # inline-keyboard builders
│       ├── send.ts             # Bot API sendMessage primitive
│       ├── outbound.ts         # Ash session event → Telegram reply
│       └── trace-routes.ts     # /api/trace SSE feed for the diagram
├── docs/
│   ├── adr/0001-state-machine-engine.md
│   ├── booth-demo.md
│   └── flow-2-v2-revival-plan.md
├── public/                     # static booth diagram (index.html + diagram.js)
├── tests/                      # cross-cutting tests (agent instructions, hooks, tools)
├── PRD-ASH.md                  # full product + technical spec
└── package.json
```

---

## Setup

Six steps, in order. Each one populates one or two env vars; by the end
your `.env.local` is complete and the bot is reachable.

### 1. Prerequisites

- Node 24 (`nvm install 24 && nvm use 24`)
- pnpm via Corepack (`corepack enable`)
- A Telegram account
- A Vercel account

```bash
git clone <this-repo> && cd DropMate
pnpm install
```

### 2. Create the Telegram bot

Open Telegram and DM [`@BotFather`](https://t.me/BotFather):

```
/newbot
<choose a display name>
<choose a username ending in "bot">
```

BotFather replies with an HTTP token. That's `TELEGRAM_BOT_TOKEN`.

While you're there, also set:

```
/setprivacy   → Disable    (so the bot can read group messages, not only
                            messages that mention it)
/setjoingroups → Enable
```

### 3. Generate the webhook secret

Telegram echoes a secret back on every inbound webhook so you can verify
the request came from Telegram and not a random attacker. Generate one
yourself:

```bash
openssl rand -hex 32
```

That's `TELEGRAM_WEBHOOK_SECRET_TOKEN`. Keep it — you'll register it with
Telegram in step 6.

### 4. Link the Vercel project + provision Redis

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest link        # create or pick a project
```

In the Vercel dashboard for the linked project:

- **Storage → Add** → pick **Upstash Redis**, region **EU** (Frankfurt).
  Vercel provisions it via Marketplace and auto-sets `KV_REST_API_URL`,
  `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, `REDIS_URL`
  on the project.
- **AI → Create Gateway** (optional). The default works without this: AI
  SDK auto-detects `VERCEL_OIDC_TOKEN` from `vercel env pull`. Create an
  `AI_GATEWAY_API_KEY` only if you want a long-lived token (OIDC expires
  ~12h) or are running outside Vercel infrastructure.

### 5. Add the Telegram vars to Vercel + pull them down

```bash
pnpm dlx vercel@latest env add TELEGRAM_BOT_TOKEN
pnpm dlx vercel@latest env add TELEGRAM_WEBHOOK_SECRET_TOKEN

pnpm dlx vercel@latest env pull .env.local
```

`.env.local` should now contain:

```
TELEGRAM_BOT_TOKEN=…
TELEGRAM_WEBHOOK_SECRET_TOKEN=…
KV_REST_API_URL=…
KV_REST_API_TOKEN=…
VERCEL_OIDC_TOKEN=…
```

### 6. Register the webhook with Telegram

Deploy first so you have a public URL:

```bash
pnpm dlx vercel@latest deploy --prod
# → https://<your-project>.vercel.app
```

Then point Telegram at `/api/telegram` on that deployment. **The
`allowed_updates` list must include `callback_query`**, or every
inline-button tap (pickup confirmations, volunteer accepts) is silently
dropped:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://<your-project>.vercel.app/api/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET_TOKEN>",
    "allowed_updates": ["message", "edited_message", "callback_query"]
  }'
```

Verify:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
# → expect "url" matches your deployment + "pending_update_count": 0
```

### 7. Add the bot to your group

In Telegram: open the group → group settings → **Add member** → search
the bot's username → **Add as admin** with permissions to read messages
and send messages. (Admin role is needed only because Telegram's privacy
rules restrict non-admin bots from seeing every message even with
privacy disabled.)

DM the bot once from your own account so it has a 1:1 chat open with you,
then register:

```
/register Diego, Methfesselstraße 88, III. Etage
```

You're live.

---

## Running locally

For iteration without redeploying on every change, use Ash's dev server +
an ngrok-style tunnel pointed at the Telegram webhook:

```bash
pnpm dev          # ash dev — local Ash server, channel mounted at /api/telegram
pnpm test         # vitest run
pnpm typecheck    # tsgo
pnpm build        # ash build
```

Then in another terminal expose `localhost:3000` publicly (`ngrok http
3000`, `cloudflared tunnel`, or `vercel dev` with a tunnel) and re-run
the `setWebhook` call from step 6 with the tunnel URL instead of the
production URL. Switch back to the production URL when you're done.

---

## Privacy & GDPR

- **Never in the group**: that a specific resident will be away from home.
  Reception-request group cards are phrased neutrally ("Has anyone received…").
- **Data minimization**: name, street, house number, optional floor / buzzer,
  Telegram ID, language. No movement tracking, no message archives.
- **Right to deletion**: `/delete` wipes the resident's Redis keys.
- **Region**: Upstash EU + Vercel EU.

Full rules: §9 of [`PRD-ASH.md`](PRD-ASH.md) and the boundaries section of
[`agent/instructions.md`](agent/instructions.md).

---

## Booth demo

`public/index.html` renders a live diagram of the architecture that ignites
boxes as real traffic flows through. It consumes `/api/trace` (SSE feed
served by `lib/telegram-channel/trace-routes.ts`). See
[`docs/booth-demo.md`](docs/booth-demo.md) for the box layout and trace
vocabulary.

```bash
pnpm seed-diagram   # replay scripted traffic against a dev deployment
```

---

## Further reading

In this repo:

- [`PRD-ASH.md`](PRD-ASH.md) — full product + technical spec
- [`agent/instructions.md`](agent/instructions.md) — agent role, tone,
  multilingual policy, hard rules learned from prod regressions
- [`docs/adr/0001-state-machine-engine.md`](docs/adr/0001-state-machine-engine.md)
  — why the channel orchestrator is a hand-rolled `match` over xstate
- [`docs/flow-2-v2-revival-plan.md`](docs/flow-2-v2-revival-plan.md) — how
  the "I won't be home" flow was rebuilt after two failed attempts

Ash framework docs ([ash.labs.vercel.dev](https://ash.labs.vercel.dev/)):

- [Getting started](https://ash.labs.vercel.dev/docs/getting-started)
- [`agent.ts`](https://ash.labs.vercel.dev/docs/agent-ts) · [Tools](https://ash.labs.vercel.dev/docs/tools) · [Skills](https://ash.labs.vercel.dev/docs/skills)
- [Channels](https://ash.labs.vercel.dev/docs/channels) · [Schedules](https://ash.labs.vercel.dev/docs/schedules) · [Subagents](https://ash.labs.vercel.dev/docs/subagents)
- [Runs and streaming](https://ash.labs.vercel.dev/docs/runs-and-streaming) · [Connections](https://ash.labs.vercel.dev/docs/connections) · [Evals](https://ash.labs.vercel.dev/docs/evals)
- [Human in the loop](https://ash.labs.vercel.dev/docs/human-in-the-loop) · [Sandbox](https://ash.labs.vercel.dev/docs/sandbox)
