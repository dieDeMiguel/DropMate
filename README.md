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

## Running locally

Prerequisites: Node 24, pnpm, a Telegram bot token, an Upstash Redis (EU),
and a Vercel project linked for AI Gateway auth.

```bash
pnpm install
vercel link
vercel env pull .env.local
# .env.local must contain:
#   TELEGRAM_BOT_TOKEN
#   TELEGRAM_WEBHOOK_SECRET_TOKEN
#   KV_REST_API_URL · KV_REST_API_TOKEN
#   VERCEL_OIDC_TOKEN   (auto-detected by @ai-sdk/gateway)

pnpm dev          # ash dev — local Ash server + channel
pnpm test         # vitest run
pnpm typecheck    # tsgo
pnpm build        # ash build
```

The Telegram webhook is at `/api/telegram`. Point `@BotFather`'s webhook
URL at your deployment (or an ngrok tunnel during dev) with the
`X-Telegram-Bot-Api-Secret-Token` set to `TELEGRAM_WEBHOOK_SECRET_TOKEN`.

> ⚠️ `setWebhook` must include `allowed_updates: ["message", "callback_query",
> "edited_message"]`. Without `callback_query`, every inline-button tap is
> silently dropped.

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
