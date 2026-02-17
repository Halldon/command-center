# Codex + Claude + OpenClaw Orchestration

## Objective
Run all projects through one realtime control plane with strict freshness SLOs, standardized adapter contracts, and dynamic per-project modules in Command Center.

## System of record
1. OpenClaw emits CloudEvents to control plane `/api/ingest`.
2. Control plane (Fly + Postgres) materializes canonical state.
3. Command Center UI reads `/api/state` and `/api/stream` (SSE).
4. Snapshot/GitHub Actions is backup only.

## Agent role boundaries

### OpenClaw (execution plane)
- Owns project runtime and emits heartbeat/action/incident/metric events.
- Maintains `openclaw/HEARTBEAT.md`, `openclaw/CONSTITUTION.md`, `openclaw/SOUL.md`.
- Maintains `command-center/project_contract.json` with dynamic cards/modules.
- Pages Telegram through notifier agent for stale/critical incidents.

### Codex (integration + enforcement plane)
- Owns control-plane schema, adapter enforcement, fail-closed gates.
- Owns command-center UI contract rendering and action guardrails.
- Owns bootstrap tooling and standardization skill/templates.

### Claude (planning + policy plane)
- Produces project strategy, risk analysis, and operation plans.
- Proposes project-specific modules and decision frameworks.
- Does not bypass ingest contract or mutate canonical runtime state directly.

## Non-negotiable contract for every new project
1. Add adapter row (`project_id`, cadence, required metrics, severity map, runbooks).
2. Emit CloudEvents with idempotency keys.
3. Heartbeat cadence:
   - default: 600s
   - urgent/P0: 60s
4. Stale after 2 missed intervals.
5. Provide project contract cards:
   - `reviews`: already executed by OpenClaw and awaiting promotion decision
   - `solve`: immediate remediation path
   - `prevent`: proactive hardening path
6. Provide dynamic modules with evidence links and mapped actions.

## Promotion model for Reviews mode
- Reviews mode shows OpenClaw-completed changes in a dev/staging level.
- Operator can:
  1. open evidence link
  2. verify output
  3. approve promotion to next branch in that project’s branch flow
- Branch flow is per-project (`dev -> main`, or `main` only).

## Exact prompt to give OpenClaw for any project

```text
You are the OpenClaw project agent integrating with Command Center.

Implement all required integration artifacts and runtime wiring for this project so Command Center receives realtime, non-stale insights.

Hard requirements:
1) Emit CloudEvents to /api/ingest for heartbeat, action, incident, metric.
2) Heartbeat cadence: default 600s; urgent 60s; stale after 2 missed intervals.
3) Include idempotencyKey on every write event.
4) Maintain:
   - openclaw/HEARTBEAT.md
   - openclaw/CONSTITUTION.md
   - openclaw/SOUL.md
   - command-center/project_adapter.json
   - command-center/project_contract.json
5) project_contract.json must update continuously from real telemetry (no mocks).
6) Provide cards for reviews/solve/prevent:
   - Reviews = already executed by OpenClaw in lower env, awaiting operator promotion.
   - Solve = concrete fix path.
   - Prevent = proactive guardrail to prevent recurrence.
7) Provide at least 4 dynamic modules:
   - Health pulse
   - Throughput/quality
   - Risk/guardrails
   - Operator actions
8) Fail closed when telemetry is stale or malformed.

Output format:
A) Files created/updated
B) Adapter patch for operator.config.json
C) Commands to run
D) Verification evidence (generatedAt, freshness age, sample cards/modules)
E) Residual risks + next hardening step
```

## Operational checks
- `/api/state` must never silently serve stale data when block gate is enabled.
- stale/critical incidents must reach Telegram via notifier.
- adapter sync must run after operator config updates.
