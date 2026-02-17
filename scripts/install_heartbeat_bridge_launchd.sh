#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.commandcenter.heartbeat-bridge.plist"
PYTHON_BIN="$(command -v python3)"
RUNTIME_ROOT="$HOME/.command-center/heartbeat-bridge"
SCRIPT_PATH="$RUNTIME_ROOT/emit_project_heartbeats.py"
CONFIG_PATH="$RUNTIME_ROOT/operator.config.json"
ENV_PATH="$RUNTIME_ROOT/.env.local"
LOG_DIR="$RUNTIME_ROOT/logs"
mkdir -p "$LOG_DIR" "$RUNTIME_ROOT"

if [[ -z "$PYTHON_BIN" ]]; then
  echo "[heartbeat-bridge] python3 not found"
  exit 1
fi

cp "$ROOT/scripts/emit_project_heartbeats.py" "$SCRIPT_PATH"
cp "$ROOT/operator.config.json" "$CONFIG_PATH"
if [[ -f "$ROOT/.env.local" ]]; then
  cp "$ROOT/.env.local" "$ENV_PATH"
else
  : > "$ENV_PATH"
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.commandcenter.heartbeat-bridge</string>
    <key>ProgramArguments</key>
    <array>
      <string>$PYTHON_BIN</string>
      <string>$SCRIPT_PATH</string>
      <string>--config</string>
      <string>$CONFIG_PATH</string>
      <string>--env-local</string>
      <string>$ENV_PATH</string>
      <string>--timeout-seconds</string>
      <string>25</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>WorkingDirectory</key>
    <string>$RUNTIME_ROOT</string>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>
  </dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"
launchctl start com.commandcenter.heartbeat-bridge || true

echo "[heartbeat-bridge] installed + started"
echo "[heartbeat-bridge] plist: $PLIST_PATH"
echo "[heartbeat-bridge] logs:  $LOG_DIR"
echo "[heartbeat-bridge] runtime: $RUNTIME_ROOT"
