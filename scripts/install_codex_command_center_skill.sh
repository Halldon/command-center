#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SRC="$ROOT/skills/command-center-project-standard"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILL_DST="$CODEX_HOME/skills/command-center-project-standard"

mkdir -p "$CODEX_HOME/skills"
rm -rf "$SKILL_DST"
cp -R "$SKILL_SRC" "$SKILL_DST"

echo "[skill] installed command-center-project-standard -> $SKILL_DST"
