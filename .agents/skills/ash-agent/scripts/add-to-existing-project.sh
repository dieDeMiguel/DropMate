#!/usr/bin/env bash
set -euo pipefail

pnpm add -D experimental-ash

cat <<'EOF'
Add your authored agent surface, then use:

  ash info
  ash build
  ash dev
EOF
