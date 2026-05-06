# DropMate — PRD v0.2

## Context

Package delivery in Germany relies on a cultural norm: when you're not home, the courier leaves your package with a neighbor. This works because of trust — but the coordination is broken. Neighbors use WhatsApp and Telegram groups to announce received packages, ask who has their delivery, and coordinate pickup times. These messages get buried under event flyers, social chat, and noise. Packages sit for days. Recipients miss notifications. Nobody confirms pickup.

DropMate is a Telegram-based AI agent that lives inside existing neighbor groups and automates the coordination layer — without changing the social dynamics that make the system work. Built on Chat SDK's adapter abstraction, the same bot logic can later extend to WhatsApp when a business entity is established.

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
6. **Adapter-portable** — Built on Chat SDK so the same logic works on WhatsApp, Telegram, or any future adapter without rewriting.

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

**AI tasks involved**:
- Classify message as package-related (cheap, fast model via AI Gateway)
- Parse label photos via vision model (medium cost, AI Gateway fallback chain)
- Extract structured data from free text in any language (NLU model)
- Generate response in recipient's preferred language

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

**AI tasks involved**:
- Understand intent: "expecting package + not home" (NLU)
- Match to available neighbors (database lookup, light AI)
- Track fulfillment when package arrives (workflow state)
- Cross-reference with actual delivery (label matching)

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
Bot confirms and stores the profile. On Telegram, the bot can DM anyone who has started a conversation with it — no 24-hour window restriction.

### Passive learning
The bot observes group messages and builds the directory over time:
- "wir (88/Hartmann)" → Marlene = Hartmann family, Hs.88
- "Bremer / Hs.92 / V.Etage" → Annemarie = Bremer, Hs.92, 5th floor
- Repeated pickup patterns → availability heuristics

The bot periodically asks to confirm learned data:
```
Bot → DM Marlene: "I've learned: Marlene Hartmann, Methfesselstraße 88.
                    Is that correct?"
```

### Language preference
Detected from the first DM the user sends. Can be changed anytime:
```
User → DM bot: "/language english"
```

## 7. Technical Architecture

### Stack

| Component | Technology | Role |
|---|---|---|
| Bot framework | Chat SDK (`@chat-adapter/telegram`) | Telegram Bot API integration, message routing, group + DM handling |
| AI models | Vercel AI Gateway | Unified access to vision + text models, cost optimization, fallbacks, observability |
| Durable state | Vercel Workflows (`'use workflow'`) | Package lifecycle tracking, sleep/resume for multi-day flows, reminder scheduling |
| Persistence | Redis (Upstash) | Resident directory, thread subscriptions, package registry |
| Hosting | Vercel | Serverless deployment, webhook endpoints |

### Platform: Telegram first, WhatsApp later

**Why Telegram for V1:**
- No business registration required — any developer can create a bot via @BotFather in seconds
- Full Bot API: groups, DMs, media, inline keyboards, no template approval process
- No AI chatbot policy restrictions (Meta banned open-ended AI bots on WhatsApp in Jan 2026)
- No 24-hour conversation window — bot can DM users anytime after first interaction
- Widely used in urban Germany (Hamburg, Berlin, Munich)

**WhatsApp migration path:**
- Chat SDK's adapter abstraction means identical bot logic — swap `@chat-adapter/telegram` for `@chat-adapter/whatsapp`
- Requires: Meta Business Account, business verification (Gewerbeschein or equivalent in DE), message template approvals
- WhatsApp Cloud API free tier: 1,000 service conversations/month
- Can run both adapters simultaneously — same bot, two surfaces

### AI Gateway model routing

Each task routes to the optimal model for cost/quality:

| Task | Model | Cost | Trigger frequency |
|---|---|---|---|
| Message classification | `google/gemini-2.5-flash` (sort: cost) | ~$0.001 | Every group message |
| Label photo parsing (vision) | `google/gemini-2.5-flash` or `anthropic/claude-sonnet-4` (fallback chain) | ~$0.01 | Only when photos sent |
| Multilingual NLU | `anthropic/claude-sonnet-4` | ~$0.005 | Package-related messages only |
| Response generation + translation | `google/gemini-2.5-flash` (sort: cost) | ~$0.001 | Bot responses |

**Key AI Gateway features used**:
- `sort: 'cost'` — cheapest provider for commodity tasks
- `order` + fallback chains — reliability for vision tasks
- `caching: 'auto'` — cache repeated classification patterns
- Observability dashboard — monitor cost per street/building, track model performance
- BYOK support — building admins can bring their own API keys if they prefer

### Workflow lifecycle (per package)

```
registerPackage()        → 'use workflow'
  |
  |-- extractData()      → 'use step' (parse label / message)
  |-- notifyRecipient()  → 'use step' (DM the owner)
  |-- waitForPickup()    → hook (durable — can wait days)
  |     |
  |     |-- [picked up]  → confirmPickup() → 'use step' → workflow completes
  |     |
  |     +-- [48h passed] → sendReminder() → 'use step' → re-enter wait
  |
  +-- [7 days]           → escalate() → 'use step' (message group, close)
```

