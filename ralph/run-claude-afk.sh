#!/usr/bin/env bash
#
# Run a Ralph-style AFK (away-from-keyboard) loop against Claude Code inside
# a Docker Desktop Sandbox, authenticated via the Vercel AI Gateway.
#
# Each iteration spawns a fresh `claude --print` process inside the sandbox.
# The sandbox itself is the trust boundary, so `--dangerously-skip-permissions`
# is set — Claude Code will not prompt for tool approvals.
#
# `docker sandbox run` can't pass env vars, so this wrapper:
#   1. Pulls ANTHROPIC_AUTH_TOKEN from the macOS Keychain at runtime.
#   2. Creates the sandbox if it doesn't already exist for $PWD.
#   3. Bypasses Claude Code's onboarding screen on first launch.
#   4. Drives each iteration via `docker sandbox exec -e …`, injecting auth,
#      gateway URL, and model.
#
# Usage:
#   ./scripts/run-claude-afk.sh "<plan-and-prd>" <iterations>             # PRD mode (default)
#   ./scripts/run-claude-afk.sh <iterations> --source github-issues        # GitHub Issues mode
#
# Examples:
#   ./scripts/run-claude-afk.sh "plans/admin-analytics-plan.md prd/admin-analytics.md" 5
#   ./scripts/run-claude-afk.sh 5 --source github-issues
#
# In github-issues mode the script fetches open issues with
# `gh issue list --state open --json number,title,body,comments` on the host
# at the start of every iteration and injects them into Claude's prompt. The
# sandbox itself also needs `gh` authenticated so Claude can close/comment
# issues from inside (the script verifies both).
#
# The loop terminates early if Claude emits "<promise>NO MORE TASKS</promise>"
# in its result.
#
# Env knobs (all optional):
#   SANDBOX             Sandbox name        (default: claude-<basename of $PWD>)
#   KEYCHAIN_SERVICE    Keychain service    (default: ANTHROPIC_AUTH_TOKEN)
#   KEYCHAIN_ACCOUNT    Keychain account    (default: $USER)
#   ANTHROPIC_BASE_URL  Gateway URL         (default: https://ai-gateway.vercel.sh)
#   MODEL               Model ID            (default: claude-opus-4-7)
#   PROMPT_FILE         Ralph prompt file   (default: ralph/prompt.md)

set -eo pipefail

# -----------------------------------------------------------------------------
# Argument parsing. Two shapes are accepted:
#   $0 <plan-and-prd> <iterations>           (PRD mode — default)
#   $0 <iterations> --source github-issues   (Issues mode — no plan/PRD needed)
# Flags can appear anywhere relative to positional args.
# -----------------------------------------------------------------------------
SOURCE="prd"
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)        SOURCE="$2"; shift 2 ;;
    --source=*)      SOURCE="${1#*=}"; shift ;;
    -h|--help)
      cat <<EOF
Usage:
  $0 <plan-and-prd> <iterations>            # PRD mode (default)
  $0 <iterations> --source github-issues    # GitHub Issues mode
EOF
      exit 0
      ;;
    *)               POSITIONAL+=("$1"); shift ;;
  esac
done

if [[ "$SOURCE" != "prd" && "$SOURCE" != "github-issues" ]]; then
  echo "Error: --source must be 'prd' or 'github-issues' (got: $SOURCE)" >&2
  exit 1
fi

