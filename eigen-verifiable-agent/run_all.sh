#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node src/run_agent.js
node src/build_manifest.js
node src/sign_manifest.js
node src/verify_run.js

echo "✅ Verifiable run complete"
