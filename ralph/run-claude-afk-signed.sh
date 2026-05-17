#!/usr/bin/env bash
#
# Signed-commits variant of run-claude-afk.sh.
#
# Identical to the base AFK wrapper except for one extra cleanup step:
# every commit Claude lands inside the sandbox during the loop gets
# re-signed on the host before the script exits, so `git push` against a
# branch with "Require signed commits" protection succeeds.
#
# WHY THE WRAPPER, NOT THE SANDBOX
#
# The sandbox is intentionally a stripped identity — no `~/.ssh`, no
# `~/.gnupg`, no agent socket forwarding. Configuring git inside the
# sandbox to sign would either (a) require copying your private key into
# a container that runs untrusted AI output with
# `--dangerously-skip-permissions`, or (b) require a dedicated
# sandbox-bound signing key registered separately with GitHub.
#
# Re-signing on the host sidesteps both: key material never crosses the
# trust boundary, and you keep your normal git identity in commit
# history. The host already has signing configured (SSH or GPG); we just
# replay the loop's commits through it.
#
# HOW
#
# 1. Before the loop: snapshot `git rev-parse HEAD` into LOOP_START_SHA
#    and assert that `user.signingkey` is configured on the host.
# 2. After the loop (cleanup trap, fires on success, error, or Ctrl+C):
#    `git rebase --exec 'git commit --amend --no-edit -S' "$LOOP_START_SHA"`
#    which replays every commit in $LOOP_START_SHA..HEAD and amends each
#    with a signature using the host's configured `gpg.format` +
#    `user.signingkey` (SSH or GPG, doesn't matter).
# 3. SHAs change. This is fine because the AFK loop never pushes — you
#    push from the host after the loop completes.
#
# WHEN NOT TO USE THIS
#
# - If something else has already pushed the unsigned commits, do not
#   run this — the SHA rewrite will diverge from the remote.
# - If you want commits attributed to a sandbox-specific identity (audit
#   trail saying "Ralph did this, not me"), use the sandbox-local SSH
#   signing key approach instead; this wrapper attributes everything to
#   your host identity.
#
# Usage:
#   ./scripts/docker-sandbox/run-claude-afk-signed.sh "<plan-and-prd>" <iterations>
#   ./scripts/docker-sandbox/run-claude-afk-signed.sh <iterations> --source github-issues
#
# Env knobs are identical to run-claude-afk.sh. Plus:
#   RALPH_SKIP_SIGN=1    Disable post-loop re-signing for one run.

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

Re-signs every commit produced by the loop on the host before exit.
Set RALPH_SKIP_SIGN=1 to disable signing for one run.
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
SKIP_SIGN="${RALPH_SKIP_SIGN:-0}"

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

if ! command -v git >/dev/null 2>&1; then
  echo "Error: 'git' CLI not found." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Signing config verification — assert the host can actually sign before we
# spend an hour generating commits we can't sign.
# -----------------------------------------------------------------------------
if [[ "$SKIP_SIGN" != "1" ]]; then
  SIGNING_KEY="$(git config --get user.signingkey 2>/dev/null || echo "")"
  SIGNING_FORMAT="$(git config --get gpg.format 2>/dev/null || echo "openpgp")"

  if [[ -z "$SIGNING_KEY" ]]; then
    cat >&2 <<'EOF'
Error: no signing key configured on the host.

This wrapper re-signs every commit Ralph makes inside the sandbox using
your host signing key. Configure it once:

  # SSH signing (recommended — works with 1Password, hardware keys, etc.)
  git config --global gpg.format ssh
  git config --global user.signingkey ~/.ssh/id_ed25519.pub
  git config --global commit.gpgsign true

  # OR GPG signing
  git config --global user.signingkey <GPG-KEY-ID>
  git config --global commit.gpgsign true

Then add the matching public key to GitHub → Settings → SSH and GPG
keys → New SSH key → "Signing Key" (for SSH) or upload your GPG public
key (for GPG).

To bypass this check for one run: RALPH_SKIP_SIGN=1 $0 …
EOF
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# Capture the starting commit so the cleanup trap knows which range to
# re-sign. If we can't read HEAD (not a repo, or empty repo) bail early —
# Ralph needs commits to anchor against.
# -----------------------------------------------------------------------------
if ! LOOP_START_SHA="$(git rev-parse HEAD 2>/dev/null)"; then
  echo "Error: not in a git repository, or repository has no commits yet." >&2
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

