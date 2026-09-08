#!/usr/bin/env bash
set -euo pipefail

# Drizzle Kit RC5 removed --strict. Preview first, then require explicit consent.
pnpm exec drizzle-kit push --config drizzle.config.ts --explain

printf '\nApply these schema changes? Type yes to continue: '
if ! IFS= read -r answer || [[ "$answer" != "yes" ]]; then
  printf 'Aborted. No schema changes applied.\n'
  exit 0
fi

exec pnpm exec drizzle-kit push --config drizzle.config.ts
