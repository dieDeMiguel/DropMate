#!/usr/bin/env bash
#
# Seed the booth-demo live diagram from a local `pnpm dev` server OR
# from production (with a valid demo token).
#
# Walks a canonical trace sequence covering every actor box on the
# Vercel-primitives diagram (per v2.1 #124 / #125):
#
#   TELEGRAM      (origin ignite, no explicit event)
#   ASH CHANNEL   (channel.start)
#   ASH TOOLS     (registration / flow1 / flow2 / pickup)
#   VERCEL AI GATEWAY · gemini-2.5-flash    (classifier, vision)
#   VERCEL AI GATEWAY · claude-opus-4.7     (agent)
#   ASH AGENT     (agent.start)
#   ASH SCHEDULES (schedule.fire — #125 lights this box in prod demos)
#   UPSTASH REDIS (redis.read / redis.write — forward-looking slot)
#   TELEGRAM      (dm.start — return cable)
#
# 600ms gap between events so the cables animate.
#
# Local dev:
#   pnpm dev                          # in one terminal
#   pnpm seed-diagram                 # in another — lights every box once
#   pnpm seed-diagram --loop 5        # rotate text/photo/callback accents
#
# Production demo (Slice 2 of #123, ticket #125):
#   Set DEMO_TRACE_TOKEN in Vercel project env to a random secret. To
#   drive the prod diagram from a laptop during a booth pitch:
#
#     DEMO_TRACE_TOKEN=… \
#     EMIT_URL=https://drop-mate-delta.vercel.app/api/trace/dev/emit \
#     pnpm seed-diagram
#
#   Or pass the token explicitly:
#
#     EMIT_URL=https://drop-mate-delta.vercel.app/api/trace/dev/emit \
#     pnpm seed-diagram --token my-secret-token
#
# Production guard: without a matching token, the endpoint returns 404
# (byte-identical to a missing-route 404 — no "unauthorized" leak).
# See lib/telegram-channel/trace-dev-routes.ts for the gate logic.
#
# See #104 / #125 / docs/booth-demo.md for the full rationale.

set -euo pipefail

EMIT_URL="${EMIT_URL:-http://127.0.0.1:3000/api/trace/dev/emit}"
HOP_DELAY="${HOP_DELAY:-0.6}"
TRACE_DELAY="${TRACE_DELAY:-3.0}"
LOOPS=1
TOKEN="${DEMO_TRACE_TOKEN:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --loop)
      LOOPS="${2:-5}"
      shift 2
      ;;
    --token)
      TOKEN="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

emit() {
  local stage="$1"
  local phase="$2"
  local kind="${3:-text}"
  local trace_id="$4"

  local payload
  payload=$(cat <<JSON
{"stage":"${stage}","phase":"${phase}","traceId":"${trace_id}","kind":"${kind}"}
JSON
)

  # Build curl args. The X-Demo-Token header is only attached when a
  # token is present; localhost dev accepts the call without it.
  local -a curl_args=(
    --fail --silent --show-error
    -X POST "${EMIT_URL}"
    -H "content-type: application/json"
  )
  if [[ -n "${TOKEN}" ]]; then
    curl_args+=(-H "X-Demo-Token: ${TOKEN}")
  fi
  curl_args+=(-d "${payload}")

  # --fail so a 404 from a prod-mode server (missing/wrong token)
  # stops the loop loudly instead of silently posting nothing.
  curl "${curl_args[@]}" > /dev/null

  sleep "${HOP_DELAY}"
}

seed_one_trace() {
  local kind="$1"
  local trace_id
  # 8-char trace id (matches what process-update.ts generates).
  trace_id=$(printf '%08x' $((RANDOM * RANDOM)))

  echo "seeding trace=${trace_id} kind=${kind}"

  # Pipeline: inbound lands → channel verifies → branches deterministically
  # → drains DM. The schedule + redis stages are added (#125) so every
  # actor box on the v2.1 #124 layout lights up over one canonical run.
  emit channel      start          "${kind}" "${trace_id}"
  emit registration start          "${kind}" "${trace_id}"
  emit registration end            "${kind}" "${trace_id}"
  emit classifier   start          "${kind}" "${trace_id}"
  emit classifier   end            "${kind}" "${trace_id}"
  emit vision       start          "${kind}" "${trace_id}"
  emit vision       end            "${kind}" "${trace_id}"
  emit flow2        create.start   "${kind}" "${trace_id}"
  emit flow2        create.end     "${kind}" "${trace_id}"
  emit flow2        accept.start   "${kind}" "${trace_id}"
  emit flow2        accept.end     "${kind}" "${trace_id}"
  emit agent        start          "${kind}" "${trace_id}"
  emit redis        write          "${kind}" "${trace_id}"
  emit schedule     fire           "${kind}" "${trace_id}"
  emit dm           start          "${kind}" "${trace_id}"
  emit dm           end            "${kind}" "${trace_id}"
}

# Rotate kinds so the diagram cycles through cyan/amber/magenta accents
# across loops — same surface a booth visitor sees from real traffic.
KINDS=(text photo callback)

for ((i = 0; i < LOOPS; i++)); do
  seed_one_trace "${KINDS[$((i % 3))]}"
  if (( i + 1 < LOOPS )); then
    sleep "${TRACE_DELAY}"
  fi
done

echo "done."
