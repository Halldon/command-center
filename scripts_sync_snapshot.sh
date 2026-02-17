#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SNAPSHOT="${COMMAND_CENTER_TARGET_SNAPSHOT:-$APP_ROOT/snapshot.json}"

SYNC_CMD="${COMMAND_CENTER_LIVE_SYNC_CMD:-}"
SNAPSHOT_SOURCE_RAW="${COMMAND_CENTER_SNAPSHOT_SOURCE_URL:-}"
SOURCE_SNAPSHOT_FILE="${COMMAND_CENTER_SOURCE_SNAPSHOT:-}"

OPS_ROOT_CANDIDATES=()
if [[ -n "${COMMAND_CENTER_OPS_ROOT:-}" ]]; then
  OPS_ROOT_CANDIDATES+=("$COMMAND_CENTER_OPS_ROOT")
fi
OPS_ROOT_CANDIDATES+=(
  "/Users/j/.openclaw/workspace/ops"
  "/Users/jameshalldon/.openclaw/workspace/ops"
)

log() { printf '[sync] %s\n' "$*"; }

SNAPSHOT_URL=""
SNAPSHOT_AUTH_HEADER="${COMMAND_CENTER_SNAPSHOT_AUTH_HEADER:-}"
if [[ -n "$SNAPSHOT_SOURCE_RAW" ]]; then
  if [[ "$SNAPSHOT_SOURCE_RAW" == *"||"* ]]; then
    SNAPSHOT_URL="${SNAPSHOT_SOURCE_RAW%%||*}"
    if [[ -z "$SNAPSHOT_AUTH_HEADER" ]]; then
      SNAPSHOT_AUTH_HEADER="${SNAPSHOT_SOURCE_RAW#*||}"
    fi
  else
    SNAPSHOT_URL="$SNAPSHOT_SOURCE_RAW"
  fi
fi

if [[ -n "$SYNC_CMD" ]]; then
  log "Running COMMAND_CENTER_LIVE_SYNC_CMD"
  bash -lc "$SYNC_CMD"
  if [[ -f "$TARGET_SNAPSHOT" ]]; then
    log "Snapshot synced via custom command: ${TARGET_SNAPSHOT}"
    exit 0
  fi
  log "Custom command ran but target snapshot not found: ${TARGET_SNAPSHOT}"
fi

for OPS_ROOT in "${OPS_ROOT_CANDIDATES[@]}"; do
  synth="${OPS_ROOT}/scripts/synthesize_command_center_signals.py"
  build="${OPS_ROOT}/scripts/build_command_center_snapshot.py"
  out_snapshot="${OPS_ROOT}/output/command_center/snapshot.json"

  if [[ -f "$synth" && -f "$build" ]]; then
    log "Using OPS_ROOT build path: ${OPS_ROOT}"
    python3 "$synth"
    python3 "$build"
    if [[ -f "$out_snapshot" ]]; then
      cp "$out_snapshot" "$TARGET_SNAPSHOT"
      log "Snapshot synced (synth + build + copy)."
      exit 0
    fi
  fi

done

if [[ -n "$SOURCE_SNAPSHOT_FILE" && -f "$SOURCE_SNAPSHOT_FILE" ]]; then
  log "Copying snapshot from COMMAND_CENTER_SOURCE_SNAPSHOT"
  cp "$SOURCE_SNAPSHOT_FILE" "$TARGET_SNAPSHOT"
  log "Snapshot synced (copy only)."
  exit 0
fi

if [[ -n "$SNAPSHOT_URL" ]]; then
  log "Fetching snapshot from COMMAND_CENTER_SNAPSHOT_SOURCE_URL"
  CURL_ARGS=(-fsSL "$SNAPSHOT_URL" -o "$TARGET_SNAPSHOT")
  if [[ -n "$SNAPSHOT_AUTH_HEADER" ]]; then
    CURL_ARGS=(-H "$SNAPSHOT_AUTH_HEADER" "${CURL_ARGS[@]}")
  fi
  if ! curl "${CURL_ARGS[@]}"; then
    cat >&2 <<EOF
[sync] ERROR: Snapshot fetch failed from COMMAND_CENTER_SNAPSHOT_SOURCE_URL.

If your endpoint requires auth, set the secret in either form:
- Plain URL with token in query string
- URL||Header (single secret), e.g.
  https://api.example.com/snapshot||Authorization: Bearer <token>
EOF
    exit 1
  fi
  log "Snapshot downloaded to ${TARGET_SNAPSHOT}"
  exit 0
fi

cat >&2 <<EOF
[sync] ERROR: No valid snapshot source configured.

Tried in order:
1) COMMAND_CENTER_LIVE_SYNC_CMD
2) Local build via COMMAND_CENTER_OPS_ROOT/default OPS roots
3) COMMAND_CENTER_SOURCE_SNAPSHOT (file path)
4) COMMAND_CENTER_SNAPSHOT_SOURCE_URL

Set one of these env vars and retry.
EOF
exit 1
