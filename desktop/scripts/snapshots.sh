#!/usr/bin/env bash
# Renders headless snapshots of every scene (or the ones named) in light and dark.
#   scripts/snapshots.sh [out-dir] [scene...]    default: snapshots/, every scene
set -euo pipefail
cd "$(dirname "$0")/.."
out=${1:-snapshots}
shift || true
cargo build --quiet
bin=target/debug/qop-desktop
scenes=("$@")
if [ ${#scenes[@]} -eq 0 ]; then
  # `live` renders a real data directory, not a fixture.
  read -r -a scenes <<< "$("$bin" --list-scenes 2>/dev/null | grep -vx live | tr '\n' ' ')"
fi
mkdir -p "$out"
for scene in "${scenes[@]}"; do
  for theme in light dark; do
    "$bin" --snap "$out/$scene-$theme.png" --scene "$scene" --theme "$theme" --at 1.5 --scale 1 >/dev/null 2>&1
  done
done
echo "wrote ${#scenes[@]} scenes to $out/"
