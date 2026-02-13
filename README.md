# Command Center App (Operator Edition)

Static Vercel app powered by deterministic snapshot artifacts generated in:

- `/Users/j/.openclaw/workspace/ops/scripts`
- `/Users/j/.openclaw/workspace/ops/output/command_center`

## Build + Sync Snapshot

```bash
bash /Users/j/.openclaw/workspace/command-center-app/scripts_sync_snapshot.sh
```

That runs:

1. `synthesize_command_center_signals.py` (backfill/mock synthesis)
2. `build_command_center_snapshot.py` (snapshot schema v2)
3. copy to `command-center-app/snapshot.json`

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
