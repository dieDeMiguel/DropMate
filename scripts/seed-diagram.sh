#!/usr/bin/env bash
#
# Seed the booth-demo live diagram from a local `pnpm dev` server.
#
# Walks a canonical trace sequence through every box (CHANNEL →
# REGISTRATION → CLASSIFIER → VISION → FLOW 2 LIB → AGENT → TELEGRAM)
# with a 600ms gap between events so the cables animate.
#
# Pre-req: `pnpm dev` running on http://127.0.0.1:3000/ — the diagram
# page open at the root URL, the SSE stream connected (status: "live").
#
# Usage:
#   ./scripts/seed-diagram.sh                        # seed once
#   EMIT_URL=http://127.0.0.1:3001 ./scripts/seed-diagram.sh
#   ./scripts/seed-diagram.sh --loop 5               # seed 5 times, pause between
#
# See #104 / docs/booth-demo.md for the rationale + the production guard.

set -euo pipefail

EMIT_URL="${EMIT_URL:-http://127.0.0.1:3000/api/trace/dev/emit}"
HOP_DELAY="${HOP_DELAY:-0.6}"
TRACE_DELAY="${TRACE_DELAY:-3.0}"
LOOPS=1

if [[ "${1:-}" == "--loop" ]]; then
  LOOPS="${2:-5}"
fi

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

  # --fail so a 404 from a prod-mode server stops the loop loudly
  # instead of silently posting nothing.
  curl --fail --silent --show-error \
    -X POST "${EMIT_URL}" \
    -H "content-type: application/json" \
    -d "${payload}" \
    > /dev/null

  sleep "${HOP_DELAY}"
}

seed_one_trace() {
  local kind="$1"
  local trace_id
  # 8-char trace id (matches what process-update.ts generates).
  trace_id=$(printf '%08x' $((RANDOM * RANDOM)))

  echo "seeding trace=${trace_id} kind=${kind}"

  # Pipeline: inbound lands → channel verifies → branches deterministically
  # → drains DM. Ends with channel.end so the diagram's post-trace hold
  # animation can run.
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
