#!/usr/bin/env bash
#
# Run Claude Code inside a Docker Desktop Sandbox using the Vercel AI Gateway.
#
# Docker Sandbox's `run` subcommand can't pass env vars, so this wrapper:
#   1. Ensures a sandbox exists for $PWD (creates it if missing).
#   2. Bypasses Claude Code's onboarding screen on first launch.
#   3. Uses `docker sandbox exec -e …` to inject the auth token, gateway URL,
#      and model — keeping the token out of any persisted sandbox state.
#
# The token is fetched from the macOS Keychain at runtime, matching the host
# setup in claude-config.md.
#
# Usage:
#   ./scripts/run-claude-sandbox.sh                 # launches claude
#   ./scripts/run-claude-sandbox.sh /status         # forwards args to claude
#
# Env knobs (all optional):
#   SANDBOX             Sandbox name         (default: claude-<basename of $PWD>)
#   KEYCHAIN_SERVICE    Keychain service     (default: ANTHROPIC_AUTH_TOKEN)
#   KEYCHAIN_ACCOUNT    Keychain account     (default: $USER)
#   ANTHROPIC_BASE_URL  Gateway URL          (default: https://ai-gateway.vercel.sh)
#   MODEL               Model ID             (default: claude-opus-4-7)

set -euo pipefail

KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-ANTHROPIC_AUTH_TOKEN}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-$USER}"
GATEWAY_URL="${ANTHROPIC_BASE_URL:-https://ai-gateway.vercel.sh}"
MODEL="${MODEL:-claude-opus-4-7}"
SANDBOX="${SANDBOX:-claude-$(basename "$PWD")}"

if ! command -v security >/dev/null 2>&1; then
  echo "Error: 'security' CLI not found — this wrapper expects a macOS host." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: 'docker' CLI not found." >&2
  exit 1
fi

if ! TOKEN="$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" || [[ -z "$TOKEN" ]]; then
  cat >&2 <<EOF
Error: '$KEYCHAIN_SERVICE' not found in macOS Keychain (account: $KEYCHAIN_ACCOUNT).

Create it once with:
  security add-generic-password -a "\$USER" -s "ANTHROPIC_AUTH_TOKEN" -U -w
EOF
  exit 1
fi

# Create the sandbox if it doesn't already exist.
if ! docker sandbox ls 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$SANDBOX"; then
  echo "Creating sandbox '$SANDBOX' for $PWD…"
  docker sandbox create claude "$PWD"
fi

# One-time onboarding bypass — older Claude Code versions re-prompt for login
# even with auth env vars set unless this flag is present.
docker sandbox exec "$SANDBOX" bash -lc '
  mkdir -p "$HOME/.claude"
  if [[ ! -f "$HOME/.claude.json" ]]; then
    printf "{\"hasCompletedOnboarding\": true}\n" > "$HOME/.claude.json"
  fi
' >/dev/null

# Launch Claude Code with auth + model injected via env vars.
#
# MAX_THINKING_TOKENS=0 disables extended thinking on the CLI side. Opus 4.7
# requires the new thinking.type.adaptive schema, but Claude Code 2.1.71 still
# emits thinking.type.enabled, so the request is rejected at the gateway.
# Suppressing the thinking block entirely sidesteps the schema mismatch until
# the CLI catches up; remove this once Claude Code ships adaptive thinking.
# (Same workaround as run-claude-afk-signed.sh.)
exec docker sandbox exec -it \
  -e ANTHROPIC_BASE_URL="$GATEWAY_URL" \
  -e ANTHROPIC_AUTH_TOKEN="$TOKEN" \
  -e ANTHROPIC_MODEL="$MODEL" \
  -e MAX_THINKING_TOKENS=0 \
  "$SANDBOX" \
  claude "$@"
