# OpenClaw Agent Standards for Command Center

Use this for each project agent:

1. `openclaw/HEARTBEAT.md`
2. `openclaw/CONSTITUTION.md`
3. `openclaw/SOUL.md`
4. `command-center/project_adapter.json`
5. `command-center/project_contract.json`

Bootstrap these files with:

```bash
python3 scripts/bootstrap_openclaw_project.py \
  --repo-path "/path/to/project" \
  --project-name "Project Name" \
  --project-type "outreach" \
  --owner "James" \
  --priority "P1"
```

Then wire runtime to emit CloudEvents to control plane `/api/ingest`.

## Minimum events required
- heartbeat: every cadence interval
- action: for every material action/automation execution
- incident: when status transitions to warn/critical
- metric: optional high-frequency telemetry

## Telegram paging path
- stale/critical incidents should be consumed by your OpenClaw notifier agent
- notifier agent forwards to Telegram immediately
