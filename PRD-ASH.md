# DropMate — PRD v0.3 (Ash)

## Context

Package delivery in Germany relies on a cultural norm: when you're not home, the courier leaves your package with a neighbor. This works because of trust — but the coordination is broken. Neighbors use WhatsApp and Telegram groups to announce received packages, ask who has their delivery, and coordinate pickup times. These messages get buried under event flyers, social chat, and noise. Packages sit for days. Recipients miss notifications. Nobody confirms pickup.

DropMate is a Telegram-based AI agent that lives inside existing neighbor groups and automates the coordination layer — without changing the social dynamics that make the system work. Built on Ash (Vercel's agent framework) with a custom Telegram channel powered by Chat SDK's adapter, the same agent logic can later extend to WhatsApp by adding another channel.

---

## 1. Vision

Every street in Germany has someone home. DropMate makes that network reliable.

A multilingual Telegram bot that turns unstructured neighbor communication into a tracked package coordination system — preserving the trust culture while eliminating the friction.

## 2. Problem Statement

Observed in real WhatsApp groups (Methfesselstraße, Hamburg):

| Pain point | Evidence |
|---|---|
| Messages get buried | Anna-Sophie: "Ich habe eure Nachricht leider erst jetzt gesehen" |
| No structured data | Everyone describes packages differently — some share label photos, some type names |
| Availability is ad-hoc | "bis 15 Uhr hier, dann erst Montag" buried in free text |
| No pickup confirmation | Thread ends without closure — nobody knows if the package was collected |
| Signal-to-noise | Party flyers, event invites, and package messages compete in one channel |
| Language barrier | International residents in German buildings may not follow German-only group messages |

## 3. Target Users

**V1: Any apartment building or street segment in Germany.**

Built as a product from day one — any Hausverwaltung, neighbor group, or WG can adopt it by adding the DropMate bot to their existing Telegram group.

### User Personas

**The Reliable Neighbor (Annemarie)**
- Home often, receives packages for multiple neighbors
- Currently sends label photos + availability in the group
- Wants: less back-and-forth about pickup times, recognition for helping

**The Busy Recipient (Anna-Sophie)**
- Works full-time, misses deliveries and group messages
- Wants: direct notification when her package arrives, clear pickup instructions

**The Proactive Planner (Patricia)**
- Knows she won't be home, wants to pre-arrange reception
- Currently has no way to do this — just hopes someone answers the door

**The International Neighbor**
- Speaks limited German, doesn't fully follow the group chat
- Wants: communication in their language, clear instructions on where to go

## 4. Product Principles

1. **Public credit, private coordination** — The group sees who helped (social reward). Logistics happen in DMs (no noise, no security exposure).
2. **Zero new surfaces** — Telegram only. No app to install beyond what neighbors already use.
3. **Additive, not disruptive** — The bot joins the existing group. Neighbors keep chatting normally. The bot only responds to package-related messages.
4. **Multilingual bridge** — The bot understands any language and responds to each neighbor in their preferred language. A Turkish neighbor and a German neighbor coordinate seamlessly through DropMate.
5. **Learn by observing** — The bot builds its directory from real messages, not just registration forms.
6. **Channel-portable** — Built on Ash so the same agent logic works behind a Telegram channel today and a WhatsApp channel tomorrow without rewriting tools, skills, or instructions.

## 5. Core Flows

### Flow 1: Package Received (reactive)

**Trigger**: A neighbor sends a message in the group saying they received a package for someone else, optionally with a label photo.

```
Annemarie → GROUP: "Pakete für Ritter und Meyer" + label photos

Bot → GROUP:  "2 packages registered at Bremer (Hs.92 / V. Etage)
               - Ritter — Hermes
               - Anna-Sophie Meyer — Amazon
               Available before 14:00 or after 20:00"

Bot → DM Anna-Sophie: "You have a package at Bremer, Hs.92, 5th floor.
                        Pick up before 14:00 or after 20:00."

Bot → DM Ritter: (same, in Ritter's preferred language)

Anna-Sophie → GROUP or DM: "Picked up, thanks!"

Bot → GROUP: "Package for Anna-Sophie Meyer picked up.
              1 remaining at Bremer (Ritter)."
```

**Agent surface used**:
- `tools/classify_message.ts` — fast model decides package-related vs. noise (cheap, via AI Gateway)
- `tools/parse_label.ts` — vision tool reads shipping labels (Gemini Flash → Claude Sonnet fallback)
- `tools/register_package.ts` — writes Package to Redis, returns confirmation
- `tools/notify_recipient.ts` — DMs the owner in their preferred language

### Flow 2: "I Won't Be Home" (proactive)

**Trigger**: A neighbor tells the bot they're expecting a package and won't be available.

```
Patricia → DM bot: "Ich erwarte morgen ein DHL-Paket und bin nicht da"

Bot → DM neighbors with known availability patterns:
    "Patricia (Hs.90) is expecting a DHL package tomorrow.
     Can you receive it if the courier rings?"

Marlene → DM bot: "Ja, ich bin bis 15 Uhr da"

Bot → DM Patricia: "Marlene (Hs.88 / Hartmann) can receive your package tomorrow.
                     She's available until 15:00."

[Package arrives next day]
Marlene → GROUP: "Paket für Patricia angenommen"

Bot → DM Patricia: "Your DHL package is at Marlene / Hartmann (Hs.88).
                     Ring Hartmann."
Bot → GROUP: "Package for Patricia at Hartmann (Hs.88)"
```

**Agent surface used**:
- `skills/expecting_package/` — procedure the model loads when a user says they're expecting a package
- `tools/find_available_neighbors.ts` — queries Redis for residents with matching availability
- `tools/create_reception_request.ts` — pending request state; resolved when a Package arrives matching this recipient

### Flow 3: Package Search (query)

**Trigger**: A neighbor asks where their package is.

```
Patricia → DM bot: "Wo ist mein Paket? Wurde um 16:09 zugestellt"

Bot checks registry → no match

Bot → DM Patricia: "No package registered for you.
                     Should I ask the group?"

Patricia: "Ja"

Bot → GROUP: "Has anyone received a package for Patricia / Höfer (Hs.90)?
              Tracking says delivered at 16:09 today."
```

### Flow 4: Status Dashboard (query)

**Trigger**: Anyone asks the bot for an overview.

```
Neighbor → DM bot: "Status"

Bot → DM: "Open packages on Methfesselstraße:
           - Ritter — at Bremer (Hs.92) since May 5, 12:29
           - Patricia — at Hartmann (Hs.88) since May 5, 14:30
           No pending reception requests."
```

## 6. Onboarding

### Explicit registration
A neighbor sends the bot a DM:
```
"Hallo, ich bin Anna-Sophie Meyer, Methfesselstraße 92, III. Etage"
```
The agent's `tools/register_resident.ts` writes the profile. On Telegram, the bot can DM anyone who has started a conversation with it — no 24-hour window restriction.

### Passive learning
The bot observes group messages and the model decides whether a message contains directory hints:
- "wir (88/Hartmann)" → Marlene = Hartmann family, Hs.88
- "Bremer / Hs.92 / V.Etage" → Annemarie = Bremer, Hs.92, 5th floor
- Repeated pickup patterns → availability heuristics

A scheduled job (`schedules/confirm_learned_data.ts`) periodically asks the resident to confirm:
```
Bot → DM Marlene: "I've learned: Marlene Hartmann, Methfesselstraße 88.
                    Is that correct?"
```

### Language preference
Detected from the first DM the user sends (Ash hook on `lifecycle: turn`). Can be changed anytime:
```
User → DM bot: "/language english"
```

## 7. Technical Architecture

### Stack

| Component | Technology | Role |
|---|---|---|
| Agent framework | Ash (`experimental-ash`) | Agent definition, tools, skills, hooks, schedules, sessions, streaming, deployment |
| Chat transport | `@chat-adapter/telegram` (Chat SDK) | Telegram Bot API integration: webhook + polling, mentions, DMs, groups, label photos, inline keyboards |
| Ash ↔ Chat SDK glue | Custom `lib/telegram-channel/` | Implements Ash's `ChannelAdapter` interface around a `Chat` instance — until `experimental-ash/channels/telegram` ships first-party |
| AI models | Vercel AI Gateway (via AI SDK) | Unified access to vision + text models, cost optimization, fallbacks, observability |
| Persistence | Upstash Redis (EU region) | Resident directory, package registry, language prefs, reception requests, learned-data confirmations |
| Time-based triggers | Ash `defineSchedule` (cron) | 48h reminders, 7d escalation, passive-learning confirmations — polls Redis, no long-sleeping workflows needed |
| Hosting | Vercel | `ash build` compiles via Nitro, deploys as Vercel Functions; webhook endpoint at `/api/telegram` |

### Platform: Telegram first, WhatsApp later

**Why Telegram for V1:**
- No business registration required — any developer can create a bot via @BotFather in seconds
- Full Bot API: groups, DMs, media, inline keyboards, no template approval process
- No AI chatbot policy restrictions (Meta banned open-ended AI bots on WhatsApp in Jan 2026)
- No 24-hour conversation window — bot can DM users anytime after first interaction
- Widely used in urban Germany (Hamburg, Berlin, Munich)

**WhatsApp migration path:**
- Chat SDK's `Chat` class accepts multiple adapters. Once `@chat-adapter/whatsapp` is added, both surfaces run from the same agent definition, tools, and skills.
- Requires: Meta Business Account, business verification (Gewerbeschein or equivalent in DE), message template approvals
- WhatsApp Cloud API free tier: 1,000 service conversations/month

### AI Gateway model routing

Each task routes to the optimal model for cost/quality. Ash's `defineAgent` uses AI SDK model strings — Gateway routing is transparent.

| Task | Model | Cost | Trigger frequency |
|---|---|---|---|
| Message classification | `google/gemini-2.5-flash` (sort: cost) | ~$0.001 | Every group message |
| Label photo parsing (vision) | `google/gemini-2.5-flash` → `anthropic/claude-sonnet-4` (fallback) | ~$0.01 | Only when photos sent |
| Multilingual NLU | `anthropic/claude-sonnet-4` | ~$0.005 | Package-related messages only |
| Response generation + translation | `google/gemini-2.5-flash` (sort: cost) | ~$0.001 | Bot responses |

**Key AI Gateway features used**:
- `sort: 'cost'` — cheapest provider for commodity tasks
- `order` + fallback chains — reliability for vision tasks
- `caching: 'auto'` — cache repeated classification patterns
- Observability dashboard — monitor cost per street/building, track model performance
- BYOK support — building admins can bring their own API keys if they prefer

### Package lifecycle (Redis + Ash schedules)

No long-running workflow primitive needed. State lives in Redis; time-based progression is driven by cron-style schedules that poll and act.

```
register_package (tool)           → Redis: Package{status: "held", receivedAt}
  └── notify_recipient (tool)     → DM owner + (if known) DM courier-volunteer chain

schedules/reminder_48h.ts (cron every 1h)
  └── scan Packages where status="held" AND receivedAt < now - 48h AND !reminded
      → DM holder + recipient, mark reminded

schedules/escalate_7d.ts (cron every 6h)
  └── scan Packages where status="held" AND receivedAt < now - 7d
      → post to group, mark status="expired"

confirm_pickup (tool, triggered by user message or inline-keyboard button)
  └── Redis: Package{status: "picked_up", pickedUpAt}
  └── group announcement
```

This is closer to how package state actually behaves (recipient confirms at any moment) than a sleeping workflow, and it avoids the cold-start durability concerns of long workflow runs.

### Data Model

**Resident** (Redis key `resident:<platformId>`)
```
{
  id: string
  name: string
  street: string
  houseNumber: string
  floor: string (optional)
  buzzerName: string (optional)
  platformId: string (Telegram user ID — portable to WhatsApp ID later)
  platform: "telegram" | "whatsapp"
  language: string (ISO 639-1, detected or set)
  availabilityPatterns: string[] (learned over time)
  registeredAt: timestamp
  source: "explicit" | "learned"
  confirmed: boolean
}
```

**Package** (Redis key `package:<id>`, indexed by `street:<id>:packages`)
```
{
  id: string
  streetId: string
  recipientResidentId: string (nullable — may not be registered yet)
  recipientName: string (from label/message)
  recipientHouseNumber: string
  holderResidentId: string
  carrier: "DHL" | "Hermes" | "DPD" | "GLS" | "UPS" | "Amazon" | "unknown"
  trackingNumber: string (optional, from label OCR)
  status: "held" | "pickup_scheduled" | "picked_up" | "expired"
  receivedAt: timestamp
  pickedUpAt: timestamp (nullable)
  reminded: boolean
  holderAvailability: { from: time, to: time }[] (optional)
}
```

**Street** (Redis key `street:<id>`)
```
{
  id: string
  name: string (e.g. "Methfesselstraße")
  city: string
  groupId: string (Telegram group ID — portable to WhatsApp group ID)
  platform: "telegram" | "whatsapp"
}
```

**Ash session state** (per-conversation, auto-snapshotted by Ash at step boundaries)
```
{
  chatId: number          // Telegram chat id
  isGroup: boolean
  language: string        // detected or user-set
  pendingReceptionRequestId: string | null
}
```

Continuation token format: `tg:<chatId>` — returned by the channel's `getContinuationToken()`.

### Agent project layout

```
DropMate/
├── agent/
│   ├── agent.ts                          # defineAgent — Gemini Flash as primary, AI Gateway routing
│   ├── instructions.md                   # role, tone, multilingual policy, when to use group vs DM
│   ├── instrumentation.ts                # OTel + Braintrust
│   ├── channels/
│   │   ├── telegram.ts                   # one-line export from lib/telegram-channel
│   │   └── ash.ts                        # built-in API channel for curl + automated tests
│   ├── tools/
│   │   ├── classify_message.ts
│   │   ├── parse_label.ts                # vision
│   │   ├── register_resident.ts
│   │   ├── register_package.ts
│   │   ├── lookup_package.ts
│   │   ├── find_available_neighbors.ts
│   │   ├── create_reception_request.ts
│   │   ├── confirm_pickup.ts
│   │   ├── post_to_group.ts              # wraps channel.send with group target
│   │   └── notify_recipient.ts           # wraps channel.send with DM target
│   ├── skills/
│   │   ├── package_received/SKILL.md     # Flow 1 procedure
│   │   ├── expecting_package/SKILL.md    # Flow 2 procedure
│   │   ├── package_search/SKILL.md       # Flow 3 procedure
│   │   └── status_dashboard/SKILL.md     # Flow 4 procedure
│   ├── hooks/
│   │   ├── language_detection.ts         # lifecycle: turn — sets ctx.language from first message
│   │   └── audit_log.ts                  # events: step.completed — anonymized metrics
│   └── schedules/
│       ├── reminder_48h.ts
│       ├── escalate_7d.ts
│       └── confirm_learned_data.ts
├── lib/
│   ├── redis.ts                          # typed Upstash wrappers
│   └── telegram-channel/                 # the custom Ash channel
│       ├── index.ts                      # exports telegramChannel({ token, secret })
│       ├── chat-instance.ts              # builds Chat({ adapters: { telegram } })
│       ├── inbound.ts                    # Chat events → Ash DeliverPayload
│       ├── outbound.ts                   # Ash stream events → thread.post / button cards
│       └── verify.ts                     # Telegram secret-token header check
├── package.json                          # experimental-ash, chat, @chat-adapter/telegram, @upstash/redis, ai, @ai-sdk/google, @ai-sdk/anthropic, zod
└── tsconfig.json                         # "jsxImportSource": "chat" for card components
```

## 8. Telegram Bot Capabilities

| Capability | How DropMate uses it |
|---|---|
| Group messages | Ash channel ingests via Chat SDK `onSubscribedMessage` + `onNewMessage(regex)` — agent classifies, responds to package-related ones only |
| Private DMs | Notifications, registration, status queries, "I won't be home" flow — via `onDirectMessage` |
| Photos + media | Label photos resolved via Ash `fetchFile`, passed to `parse_label` vision tool |
| Inline keyboards | Quick actions via Chat SDK JSX `<Button>` / `<Actions>` cards: "Mark as picked up", "Remind me later", "Yes, I can receive" |
| Bot commands | `/register`, `/status`, `/language`, `/delete`, `/help` — via Chat SDK `onSlashCommand` |
| No rate limits for bots | Send notifications freely, no template approvals needed |
| Webhook mode | `@chat-adapter/telegram` in `mode: "webhook"`; Ash channel exposes the route |

## 9. Privacy & GDPR

- **Data minimization**: Only store name, address, floor, Telegram ID. No tracking of movement or habits.
- **Availability patterns**: Learned patterns (e.g. "usually home mornings") stored as abstract heuristics, not precise schedules. Never shared publicly.
- **"I'm not home" messages**: Never posted to group. Only the volunteer who agrees to help learns the neighbor is away — and only that they expect a package, not where they are.
- **Right to deletion**: Any resident can DM the bot `/delete` to remove all their data. Implemented as a tool that wipes Redis keys by `platformId`.
- **No long-term message storage**: Group messages are processed for classification and discarded. Ash session state is short-lived and bounded; only structured package data is persisted.
- **Consent**: Registering with the bot (sending first DM) constitutes opt-in. Passive learning requires confirmation via `schedules/confirm_learned_data.ts` before data is marked `confirmed: true`.
- **Data location**: All data stored in EU region (Upstash EU, Vercel EU).

## 10. Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Package registration rate | >80% of packages left with neighbors are registered in the bot | Self-reported vs. group messages |
| Pickup confirmation rate | >70% of registered packages get explicit pickup confirmation | Redis state — `picked_up` vs. `expired` |
| Time to pickup | Reduce average from ~2 days to <1 day | `pickedUpAt - receivedAt` distribution |
| Missed notifications | <10% of recipients miss their notification | DM delivery + read receipts (Telegram) |
| Multilingual adoption | >1 non-German-speaking resident active per building | Language stats from Resident records |
| Neighbor satisfaction | NPS >50 among active users | Periodic bot survey via Chat SDK modal |
| Monthly AI cost per street | <5 EUR per active street | AI Gateway observability + Braintrust traces |

## 11. MVP Scope

### V1 — Ship (Telegram)

- [ ] Custom Ash Telegram channel (wraps `@chat-adapter/telegram` via Chat SDK `Chat` class)
- [ ] Bot joins group + handles DMs (`onNewMention`, `onDirectMessage`, `onSubscribedMessage`)
- [ ] Flow 1: Package received (text + label photo parsing via AI Gateway vision)
- [ ] Flow 2: "I won't be home" with volunteer matching
- [ ] Flow 3: Package search
- [ ] Explicit registration onboarding via `/register` slash command
- [ ] Multilingual support (auto-detect from first DM, respond in user's preferred language)
- [ ] Pickup confirmation + group announcement (Chat SDK JSX `<Button>` inline keyboard)
- [ ] 48h reminder via `defineSchedule` cron
- [ ] AI Gateway integration with cost-optimized model routing + fallback chains
- [ ] Upstash Redis directory + package registry (EU region)

### V2 — Learn

- [ ] Passive directory learning from group messages
- [ ] Availability pattern detection
- [ ] Carrier tracking integration (DHL/Hermes APIs) for proactive "your package is out for delivery" alerts
- [ ] Flow 4: Status dashboard
- [ ] Weekly digest schedule: "This week on Methfesselstraße: 12 packages coordinated, 0 lost"
- [ ] Reputation/karma: "Annemarie received 47 packages this year"
- [ ] WhatsApp channel via `@chat-adapter/whatsapp` registered alongside Telegram on the same `Chat` instance (requires business entity registration)

### V3 — Scale

- [ ] Self-service onboarding: any group admin adds the bot + runs `/setup`
- [ ] Hausverwaltung dashboard (web UI, separate Next.js app reading the same Redis)
- [ ] Multi-street support per bot instance (`Street` keyed by `groupId`)
- [ ] Packstation fallback suggestions when no neighbor is available
- [ ] Both Telegram + WhatsApp channels running simultaneously
- [ ] Integration with building intercom systems
- [ ] First-party `experimental-ash/channels/telegram` — delete `lib/telegram-channel/`, import upstream

## 12. Build Methodology (Option A — De-risked)

The implementing agent should follow three phases. Each phase is independently shippable and validates the prior assumption before paying the cost of the next.

### Skills to consult

Skills live **in the repo** at `.claude/skills/<name>/SKILL.md` (symlinks to `.agents/skills/<name>/` which is the canonical source). Claude Code auto-discovers them from the working directory, so the bind-mounted sandbox sees the same skills as the host with no extra setup. The agent should read both before writing code:

- **`use-ash`** (`.claude/skills/use-ash/SKILL.md`) — Ash project layout, `defineAgent` / `defineTool` / `defineSchedule` / `defineHook`, channel adapter interface, CLI, sessions, streaming. Authoritative docs: <https://ash.labs.vercel.dev/docs/getting-started>.
- **`chat-sdk`** (`.claude/skills/chat-sdk/SKILL.md`) — Chat SDK `Chat` class, adapters, event handlers (`onNewMention`, `onDirectMessage`, `onSubscribedMessage`, `onSlashCommand`, `onAction`), JSX cards, modals, streaming, file handling. Sourced from `vercel/chat`'s `skills/chat/SKILL.md` (tracked in `skills-lock.json`) — includes pointers to `node_modules/chat/docs/*.mdx` for every API surface.

For the custom channel specifically, read in order:
1. `node_modules/experimental-ash/dist/src/channel/adapter.d.ts` — the `ChannelAdapter` interface DropMate's channel must implement.
2. `node_modules/experimental-ash/dist/src/public/channels/twilio/*` — closest existing reference (third-party messaging API, webhook-driven, signature verify, minimal interactions).
3. `node_modules/chat/docs/getting-started.mdx`, `usage.mdx`, `handling-events.mdx`, `posting-messages.mdx`, `cards.mdx`, `direct-messages.mdx`, `files.mdx`.
4. `node_modules/@chat-adapter/telegram/dist/index.d.ts` — exact factory signature and config options.

### Phase 0 — Prerequisites (before any code)

**Goal**: Provision every external resource the spike depends on, so Phase 1 is purely local code.

| Prereq | Used for | How to get it |
|---|---|---|
| Telegram bot token | `@chat-adapter/telegram` auth | Talk to `@BotFather` on Telegram → `/newbot` → copy token to `TELEGRAM_BOT_TOKEN` |
| Telegram webhook secret | Validate inbound webhooks (`X-Telegram-Bot-Api-Secret-Token`) | Generate a random 32-byte string → `TELEGRAM_WEBHOOK_SECRET_TOKEN` |
| Upstash Redis (EU region) | Resident directory, package registry, session ↔ chatId map | Upstash console → create database in EU → copy `KV_REST_API_URL` + `KV_REST_API_TOKEN` |
| Vercel project | Deploy target for `ash build`, env-var sync, and AI Gateway auth | `vercel link` in repo root → choose/create project → `vercel env pull .env.local` (pulls `VERCEL_OIDC_TOKEN` + any Marketplace-provisioned vars like `KV_REST_API_*`) |
| AI Gateway auth | LLM calls via AI SDK | **Default for V1**: the `VERCEL_OIDC_TOKEN` from `vercel env pull` is auto-detected by `@ai-sdk/gateway` — no extra step. **Alternative**: if running outside Vercel infrastructure or you want a long-lived token (OIDC expires ~12h), create an API key via Vercel dashboard → AI tab → Create Gateway → set `AI_GATEWAY_API_KEY` in `.env.local`. AI SDK prefers `AI_GATEWAY_API_KEY` when present, falls back to OIDC otherwise. |
| Node `24.x` + `pnpm` | Ash runtime requirement | `nvm install 24 && corepack enable` |

**Where the scaffold lands**: directly inside this repo (`/Users/diegodemiguel/Development/Work/DropMate/`). The repo currently contains `PRD-ASH.md`, `docs/archive/PRD-v0.2.md`, and `.claude/`. The `pnpm create experimental-ash-agent` wizard generates files at the current working directory and won't touch the existing markdown or `.claude/` skills.

**Exit criteria**: `.env.local` populated with `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, Upstash KV vars, and `VERCEL_OIDC_TOKEN` (or an explicit `AI_GATEWAY_API_KEY` if you opted for the long-lived alternative). `pnpm` + `node 24` available. Vercel project linked.

### Phase 1 — Spike (1 day): Ash without a channel

**Goal**: Prove the agent loop works end-to-end before paying for the channel adapter.

- `pnpm create experimental-ash-agent` **run from this repo's root**, scaffolding the Ash app *into* `DropMate/` itself (not a subdirectory). Pick Gemini Flash as the model. The wizard creates `agent/agent.ts`, `agent/instructions.md`, `package.json`, `tsconfig.json`, and `.gitignore`; `PRD.md`, `PRD-ASH.md`, and `.claude/` survive untouched.
- Add `@upstash/redis`, `chat`, `@chat-adapter/telegram` to the freshly scaffolded `package.json`.
- Rewrite `agent/instructions.md` with the multilingual role + tone.
- Implement 3 tools: `register_resident`, `register_package`, `confirm_pickup` (Redis-backed).
- Add the built-in `agent/channels/ash.ts` so the session API is available.
- Stand up a **separate thin webhook** at `/api/telegram` (a small Vercel function in `apps/telegram-webhook/` or inline in the same Ash app under `lib/`). This webhook receives Telegram updates via `@chat-adapter/telegram` and calls `POST http://localhost:3000/ash/v1/session` with the message text, then posts the streamed reply back via the adapter.
- Manually map `chatId` → Ash `sessionId` in Redis so follow-up messages reach the same session.
- Test: registered residents, registered packages, pickup confirmation — all via real Telegram messages, end-to-end.

**Exit criteria**: A Telegram message produces a model-generated reply that reflects Redis state. If this works, Ash is the right framework for DropMate. If it doesn't, fall back to the v0.2 plan (Next.js + Chat SDK direct).

### Phase 2 — Promote to a proper Ash channel (2–3 days)

**Goal**: Replace the external webhook with a first-class Ash channel so schedules, hooks, and continuation tokens work natively.

- Build `lib/telegram-channel/`:
  - `chat-instance.ts` — creates a singleton `new Chat({ adapters: { telegram: createTelegramAdapter() }, state: createRedisState() })` using Chat SDK.
  - `inbound.ts` — registers `bot.onDirectMessage`, `bot.onNewMention`, `bot.onSubscribedMessage`, `bot.onSlashCommand`, `bot.onAction`; each handler builds an Ash `DeliverPayload` and resolves the channel's `deliver` hook.
  - `outbound.ts` — implements Ash event handlers (`message.completed`, `actions.requested`) by calling `thread.post()`, `thread.post(<Card>...)`, or `thread.post(streamingAsyncIterable)`.
  - `verify.ts` — checks `X-Telegram-Bot-Api-Secret-Token` against `process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN`.
  - `index.ts` — exports `telegramChannel({ token, webhookSecret })` returning an Ash `ChannelAdapter<TelegramState>` with `kind: "telegram"`, `state: { chatId, isGroup, language, pendingReceptionRequestId }`, `getContinuationToken: () => "tg:" + state.chatId`.
- `agent/channels/telegram.ts` — one-line export of `telegramChannel({ ... })`, identical shape to `agents/help-ash/agent/channels/twilio.ts` in the internal-agents reference repo.
- Implement remaining tools and the four skills.
- Wire `schedules/reminder_48h.ts` with `receive(telegramChannel, { chatId: ... })` so reminders post via the same channel.
- Delete the Phase 1 external webhook.

**Exit criteria**: All four flows work end-to-end through the native channel. Schedules can post into specific chats. Continuation tokens survive across cold starts.

### Phase 3 — Open-source the channel (post-V1)

**Goal**: Stop maintaining the channel as bespoke DropMate code.

- Extract `lib/telegram-channel/` into a standalone package (`@dropmate/ash-channel-telegram` or similar).
- Submit upstream to Ash as a candidate for `experimental-ash/channels/telegram`.
- When upstream lands, replace the import in `agent/channels/telegram.ts` and delete the package.

## 13. Open Questions

1. **Business model**: Free for residents? Freemium per building? Hausverwaltung pays? Carrier-subsidized?
2. **Carrier API access**: DHL, Hermes, DPD offer tracking APIs — can we integrate to auto-detect deliveries before the neighbor even messages?
3. **Abuse handling**: What if someone claims they picked up a package but didn't? Trust-based with community moderation?
4. **Telegram adoption**: Will the Methfesselstraße neighbors switch to Telegram, or do they need to be on both? Some buildings already use Telegram in Germany.
5. **Legal entity for WhatsApp**: When ready for V2 WhatsApp support, who registers the Gewerbe? DropMate as a product company, or each Hausverwaltung?
6. **Schedule cadence trade-off**: 1h cron for `reminder_48h` minimizes latency but inflates Redis scans. Switch to a sorted-set of `(receivedAt + 48h, packageId)` indexed by due time to keep the scan O(due-items) instead of O(all-held)?
