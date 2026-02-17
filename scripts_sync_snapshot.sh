#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${COMMAND_CENTER_PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python3.11 >/dev/null 2>&1; then
    PYTHON_BIN="python3.11"
  else
    PYTHON_BIN="python3"
  fi
fi
TARGET_SNAPSHOT="${COMMAND_CENTER_TARGET_SNAPSHOT:-$APP_ROOT/snapshot.json}"
MAX_SNAPSHOT_AGE_MINUTES="${COMMAND_CENTER_MAX_SNAPSHOT_AGE_MINUTES:-30}"
MAX_OUTREACH_SNAPSHOT_AGE_MINUTES="${COMMAND_CENTER_MAX_OUTREACH_SNAPSHOT_AGE_MINUTES:-90}"
MAX_OUTREACH_TELEMETRY_AGE_MINUTES="${COMMAND_CENTER_MAX_OUTREACH_TELEMETRY_AGE_MINUTES:-90}"
MIN_OUTREACH_HEALTH_ROWS="${COMMAND_CENTER_MIN_OUTREACH_HEALTH_ROWS:-1}"
MAX_PROJECT_CONTRACT_AGE_MINUTES="${COMMAND_CENTER_MAX_PROJECT_CONTRACT_AGE_MINUTES:-120}"
PROJECT_CONTRACTS_REQUIRED="${COMMAND_CENTER_PROJECT_CONTRACTS_REQUIRED:-true}"
PROJECT_MODULES_REQUIRED="${COMMAND_CENTER_REQUIRE_PROJECT_MODULES:-true}"
PROJECT_CONTRACT_FILES_REQUIRED="${COMMAND_CENTER_REQUIRE_PROJECT_CONTRACT_FILES:-false}"
PROJECT_CONTRACT_OVERLAY_SCRIPT="${COMMAND_CENTER_PROJECT_CONTRACT_OVERLAY_SCRIPT:-$APP_ROOT/scripts/build_project_contract_overlay.py}"
OPERATOR_CONFIG_PATH="${COMMAND_CENTER_OPERATOR_CONFIG_PATH:-$APP_ROOT/operator.config.json}"

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

copy_snapshot_file() {
  local source_path="$1"
  local target_path="$2"
  if [[ -e "$source_path" && -e "$target_path" && "$source_path" -ef "$target_path" ]]; then
    log "Source and target snapshot are the same file; skipping copy"
    return 0
  fi
  cp "$source_path" "$target_path"
}

apply_project_contract_overlay() {
  if [[ ! -f "$TARGET_SNAPSHOT" ]]; then
    return
  fi
  if [[ -f "$PROJECT_CONTRACT_OVERLAY_SCRIPT" ]]; then
    log "Applying project contract overlay"
    "$PYTHON_BIN" "$PROJECT_CONTRACT_OVERLAY_SCRIPT" \
      --snapshot "$TARGET_SNAPSHOT" \
      --operator-config "$OPERATOR_CONFIG_PATH" \
      --output "$TARGET_SNAPSHOT"
  else
    log "Project contract overlay script not found: ${PROJECT_CONTRACT_OVERLAY_SCRIPT}"
  fi
}

