# Command Center App (Operator Edition)

Static Vercel app powered by deterministic snapshot artifacts generated in:

- `/Users/j/.openclaw/workspace/ops/scripts`
- `/Users/j/.openclaw/workspace/ops/output/command_center`

## Operator Config

Project commands, ownership, priority, data source metadata, and live-action security policy are defined in:

- `/Users/jameshalldon/Documents/Builds/Command Center/operator.config.json`

Update this file to add new projects or change health/verify/go-live/rollback command mappings.
If you want Reviews-mode branch promotion, add `branchFlow` per project (example: `["dev","main"]`).

## Authenticated Execution Endpoint

Live command execution is available at:

- `/api/execute`

Requirements:

1. Set `COMMAND_CENTER_EXEC_TOKEN` in runtime environment (local shell or Vercel env vars).
2. Send token as `X-Command-Center-Token` header.
3. Use `projectId` + `actionKey` only. Commands are resolved from `operator.config.json` allowlist.

Example (dry-run preview):

```bash
curl -s http://localhost:4173/api/execute \
  -H "content-type: application/json" \
  -H "x-command-center-token: $COMMAND_CENTER_EXEC_TOKEN" \
  -d '{"projectId":"outreach-pipeline","actionKey":"go_live","actor":"James","confirmed":true,"dryRun":true}' | jq
```

Notes:

- External irreversible actions require `confirmed: true`.
- Long-running paper-mode loop commands are started in background mode.
- Execution audit is appended to `runtime/exec_audit.jsonl` when writable.
- `promote_review` is a built-in action key. It validates and merges one branch step from `branchFlow` (for example `dev -> main`) and requires `confirmed: true`.

## Live Updates (no manual refresh)

The UI now uses a stream-first model:

- `/api/stream` long-polls and pushes snapshot changes continuously.
- Polling is fallback only (toggle in UI).
- Stream includes sync/staleness metadata so stuck pipelines are visible.

Optional auto-sync is controlled by `operator.config.json > liveSync` and env vars:

- `COMMAND_CENTER_AUTO_SYNC` (`true`/`false`)
- `COMMAND_CENTER_LIVE_SYNC_CMD` (override sync command)
- `COMMAND_CENTER_SYNC_INTERVAL_MS`
- `COMMAND_CENTER_STREAM_WAIT_MS`
- `COMMAND_CENTER_STREAM_POLL_MS`
- `COMMAND_CENTER_SYNC_TIMEOUT_MS`
- `COMMAND_CENTER_SYNC_FAILURE_BACKOFF_MS`
- `COMMAND_CENTER_FORCE_SYNC_WITHOUT_WATCH_PATHS` (`true` to run sync command even when watch paths are unresolved)
- `COMMAND_CENTER_OPS_ROOT`
- `COMMAND_CENTER_SOURCE_SNAPSHOT`
- `COMMAND_CENTER_TARGET_SNAPSHOT`

History retrieval:

```bash
curl -s http://localhost:4173/api/execute \
  -H "content-type: application/json" \
  -H "x-command-center-token: $COMMAND_CENTER_EXEC_TOKEN" \
  -d '{"action":"history","limit":25}' | jq
```

## Build + Sync Snapshot

```bash
bash /Users/j/.openclaw/workspace/command-center-app/scripts_sync_snapshot.sh
```

`scripts_sync_snapshot.sh` supports 3 modes (in this order):

1. `COMMAND_CENTER_LIVE_SYNC_CMD` (custom command)
2. local OPS build via `COMMAND_CENTER_OPS_ROOT`
3. pull from `COMMAND_CENTER_SNAPSHOT_SOURCE_URL`

## GitHub Actions Auto Sync (recommended)

Workflow file: `.github/workflows/snapshot-sync.yml`

It runs every 15 minutes + manual dispatch, updates `snapshot.json`, and commits only when changed.

### Required setup (GitHub repo settings)

- **Secrets**
  - `COMMAND_CENTER_SNAPSHOT_SOURCE_URL` (recommended): URL that returns the latest snapshot JSON.
    - If auth is required, you can encode header in the same secret:
      - `https://api.example.com/snapshot||Authorization: Bearer <token>`
    - Or include token in query string directly if your API supports it.
  - Optional: `COMMAND_CENTER_LIVE_SYNC_CMD` (advanced/custom runner command).
- **Variables**
  - Optional: `COMMAND_CENTER_OPS_ROOT` (default `/Users/j/.openclaw/workspace/ops`).

### Trigger manually

```bash
gh workflow run "Snapshot Sync" --repo Halldon/command-center
```

### Check recent runs

```bash
gh run list --repo Halldon/command-center --workflow "Snapshot Sync" --limit 10
```

## Local Smoke

```bash
cd /Users/j/.openclaw/workspace/command-center-app
python3 -m http.server 4173
# open http://localhost:4173
```

## Deploy

```bash
cd /Users/j/.openclaw/workspace/command-center-app
vercel --prod
```

## WebMCP-lite Endpoint (new)

A lightweight read-only structured tools endpoint is now available for agent/browser integrations:

- Discovery: `/.well-known/webmcp.json`
- API: `/api/webmcp`

Example:

```bash
curl -s https://command-center-app.vercel.app/api/webmcp | jq
curl -s https://command-center-app.vercel.app/api/webmcp \
  -H 'content-type: application/json' \
  -d '{"action":"call_tool","name":"get_attention_queue","arguments":{"limit":5}}' | jq
```

> Current mode is read-only and unauthenticated. Add auth before broad/public usage.

Docs:
- `docs/implementation-summary.md`
- `docs/operator-quickstart.md`
- `docs/rollback.md`
- `docs/verification.md`
