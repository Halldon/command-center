#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_SNAPSHOT="${COMMAND_CENTER_TARGET_SNAPSHOT:-$ROOT_DIR/snapshot.json}"

OPS_ROOT_CANDIDATES=()
if [[ -n "${COMMAND_CENTER_OPS_ROOT:-}" ]]; then
  OPS_ROOT_CANDIDATES+=("$COMMAND_CENTER_OPS_ROOT")
fi
OPS_ROOT_CANDIDATES+=(
  "/Users/j/.openclaw/workspace/ops"
  "/Users/jameshalldon/.openclaw/workspace/ops"
)

run_ops_pipeline=0
source_snapshot=""

for ops_root in "${OPS_ROOT_CANDIDATES[@]}"; do
  synth="$ops_root/scripts/synthesize_command_center_signals.py"
  build="$ops_root/scripts/build_command_center_snapshot.py"
  out_snapshot="$ops_root/output/command_center/snapshot.json"
  if [[ -f "$synth" && -f "$build" ]]; then
    python3 "$synth"
    python3 "$build"
    run_ops_pipeline=1
  fi
  if [[ -f "$out_snapshot" ]]; then
    source_snapshot="$out_snapshot"
    break
  fi
done

if [[ -n "${COMMAND_CENTER_SOURCE_SNAPSHOT:-}" && -f "${COMMAND_CENTER_SOURCE_SNAPSHOT}" ]]; then
  source_snapshot="${COMMAND_CENTER_SOURCE_SNAPSHOT}"
fi

if [[ -z "$source_snapshot" ]]; then
  echo "No source snapshot found. Set COMMAND_CENTER_OPS_ROOT or COMMAND_CENTER_SOURCE_SNAPSHOT." >&2
  exit 1
fi

if [[ "$source_snapshot" != "$TARGET_SNAPSHOT" ]]; then
  cp "$source_snapshot" "$TARGET_SNAPSHOT"
fi

if [[ "$run_ops_pipeline" -eq 1 ]]; then
  echo "Snapshot synced (synth + build + copy)."
else
  echo "Snapshot synced (copy only)."
fi