validate_snapshot_freshness() {
  "$PYTHON_BIN" - "$TARGET_SNAPSHOT" \
    "$MAX_SNAPSHOT_AGE_MINUTES" \
    "$MAX_OUTREACH_SNAPSHOT_AGE_MINUTES" \
    "$MAX_OUTREACH_TELEMETRY_AGE_MINUTES" \
    "$MIN_OUTREACH_HEALTH_ROWS" \
    "$MAX_PROJECT_CONTRACT_AGE_MINUTES" \
    "$PROJECT_CONTRACTS_REQUIRED" \
    "$PROJECT_MODULES_REQUIRED" \
    "$PROJECT_CONTRACT_FILES_REQUIRED" \
    "$OPERATOR_CONFIG_PATH" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
max_snapshot_age = float(sys.argv[2])
max_outreach_snapshot_age = float(sys.argv[3])
max_outreach_telemetry_age = float(sys.argv[4])
min_health_rows = float(sys.argv[5])
max_project_contract_age = float(sys.argv[6])
project_contracts_required = str(sys.argv[7]).strip().lower() not in {"0", "false", "off", "no"}
project_modules_required = str(sys.argv[8]).strip().lower() not in {"0", "false", "off", "no"}
project_contract_files_required = str(sys.argv[9]).strip().lower() not in {"0", "false", "off", "no"}
operator_config_path = Path(sys.argv[10])

if not path.exists():
    raise SystemExit(f"[sync] freshness check failed: snapshot missing: {path}")

data = json.loads(path.read_text(encoding="utf-8"))
operator_config = {}
if operator_config_path.exists():
    try:
        operator_config = json.loads(operator_config_path.read_text(encoding="utf-8"))
    except Exception:
        operator_config = {}
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

project_contracts = data.get("projectContracts") or {}
project_entries = project_contracts.get("projects") if isinstance(project_contracts.get("projects"), list) else []
expected_count = len(operator_config.get("projects") or []) if isinstance(operator_config, dict) else 0
if project_contracts_required and not project_entries:
    errors.append("projectContracts.projects missing/empty")
if project_contracts_required and expected_count and len(project_entries) < expected_count:
    errors.append(
        f"projectContracts.projects count too low: {len(project_entries)} (expected >= {expected_count})"
    )

def project_age_minutes(project):
    age_seconds = project.get("ageSeconds")
    if age_seconds is not None:
        try:
            return max(0.0, float(age_seconds) / 60.0)
        except Exception:
            pass
    return age_minutes(project.get("generatedAt"))

for idx, project in enumerate(project_entries):
    if not isinstance(project, dict):
        continue
    project_id = str(project.get("projectId") or f"project[{idx}]")
    if project_contracts_required:
        age_m = project_age_minutes(project)
        if age_m is None:
            errors.append(f"{project_id} missing/invalid generatedAt")
        elif age_m > max_project_contract_age:
            errors.append(
                f"{project_id} stale project contract: {age_m:.1f}m (max {max_project_contract_age:.1f}m)"
            )

        if project.get("isStale") is True:
            reason = str(project.get("staleReason") or "unknown")
            errors.append(f"{project_id} marked stale ({reason})")

    modules = project.get("modules")
    if project_modules_required and (not isinstance(modules, list) or not modules):
        errors.append(f"{project_id} missing dynamic modules")

    if project_contract_files_required and not bool(project.get("contractFound")):
        errors.append(f"{project_id} missing project contract file")

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
    f"health_rows={health_rows_value:g} "
    f"project_contracts={len(project_entries)}"
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
  self_path="${APP_ROOT}/scripts_sync_snapshot.sh"
  if [[ "$SYNC_CMD" == *"$self_path"* ]] || [[ "$SYNC_CMD" =~ (^|[[:space:]])scripts_sync_snapshot\.sh($|[[:space:]]) ]]; then
    log "Skipping COMMAND_CENTER_LIVE_SYNC_CMD to avoid recursive scripts_sync_snapshot.sh invocation"
  else
    log "Running COMMAND_CENTER_LIVE_SYNC_CMD"
    bash -lc "$SYNC_CMD"
    if [[ -f "$TARGET_SNAPSHOT" ]]; then
      apply_project_contract_overlay
      validate_snapshot_freshness
      log "Snapshot synced via custom command: ${TARGET_SNAPSHOT}"
      exit 0
    fi
    log "Custom command ran but target snapshot not found: ${TARGET_SNAPSHOT}"
  fi
fi

for OPS_ROOT in "${OPS_ROOT_CANDIDATES[@]}"; do
  synth="${OPS_ROOT}/scripts/synthesize_command_center_signals.py"
  build="${OPS_ROOT}/scripts/build_command_center_snapshot.py"
  out_snapshot="${OPS_ROOT}/output/command_center/snapshot.json"

  if [[ -f "$synth" && -f "$build" ]]; then
    log "Using OPS_ROOT build path: ${OPS_ROOT}"
    "$PYTHON_BIN" "$synth"
    "$PYTHON_BIN" "$build"
    if [[ -f "$out_snapshot" ]]; then
      copy_snapshot_file "$out_snapshot" "$TARGET_SNAPSHOT"
      apply_project_contract_overlay
      validate_snapshot_freshness
      log "Snapshot synced (synth + build + copy)."
      exit 0
    fi
  fi

done

if [[ -n "$SOURCE_SNAPSHOT_FILE" && -f "$SOURCE_SNAPSHOT_FILE" ]]; then
  log "Copying snapshot from COMMAND_CENTER_SOURCE_SNAPSHOT"
  copy_snapshot_file "$SOURCE_SNAPSHOT_FILE" "$TARGET_SNAPSHOT"
  apply_project_contract_overlay
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
  apply_project_contract_overlay
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