# -----------------------------------------------------------------------------
# Post-loop signing. Runs in the cleanup trap so it fires on normal exit,
# error, and Ctrl+C — anywhere the script terminates with new commits in
# the working tree.
#
# Sequence in cleanup matters: sign FIRST (against the tree as the loop
# left it), THEN do pnpm reconciliation (which may regenerate
# pnpm-lock.yaml and definitely rewrites node_modules). Signing only
# touches commit metadata, not the worktree, so the reconciliation runs
# against the same tree it would have otherwise.
# -----------------------------------------------------------------------------
sign_new_commits() {
  if [[ "$SKIP_SIGN" == "1" ]]; then
    echo ""
    echo "Skipping commit signing (RALPH_SKIP_SIGN=1)."
    return 0
  fi

  if [[ -z "${LOOP_START_SHA:-}" ]]; then
    return 0
  fi

  local current_head commit_count
  current_head="$(git rev-parse HEAD 2>/dev/null || echo "")"

  if [[ -z "$current_head" || "$current_head" == "$LOOP_START_SHA" ]]; then
    echo ""
    echo "No new commits to sign."
    return 0
  fi

  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    cat >&2 <<EOF

Skipping commit signing: working tree has uncommitted changes.
Commit or stash them, then re-sign manually:

  git rebase --exec 'git commit --amend --no-edit -S' $LOOP_START_SHA
EOF
    return 1
  fi

  commit_count="$(git rev-list --count "$LOOP_START_SHA..HEAD" 2>/dev/null || echo "?")"

  echo ""
  echo "Signing $commit_count new commit(s) (${SIGNING_FORMAT:-openpgp} → $SIGNING_KEY)…"

  # GIT_EDITOR=true makes --amend non-interactive even if EDITOR is set
  # to something that opens a buffer.
  if GIT_EDITOR=true git rebase --exec 'git commit --amend --no-edit -S' "$LOOP_START_SHA" >/dev/null 2>&1; then
    echo "  ✓ All $commit_count commit(s) signed."
  else
    cat >&2 <<EOF
  ✗ Rebase failed. Repo may be mid-rebase.

To recover, run:
  git rebase --abort
  git rebase --exec 'git commit --amend --no-edit -S' $LOOP_START_SHA
EOF
    return 1
  fi
}

TMPFILES=()
cleanup() {
  for f in "${TMPFILES[@]}"; do rm -f "$f"; done

  sign_new_commits || true

  if [ -f "$PWD/package.json" ] && command -v pnpm >/dev/null 2>&1; then
    echo ""
    echo "Reconciling host node_modules for macOS native binaries…"
    (
      cd "$PWD"
      # CI=true tells pnpm to never prompt interactively (e.g. "wipe
      # node_modules?" when the lockfile drifted). Without it, the
      # piped-into-tail invocation below has no TTY and pnpm hangs
      # forever waiting on a y/N answer.
      export CI=true
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

if [[ "$SKIP_SIGN" == "1" ]]; then
  SIGN_LABEL="off (RALPH_SKIP_SIGN=1)"
else
  SIGN_LABEL="${SIGNING_FORMAT:-openpgp} → $SIGNING_KEY"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "Sandbox:    $SANDBOX (running)"
echo "Workspace:  $PWD"
echo "Auth:       ANTHROPIC_AUTH_TOKEN → $GATEWAY_URL"
echo "Model:      $MODEL"
echo "Source:     $SOURCE_LABEL"
echo "Signing:    $SIGN_LABEL"
echo "Base SHA:   $LOOP_START_SHA"
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
  # MAX_THINKING_TOKENS=0 disables extended thinking on the CLI side. Opus 4.7
  # requires the new thinking.type.adaptive schema, but Claude Code 2.1.71 still
  # emits thinking.type.enabled, so the request is rejected. Suppressing the
  # thinking block entirely sidesteps the schema mismatch until the CLI catches
  # up; remove this env once Claude Code ships adaptive thinking.
  #
  # The payload is piped via stdin rather than passed as argv to claude. With
  # 25+ open issues including bodies and comments, the combined argv used to
  # blow past the kernel's ARG_MAX limit (`exec: argument list too long`).
  # stdin is bounded by a much larger pipe buffer and effectively unlimited
  # for our purposes. -i on docker sandbox exec forwards stdin into the
  # container.
  printf '%s' "Previous commits: $commits $task_context $prompt" \
  | docker sandbox exec -i \
    -w "$PWD" \
    -e ANTHROPIC_BASE_URL="$GATEWAY_URL" \
    -e ANTHROPIC_AUTH_TOKEN="$TOKEN" \
    -e ANTHROPIC_MODEL="$MODEL" \
    -e MAX_THINKING_TOKENS=0 \
    "$SANDBOX" \
    claude \
      --verbose \
      --print \
      --dangerously-skip-permissions \
      --output-format stream-json \
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