if [[ "$SOURCE" == "prd" ]]; then
  if [[ ${#POSITIONAL[@]} -lt 2 ]]; then
    echo "Usage: $0 <plan-and-prd> <iterations>" >&2
    exit 1
  fi
  PLAN_AND_PRD="${POSITIONAL[0]}"
  ITERATIONS="${POSITIONAL[1]}"
else
  if [[ ${#POSITIONAL[@]} -lt 1 ]]; then
    echo "Usage: $0 <iterations> --source github-issues" >&2
    exit 1
  fi
  ITERATIONS="${POSITIONAL[0]}"
  PLAN_AND_PRD=""
fi

KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-ANTHROPIC_AUTH_TOKEN}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-$USER}"
GATEWAY_URL="${ANTHROPIC_BASE_URL:-https://ai-gateway.vercel.sh}"
MODEL="${MODEL:-claude-opus-4-7}"
SANDBOX="${SANDBOX:-claude-$(basename "$PWD")}"
PROMPT_FILE="${PROMPT_FILE:-ralph/prompt.md}"

if ! command -v security >/dev/null 2>&1; then
  echo "Error: 'security' CLI not found — this wrapper expects a macOS host." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: 'docker' CLI not found." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: 'jq' is required for streaming output parsing." >&2
  exit 1
fi

if ! TOKEN="$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" || [ -z "$TOKEN" ]; then
  cat >&2 <<EOF
Error: '$KEYCHAIN_SERVICE' not found in macOS Keychain (account: $KEYCHAIN_ACCOUNT).

Create it once with:
  security add-generic-password -a "\$USER" -s "ANTHROPIC_AUTH_TOKEN" -U -w
EOF
  exit 1
fi

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Error: prompt file '$PROMPT_FILE' not found. Override with PROMPT_FILE=…" >&2
  exit 1
fi

# Create the sandbox if it doesn't already exist. Track whether this run created it
# so we know whether to do the one-time Linux dependency install.
SANDBOX_CREATED=0
if ! docker sandbox ls 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$SANDBOX"; then
  echo "Creating sandbox '$SANDBOX' for $PWD…"
  docker sandbox create claude "$PWD"
  SANDBOX_CREATED=1
fi

# One-time onboarding bypass.
docker sandbox exec "$SANDBOX" bash -lc '
  mkdir -p "$HOME/.claude"
  if [ ! -f "$HOME/.claude.json" ]; then
    printf "{\"hasCompletedOnboarding\": true}\n" > "$HOME/.claude.json"
  fi
' >/dev/null

# Cross-platform dependency reconciliation (layer 1 of 2 — see also: skills):
# Host node_modules has macOS-native binaries (e.g. @rollup/rollup-darwin-arm64).
# The Linux sandbox needs Linux variants. On first sandbox creation, wipe
# node_modules and pnpm install fresh inside the sandbox so it has Linux
# binaries. On script exit, reinstall on the host so macOS gets its binaries
# back. This is the same pattern used by ralph-afk-skills.sh.
#
# Layer 2 lives in .claude/skills/ (auto-loaded by Claude Code inside the
# sandbox). When Claude hits a missed case mid-iteration — e.g. a different
# native module trips on platform/version mismatch — the relevant skill
# (cross-platform-deps-rebuild, better-sqlite3-rebuild, etc.) instructs it
# how to self-heal without bloating this script.
if [ "$SANDBOX_CREATED" = "1" ] && [ -f package.json ]; then
  echo "  Installing pnpm inside sandbox…"
  docker sandbox exec "$SANDBOX" npm install -g pnpm@latest >/dev/null 2>&1 || \
    echo "  WARNING: failed to install pnpm in sandbox"

  echo "  Reinstalling node_modules inside sandbox (Linux native binaries)…"
  docker sandbox exec -w "$PWD" "$SANDBOX" \
    bash -c 'rm -rf node_modules && pnpm install --no-frozen-lockfile 2>&1 | tail -3' || \
    echo "  WARNING: pnpm install failed inside sandbox"
fi

# GitHub CLI auth checks for issues mode. Both host and sandbox need `gh`
# authenticated: the host fetches issues every iteration; the sandbox uses
# `gh issue close` / `gh issue comment` from inside to close out work.
if [[ "$SOURCE" == "github-issues" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "Error: 'gh' CLI not found on host. Install with: brew install gh" >&2
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "Error: gh is not authenticated on host. Run: gh auth login" >&2
    exit 1
  fi
  if ! docker sandbox exec "$SANDBOX" gh auth status >/dev/null 2>&1; then
    cat >&2 <<EOF
Error: gh is not authenticated inside the sandbox '$SANDBOX'.

Authenticate it once with:
  docker sandbox exec -it $SANDBOX gh auth login

Then re-run this script.
EOF
    exit 1
  fi
fi

TMPFILES=()
cleanup() {
  for f in "${TMPFILES[@]}"; do rm -f "$f"; done
  if [ -f "$PWD/package.json" ] && command -v pnpm >/dev/null 2>&1; then
    echo ""
    echo "Reconciling host node_modules for macOS native binaries…"
    (
      cd "$PWD"
      # Re-resolves optional-dep style cross-platform packages
      # (e.g. @rollup/rollup-darwin-arm64, lightningcss, swc).
      pnpm install --no-frozen-lockfile 2>&1 | tail -3
      # Re-runs lifecycle scripts so postinstall-script style native
      # modules (e.g. better-sqlite3, sharp, node-sass) recompile their
      # .node binaries for the current platform. `pnpm install` alone
      # short-circuits when packages already appear installed.
      pnpm rebuild 2>&1 | tail -5
    ) || true
  fi
}
trap cleanup EXIT

# jq filter: surfaces both Claude's prose AND the tool calls it makes
# (Read/Edit/Bash/Grep/etc.) in real time so we can see what's actually
# happening inside the sandbox during silent stretches.
stream_text='
  select(.type == "assistant").message.content[]? |
  if .type == "text" then
    .text | gsub("\n"; "\r\n") | . + "\r\n\n"
  elif .type == "tool_use" then
    "  ▸ " + .name + "  " + (
      (.input.file_path // .input.command // .input.pattern //
       .input.url // .input.query // .input.path //
       (.input | tostring))
      | tostring | .[0:160]
    ) + "\r\n"
  else empty end
'
final_result='select(.type == "result").result // empty'

# One-time pre-loop summary so the iterations have context.
# These values come from the host shell, not the VM — but they tell you
# exactly which sandbox, workspace, gateway, and model the loop is wired to.
if [[ "$SOURCE" == "github-issues" ]]; then
  ISSUE_COUNT=$(gh issue list --state open --json number 2>/dev/null | jq 'length' 2>/dev/null || echo "?")
  SOURCE_LABEL="GitHub Issues ($ISSUE_COUNT open)"
else
  SOURCE_LABEL="PRD ($PLAN_AND_PRD)"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "Sandbox:    $SANDBOX (running)"
echo "Workspace:  $PWD"
echo "Auth:       ANTHROPIC_AUTH_TOKEN → $GATEWAY_URL"
echo "Model:      $MODEL"
echo "Source:     $SOURCE_LABEL"
echo "Iterations: $ITERATIONS"
echo "─────────────────────────────────────────────"

for ((i=1; i<=ITERATIONS; i++)); do
  echo ""
  echo "── Iteration $i/$ITERATIONS ──"

  tmpfile=$(mktemp)
  TMPFILES+=("$tmpfile")

  commits=$(git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
  prompt=$(cat "$PROMPT_FILE")

  if [[ "$SOURCE" == "github-issues" ]]; then
    issues=$(gh issue list --state open --json number,title,body,comments 2>/dev/null || echo "[]")
    task_context="Open GitHub issues: $issues"
  else
    task_context="Plan and PRD: $PLAN_AND_PRD"
  fi

  # -w "$PWD" pins cwd to the bind-mounted workspace inside the sandbox.
  # Without it, claude starts in /home/agent (or sandbox default), can't find
  # the project, and may clone a fresh copy when the prompt has no relative
  # path hints (e.g. issues mode where the prompt only contains the issue
  # JSON, no plan/PRD file references).
  docker sandbox exec \
    -w "$PWD" \
    -e ANTHROPIC_BASE_URL="$GATEWAY_URL" \
    -e ANTHROPIC_AUTH_TOKEN="$TOKEN" \
    -e ANTHROPIC_MODEL="$MODEL" \
    "$SANDBOX" \
    claude \
      --verbose \
      --print \
      --dangerously-skip-permissions \
      --output-format stream-json \
      "Previous commits: $commits $task_context $prompt" \
  | grep --line-buffered '^{' \
  | tee "$tmpfile" \
  | jq --unbuffered -rj "$stream_text"

  result=$(jq -r "$final_result" "$tmpfile")

  if [[ "$result" == *"<promise>NO MORE TASKS</promise>"* ]]; then
    echo ""
    echo "Ralph complete after $i iterations."
    exit 0
  fi
done
