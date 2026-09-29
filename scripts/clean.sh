#!/usr/bin/env bash
# Removes regenerable local artifacts (deps, native projects, build output, caches).
# Usage: pnpm clean  (deletes immediately, printing what was removed and sizes)
#
# Never touches: .env files, .repos/, .codex-tasks/, .claude/worktrees/,
# contracts/broadcast/ (deployment records) or contracts/lib/ (submodules).
# Restore afterwards with `pnpm install` and `pnpm --filter mobile exec expo prebuild`.
set -euo pipefail

cd "$(dirname "$0")/.."

targets=(
  mobile/ios
  mobile/android
  mobile/.expo
  api/dist
  contracts/cache
  contracts/out
  .pnpm-store
)

# Dirs find should never descend into: kept dirs, plus native projects already removed whole.
skip=(\( -name .git -o -path ./.repos -o -path ./.claude/worktrees -o -path ./contracts/lib
  -o -path ./mobile/ios -o -path ./mobile/android \) -prune)

# Every node_modules dir (outermost only), build artifacts, and Finder junk.
while IFS= read -r path; do
  targets+=("$path")
done < <(find . "${skip[@]}" -o -type d -name node_modules -print -prune \
  -o \( -name '*.ipa' -o -name '*.apk' -o -name '*.aab' -o -name '*.tsbuildinfo' -o -name .DS_Store \) -print)

existing=()
for path in "${targets[@]}"; do
  [[ -e "$path" ]] && existing+=("$path")
done

if ((${#existing[@]} == 0)); then
  echo "Nothing to clean."
  exit 0
fi

du -sh "${existing[@]}" | sort -h
echo "Total: $(du -shc "${existing[@]}" | tail -1 | cut -f1)"

rm -rf "${existing[@]}"
echo "Cleaned."
