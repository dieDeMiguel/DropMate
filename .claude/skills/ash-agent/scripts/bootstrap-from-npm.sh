#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-my-agent}"

pnpm dlx experimental-ash@latest init "$APP_NAME"
cd "$APP_NAME"
pnpm install
pnpm dev