### Data Model

**Resident**
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

**Package**
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
  holderAvailability: { from: time, to: time }[] (optional)
  workflowId: string
}
```

**Street**
```
{
  id: string
  name: string (e.g. "Methfesselstraße")
  city: string
  groupId: string (Telegram group ID — portable)
  platform: "telegram" | "whatsapp"
  residents: Resident[]
  activePackages: Package[]
}
```

## 8. Telegram Bot Capabilities

| Capability | How DropMate uses it |
|---|---|
| Group messages | Bot reads all messages, classifies, responds to package-related ones |
| Private DMs | Notifications, registration, status queries, "I won't be home" flow |
| Photos + media | Receive shipping label photos, send confirmation images |
| Inline keyboards | Quick-action buttons: "Mark as picked up", "Remind me later", "Yes, I can receive" |
| Bot commands | `/register`, `/status`, `/language`, `/delete`, `/help` |
| No rate limits for bots | Send notifications freely, no template approvals needed |
| Webhook mode | Serverless-compatible — Vercel functions handle Telegram webhooks |

## 9. Privacy & GDPR

- **Data minimization**: Only store name, address, floor, Telegram ID. No tracking of movement or habits.
- **Availability patterns**: Learned patterns (e.g. "usually home mornings") stored as abstract heuristics, not precise schedules. Never shared publicly.
- **"I'm not home" messages**: Never posted to group. Only the volunteer who agrees to help learns the neighbor is away — and only that they expect a package, not where they are.
- **Right to deletion**: Any resident can DM the bot `/delete` to remove all their data.
- **No long-term message storage**: Group messages are processed for classification and discarded. Only structured package data is persisted.
- **Consent**: Registering with the bot (sending first DM) constitutes opt-in. Passive learning requires confirmation before data is stored.
- **Data location**: All data stored in EU region (Upstash EU, Vercel EU).

## 10. Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Package registration rate | >80% of packages left with neighbors are registered in the bot | Self-reported vs. group messages |
| Pickup confirmation rate | >70% of registered packages get explicit pickup confirmation | Workflow completion rate |
| Time to pickup | Reduce average from ~2 days to <1 day | Workflow duration |
| Missed notifications | <10% of recipients miss their notification | DM delivery + read receipts |
| Multilingual adoption | >1 non-German-speaking resident active per building | Language stats |
| Neighbor satisfaction | NPS >50 among active users | Periodic bot survey |
| Monthly AI cost per street | <5 EUR per active street | AI Gateway observability |

## 11. MVP Scope

### V1 — Ship (Telegram)

- [ ] Telegram Bot API integration via Chat SDK (`@chat-adapter/telegram`)
- [ ] Bot joins group + handles DMs (hybrid model)
- [ ] Flow 1: Package received (text + label photo parsing via AI Gateway vision)
- [ ] Flow 2: "I won't be home" with volunteer matching
- [ ] Flow 3: Package search
- [ ] Explicit registration onboarding via `/register`
- [ ] Multilingual support (auto-detect language, respond in user's preferred language)
- [ ] Pickup confirmation + group announcement
- [ ] 48h reminder via Vercel Workflow sleep
- [ ] AI Gateway integration with cost-optimized model routing + fallback chains
- [ ] Inline keyboard buttons for quick actions (pickup confirm, availability response)

### V2 — Learn

- [ ] Passive directory learning from group messages
- [ ] Availability pattern detection
- [ ] Carrier tracking integration (DHL/Hermes APIs) for proactive "your package is out for delivery" alerts
- [ ] Flow 4: Status dashboard
- [ ] Weekly digest: "This week on Methfesselstraße: 12 packages coordinated, 0 lost"
- [ ] Reputation/karma: "Annemarie received 47 packages this year"
- [ ] WhatsApp adapter (requires business entity registration)

### V3 — Scale

- [ ] Self-service onboarding: any group admin adds the bot + runs `/setup`
- [ ] Hausverwaltung dashboard (web UI) for property managers
- [ ] Multi-street support per bot instance
- [ ] Packstation fallback suggestions when no neighbor is available
- [ ] Both Telegram + WhatsApp running simultaneously via Chat SDK
- [ ] Integration with building intercom systems

## 12. Open Questions

1. **Business model**: Free for residents? Freemium per building? Hausverwaltung pays? Carrier-subsidized?
2. **Carrier API access**: DHL, Hermes, DPD offer tracking APIs — can we integrate to auto-detect deliveries before the neighbor even messages?
3. **Abuse handling**: What if someone claims they picked up a package but didn't? Trust-based with community moderation?
4. **Telegram adoption**: Will the Methfesselstraße neighbors switch to Telegram, or do they need to be on both? Some buildings already use Telegram in Germany.
5. **Legal entity for WhatsApp**: When ready for V2 WhatsApp support, who registers the Gewerbe? DropMate as a product company, or each Hausverwaltung?
