#!/usr/bin/env bash
# Runs QOP Desktop with live editing: saved changes to function bodies under src/ui/ patch into
# the open window; any other edit rebuilds and relaunches it. Loads desktop/.env if present.
# Needs Dioxus CLI 0.7.10 (`cargo install dioxus-cli@0.7.10 --locked`) and Python 3.11+ (found via uv).
#   scripts/hot.sh [-- APP ARGS]
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
# Rune's launcher ships in the pinned Rune checkout, next to its crates.
rune_manifest=$(cargo metadata --format-version 1 | python3 -c 'import json, sys; print(next(p["manifest_path"] for p in json.load(sys.stdin)["packages"] if p["name"] == "rune"))')
rune_root=$(dirname "$(dirname "$(dirname "$rune_manifest")")")
# Rune's launcher needs Python 3.11+ (tomllib); macOS ships 3.9, so ask uv for one if it's there.
python=$(uv python find '>=3.11' 2>/dev/null || command -v python3)
"$python" -c 'import sys; sys.exit(sys.version_info < (3, 11))' ||
  { echo "hot.sh: needs Python 3.11+; install one with: uv python install 3.12" >&2; exit 1; }
# What `scripts/rune-hot` runs, with that interpreter instead of whatever `python3` is on PATH.
exec "$python" "$rune_root/scripts/rune-dev" --local --manifest-path "$PWD/Cargo.toml" --patch 'src/ui/**/*.rs' --port 18745 "$@"
