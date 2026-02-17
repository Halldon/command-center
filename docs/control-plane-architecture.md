# Command Center Control Plane Architecture (v1)

## Objective
Move Command Center from static snapshot-first rendering to realtime ingest/state streaming with strict freshness SLOs and fail-closed behavior.

## Runtime topology
1. **Project agents (OpenClaw)** emit CloudEvents.
2. **Control plane (Fly + Postgres)** ingests events, applies adapter contract validation, materializes state, and exposes `/api/state` + `/api/stream`.
3. **UI (Command Center)** reads state from API and listens to SSE stream.
4. **GitHub Actions** publishes snapshot/report artifacts as backup only.

## Contract layers

### 1) Project adapter contract (required)
- `project_id`
- `heartbeat_interval_seconds`
- `max_event_age_seconds`
- `required_metrics[]`
- `severity_map`
- `runbook_links`
- `event_types[]`

### 2) Event contract (required)
- CloudEvents 1.0 envelope
- OTel attributes when available (`service.name`, `trace_id`, `span_id`, `deployment.environment`)
- `project_id`
- idempotency key for all write events

### 3) Heartbeat SLO
- Stale after **2 missed heartbeats**
- P0 defaults to 60s cadence
- P1/default defaults to 600s cadence
- Automatic incident creation on stale transition and recovery transition

## Fail-closed gates
### Ingest gate
Reject and dead-letter if:
- unknown project adapter
- unsupported event type
- stale event timestamp
- invalid CloudEvent envelope

### Publish gate
Optional hard block:
- `COMMAND_CENTER_BLOCK_STALE_API=true`
- `/api/state` returns 503 while stale projects exist

## Incidenting
- Incidents are stored in `incidents` table.
- `incidentFeed` in state is materialized from incident rows.
- Telegram paging should be handled by an OpenClaw notifier agent subscribed to stale/critical incidents.

## Data model summary
- `project_adapters`: enforcement contract
- `ingest_keys`: scoped auth
- `events`: immutable event log
- `dead_letter_events`: quarantined rejects
- `project_state`: current materialized state
- `incidents`: active/history incidents

## Multi-agent roles
- **OpenClaw**: execution + telemetry/heartbeat emitter
- **Codex**: schema/contracts/bootstrap enforcement, CI hardening
- **Claude**: planning/reasoning layer

Only the control plane is allowed to mutate command-center runtime state.
