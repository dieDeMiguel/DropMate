FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Suppress Corepack's interactive download-confirmation prompt. Newer
# Corepack versions (Node 22+) ask "Y/n" before fetching a non-cached
# package manager, which hangs forever in a non-interactive sandbox
# and surfaces as `pnpm install` exit 1 with a single-line
# "Corepack is about to download ..." message and nothing else.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Tell pnpm we're in CI mode so it skips the interactive
# `Aborted removal of modules directory due to no TTY`
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) prompt. The sandcastle
# worktree bind-mount can carry an existing node_modules from the host
# (different platform binaries — host is darwin-arm64, container is
# linux); pnpm needs to nuke and reinstall, and the prompt is what
# blocks that in a non-TTY context.
ENV CI=true

# Rename the base image's "node" user (UID 1000) to "agent".
# This keeps UID 1000 so that --userns=keep-id (Podman) and
# --user 1000:1000 (Docker) map to the correct home directory owner.
RUN usermod -d /home/agent -m -l agent node
USER agent

# Pre-fetch the pnpm version pinned in DropMate's package.json
# (`packageManager: pnpm@10.33.0+sha512...`) into the agent user's
# Corepack store BEFORE sandcastle's `onSandboxReady: pnpm install`
# runs. Must execute after `USER agent` so the cache lands in
# /home/agent/.cache/corepack, not /root.
RUN corepack prepare pnpm@10.33.0 --activate

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
