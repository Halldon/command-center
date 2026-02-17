#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SNAPSHOT="${COMMAND_CENTER_TARGET_SNAPSHOT:-$APP_ROOT/snapshot.json}"
MAX_SNAPSHOT_AGE_MINUTES="${COMMAND_CENTER_MAX_SNAPSHOT_AGE_MINUTES:-30}"
MAX_OUTREACH_SNAPSHOT_AGE_MINUTES="${COMMAND_CENTER_MAX_OUTREACH_SNAPSHOT_AGE_MINUTES:-90}"
MAX_OUTREACH_TELEMETRY_AGE_MINUTES="${COMMAND_CENTER_MAX_OUTREACH_TELEMETRY_AGE_MINUTES:-90}"
MIN_OUTREACH_HEALTH_ROWS="${COMMAND_CENTER_MIN_OUTREACH_HEALTH_ROWS:-1}"

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

validate_snapshot_freshness() {
  python3 - "$TARGET_SNAPSHOT" \
    "$MAX_SNAPSHOT_AGE_MINUTES" \
    "$MAX_OUTREACH_SNAPSHOT_AGE_MINUTES" \
    "$MAX_OUTREACH_TELEMETRY_AGE_MINUTES" \
    "$MIN_OUTREACH_HEALTH_ROWS" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
max_snapshot_age = float(sys.argv[2])
max_outreach_snapshot_age = float(sys.argv[3])
max_outreach_telemetry_age = float(sys.argv[4])
min_health_rows = float(sys.argv[5])

if not path.exists():
    raise SystemExit(f"[sync] freshness check failed: snapshot missing: {path}")

data = json.loads(path.read_text(encoding="utf-8"))
now = datetime.now(timezone.utc)
errors = []

def parse_iso(value):
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

def age_minutes(value):
    ts = parse_iso(value)
    if ts is None:
        return None
    return max(0.0, (now - ts).total_seconds() / 60.0)

def require_age(label, value, max_age):
    age = age_minutes(value)
    if age is None:
        errors.append(f"{label} missing/invalid timestamp")
        return None
    if age > max_age:
        errors.append(f"{label} stale: {age:.1f}m (max {max_age:.1f}m)")
    return age

outreach = data.get("outreach") or {}
outreach_snapshot = outreach.get("snapshot") or {}
outreach_telemetry = outreach.get("telemetry") or {}
telemetry_summary = outreach_telemetry.get("summary") or {}

snapshot_age = require_age("snapshot.generatedAt", data.get("generatedAt"), max_snapshot_age)
outreach_snapshot_age = require_age(
    "outreach.snapshot.generatedAt",
    outreach_snapshot.get("generatedAt"),
    max_outreach_snapshot_age,
)
outreach_telemetry_age = require_age(
    "outreach.telemetry.generatedAt",
    outreach_telemetry.get("generatedAt"),
    max_outreach_telemetry_age,
)

health_rows = outreach_snapshot.get("healthRows")
try:
    health_rows_value = float(health_rows)
except Exception:
    health_rows_value = None
if health_rows_value is None:
    errors.append("outreach.snapshot.healthRows missing/invalid")
elif health_rows_value < min_health_rows:
    errors.append(
        f"outreach.snapshot.healthRows too low: {health_rows_value:g} (min {min_health_rows:g})"
    )

failing_checks = telemetry_summary.get("failing")
if failing_checks is not None:
    try:
        failing_checks_value = int(failing_checks)
    except Exception:
        failing_checks_value = None
    if failing_checks_value is None:
        errors.append("outreach.telemetry.summary.failing invalid")

if errors:
    print("[sync] freshness gate failed:", file=sys.stderr)
    for issue in errors:
        print(f"[sync] - {issue}", file=sys.stderr)
    raise SystemExit(1)

print(
    "[sync] freshness gate ok: "
    f"snapshot_age={snapshot_age:.1f}m "
    f"outreach_snapshot_age={outreach_snapshot_age:.1f}m "
    f"outreach_telemetry_age={outreach_telemetry_age:.1f}m "
    f"health_rows={health_rows_value:g}"
)
PY
}

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
    validate_snapshot_freshness
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
      validate_snapshot_freshness
      log "Snapshot synced (synth + build + copy)."
      exit 0
    fi
  fi

done

if [[ -n "$SOURCE_SNAPSHOT_FILE" && -f "$SOURCE_SNAPSHOT_FILE" ]]; then
  log "Copying snapshot from COMMAND_CENTER_SOURCE_SNAPSHOT"
  cp "$SOURCE_SNAPSHOT_FILE" "$TARGET_SNAPSHOT"
  validate_snapshot_freshness
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
  validate_snapshot_freshness
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
