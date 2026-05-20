#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
Common local Ash verification commands:

  ash info
  ash build
  pnpm dev

Optional durable run smoke test:

  curl -X POST http://127.0.0.1:3000/.well-known/ash/v1/message \
    -H 'content-type: application/json' \
    -d '{"message":"Hello"}'
EOF
