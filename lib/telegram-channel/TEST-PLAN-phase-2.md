# Phase 2 Telegram channel — live verification plan (#19, slice 4/4)

The factory + spike rewrite (slices 1–3) ship the structural change.
Behaviour parity is verified by `process-update.test.ts` (228 lines)
+ `factory.test.ts` + `outbound.test.ts` against mocked deps. This
document covers what unit tests cannot: a real Telegram bot, real
Upstash Redis, real Vercel runtime, real Phase 1 user flows.

Execute every section in order. Do **not** merge to `main` until all
boxes are ticked.

---

## 1. Prerequisites

- [ ] **Vercel preview deploy** of `feature/telegram-channel-factory` is
      live and you can reach it (note the URL — referred to below as
      `${PREVIEW_URL}`).
- [ ] **Test Telegram bot** exists (a *different* one from your
      production bot if applicable) and you have its API token.
- [ ] **Upstash Redis** instance is provisioned for the preview env.
      The same instance can be reused across runs — each test starts
      by clearing any leftover keys for the test chat (see §6).
- [ ] **Env vars** on the Vercel preview deployment:
  - `TELEGRAM_BOT_TOKEN` — test bot's API token
  - `TELEGRAM_WEBHOOK_SECRET_TOKEN` — any opaque string ≥ 32 chars
        (generate fresh: `openssl rand -hex 32`)
  - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
  - Any model/API keys the Ash agent needs (carry over from production)
- [ ] **Register the webhook** with Telegram (one-time per deploy):
  ```bash
  curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{
      \"url\": \"${PREVIEW_URL}/api/telegram\",
      \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET_TOKEN}\",
      \"allowed_updates\": [\"message\"]
    }"
  ```
  Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`.
- [ ] **Confirm the webhook is registered correctly:**
  ```bash
  curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
  ```
  Expected: `url` matches `${PREVIEW_URL}/api/telegram`,
  `has_custom_certificate: false`, `pending_update_count: 0`.

---

## 2. Flow 1 — register resident

The first message any new Telegram user sends should land them as a
registered resident in Redis.

- [ ] Open the test bot in Telegram on your phone (use a Telegram
      account *not* already registered in the preview's Redis — see §6
      for cleanup if you need to start fresh).
- [ ] Send: `Hallo, ich wohne in Hauptstraße 12`
      (or any plain-text "I live at <address>" message — the agent's
      language hook should accept English, German, Spanish, etc.).
- [ ] **Expect a reply** within ~5 seconds that:
  - Confirms registration
  - Echoes back the street + house number
  - Is in the same language as the message
- [ ] **Verify Redis state:**
  ```bash
  # Replace 123456789 with your Telegram user id (visible in the
  # Vercel function logs for this request, search for "fromUserId").
  redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" \
    GET "resident:123456789"
  ```
  Expected: a JSON blob containing `street`, `houseNumber`,
  `languageCode`, and a created timestamp.
- [ ] **Verify the continuation token:**
  ```bash
  redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" \
    GET "session:tg:<your-chat-id>"
  ```
  Expected: a session id (UUID-shaped) — this is what proves the
  factory's `getContinuationToken: () => 'tg:<chatId>'` semantics
  survived the rewrite.

## 3. Flow 2 — package received

A different resident reporting they're holding a package for someone.

- [ ] Use a *second* Telegram account (or temporarily change your
      registered address to differ from the test recipient).
- [ ] Send: `Ich habe ein Paket für Anna Schmidt aus Hauptstraße 12
      bekommen`.
- [ ] **Expect a reply** confirming the holder + recipient + address,
      and asking when the recipient is welcome to pick it up (or
      similar — exact wording is agent-driven, not deterministic).
- [ ] **Verify the package was written:**
  ```bash
  # Find your most recent package
  redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" \
    KEYS "package:*" | tail -5
  redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" \
    GET "package:<id-from-above>"
  ```
  Expected: JSON with `status: "held"`, the holder's user id, the
  recipient's name + address, and a created timestamp.
- [ ] **Verify the street index was updated:**
  ```bash
  redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" \
    SMEMBERS "street:hauptstrasse-12:packages"
  ```
  Expected: the package id from above is in the set.

## 4. Flow 3 — pickup confirmation

The recipient picks up the package.

- [ ] Switch back to your original (registered) Telegram account.
- [ ] Send: `Ich habe das Paket abgeholt` (or `I picked up the package`).
- [ ] **Expect a reply** acknowledging the pickup.
- [ ] **Verify the package was flipped:**
  ```bash
  redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" \
    GET "package:<id-from-flow-2>"
  ```
  Expected: `status: "picked_up"`, plus a `pickedUpAt` timestamp.

## 5. Cold-start continuation tokens

The single load-bearing claim of this rewrite that unit tests can't
prove: when a Vercel function instance cold-starts mid-conversation,
the next message resumes the same session (via the `tg:<chatId>`
continuation token), not a new one.

- [ ] In the Vercel dashboard for the preview, **stop / kill the
      current function instance** (Settings → Functions → kill any
      live instances), or simply wait 10+ minutes for it to idle out.
      Confirm idle: a subsequent request shows a cold-start signal
      in the Vercel function logs (long duration, "Cold boot" tag).
- [ ] Send another message to the bot: `Wo ist mein Paket?` (a question
      that would not make sense if the agent forgot context).
- [ ] **Expect a reply** that demonstrates the agent remembers you
      (e.g. addresses you by name, or references the recently
      picked-up package).
- [ ] **Verify the session id did not change** by comparing:
  ```bash
  redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" \
    GET "session:tg:<your-chat-id>"
  ```
  Expected: same UUID as in §2. If a new UUID, the continuation
  token resolution is broken — file a regression against the
  factory's `processInboundTelegramUpdate` deps wiring.

## 6. Cleanup between runs

If you want to start fresh (e.g. to re-verify §2 with the same
Telegram account):

```bash
# Delete the resident record
redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" DEL "resident:<your-user-id>"

# Delete the session
redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" DEL "session:tg:<your-chat-id>"

# Delete any packages + street index entries you created
redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" KEYS "package:*"   # find ids
redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" DEL "package:<id>" ...
redis-cli --tls -u "${UPSTASH_REDIS_REST_URL}" DEL "street:hauptstrasse-12:packages"
```

## 7. Sign-off

- [ ] All three Phase 1 flows pass (§2, §3, §4).
- [ ] Cold-start continuation token preserved (§5).
- [ ] No 4xx / 5xx in the Vercel function logs except the deliberate
      401 from sending a request with a wrong secret (sanity check
      that verify is still enforced — run once with
      `curl -X POST ${PREVIEW_URL}/api/telegram -H "X-Telegram-Bot-Api-Secret-Token: wrong" -d '{}'`
      and confirm a 401 in the logs).
- [ ] **Then** merge the PR.

## What this plan does NOT cover

These belong to follow-up issues, not to #19:

- **Inline keyboard buttons** for quick replies — #24.
- **Photo / label vision** parsing — #20.
- **Group chat reception requests** — #22 / #23.
- **Multi-bot deployment** — the factory supports it (see slice 2's
  multi-bot test), but a second `telegramChannel({ ... })` mount
  is its own opening, not a regression test for this PR.
- **Chat SDK integration** — `chat-instance.ts` is committed but not
  yet wired into the factory. The deeper integration (Chat SDK as
  inbound middleware for dedup + locking) lands in a future Phase 2.5
  iteration; the live verification here only proves the Ash-only
  factory variant.
