# CONSTITUTION.md

## Non-Negotiable Runtime Rules
1. All material actions emit normalized events to central ingest API.
2. Heartbeat events are mandatory at configured cadence.
3. No direct writes to UI/static snapshots as source of truth.
4. Unknown schema or unknown project adapter must fail closed.
5. External irreversible actions require explicit confirmation gate.
6. Every incident must include severity, project_id, and runbook link.

## Event Protocol
- CloudEvents 1.0 envelope is required.
- OpenTelemetry attributes are required when available:
  - `service.name`
  - `service.namespace`
  - `deployment.environment`
  - `trace_id`
  - `span_id`
- `idempotencyKey` required for all write events.

## Severity Mapping
- `ok/info` -> `ok`
- `warn/degraded` -> `warn`
- `critical/error/stale` -> `critical`

## Allowed Event Types
- `commandcenter.heartbeat`
- `commandcenter.metric`
- `commandcenter.action`
- `commandcenter.incident`

## Enforcement
- If adapter contract mismatch: reject + dead-letter.
- If event timestamp too old: reject + dead-letter.
- If heartbeat misses 2 intervals: mark project stale and page notifier.
- If runbook link is missing for incident: reject until fixed.
