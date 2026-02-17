# HEARTBEAT.md

## Agent Identity
- `project_id`: `{{PROJECT_ID}}`
- `agent_id`: `{{AGENT_ID}}`
- `owner`: `{{OWNER}}`
- `environment`: `{{ENVIRONMENT}}`

## Heartbeat SLO
- `heartbeat_interval_seconds`: `{{HEARTBEAT_INTERVAL_SECONDS}}`
- `stale_after_missed_intervals`: `2`
- `max_event_age_seconds`: `{{MAX_EVENT_AGE_SECONDS}}`

## Required Heartbeat Metrics
{{REQUIRED_METRICS_BULLETS}}

## Heartbeat Event Contract
Emit CloudEvents (`specversion=1.0`) to ingest API every interval:

- `type`: `commandcenter.heartbeat`
- `subject`: `{{PROJECT_ID}}`
- `source`: `openclaw://{{PROJECT_ID}}/{{AGENT_ID}}`
- `data.projectId`: `{{PROJECT_ID}}`
- `data.agentId`: `{{AGENT_ID}}`
- `data.status`: `ok|warn|critical`
- `data.metrics`: object with required metrics
- `trace_id` / `span_id` in extensions when available
- `idempotencyKey`: required for each event

## Incident Trigger Rules
- Missed heartbeat >=2 intervals: emit incident + page Telegram via notifier agent.
- Missing required metrics in heartbeat: emit warn incident.
- Recovered heartbeat: emit recovery incident.

## Runbooks
- Reviews: `{{RUNBOOK_REVIEWS}}`
- Solve: `{{RUNBOOK_SOLVE}}`
- Prevent: `{{RUNBOOK_PREVENT}}`
- Rollback: `{{RUNBOOK_ROLLBACK}}`
