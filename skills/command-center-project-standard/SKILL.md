---
name: command-center-project-standard
description: Bootstrap and enforce Command Center project standards (adapter contract, OpenClaw HEARTBEAT/CONSTITUTION/SOUL files, CloudEvents ingest compatibility, and freshness gates) for any new or existing project.
---

# Command Center Project Standard

Use this skill whenever a project must be integrated into Command Center realtime ingest/state architecture.

## Required outcomes
1. Ensure project has:
- `openclaw/HEARTBEAT.md`
- `openclaw/CONSTITUTION.md`
- `openclaw/SOUL.md`
- `command-center/project_adapter.json`
- `command-center/project_contract.json`
2. Ensure operator config has matching project adapter values.
3. Ensure project emits CloudEvents heartbeats/actions/metrics/incidents.
4. Ensure freshness SLO is explicit and stale-after-2-intervals behavior is documented.

## Bootstrap command

Run:

```bash
python3 /Users/jameshalldon/Documents/Builds/Command\ Center/scripts/bootstrap_openclaw_project.py \
  --repo-path "<PROJECT_REPO>" \
  --project-name "<PROJECT_NAME>" \
  --project-type "<PROJECT_TYPE>" \
  --owner "<OWNER>" \
  --priority "P1"
```

Use `--required-metric` flags to override defaults and `--overwrite` for regeneration.

## Adapter + ingest rules
- Event schema: CloudEvents 1.0
- Include OpenTelemetry attributes when available
- Include project id on every event
- Include idempotency key on every write event
- Reject unknown adapter/type/timestamp-drift at ingest (fail closed)

## Verification checklist
1. `HEARTBEAT.md` cadence matches adapter heartbeat interval.
2. Required metrics in adapter and heartbeat file match.
3. Runbook links exist for reviews/solve/prevent/rollback.
4. Project contract `generatedAt` updates continuously in runtime.
5. Ingest test event appears in `/api/state` realtime project row.
