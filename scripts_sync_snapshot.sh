#!/usr/bin/env bash
set -euo pipefail

python3 /Users/j/.openclaw/workspace/ops/scripts/synthesize_command_center_signals.py
python3 /Users/j/.openclaw/workspace/ops/scripts/build_command_center_snapshot.py
cp /Users/j/.openclaw/workspace/ops/output/command_center/snapshot.json /Users/j/.openclaw/workspace/command-center-app/snapshot.json

echo "Snapshot synced (synth + build)."
