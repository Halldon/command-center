# Command Center Control Plane

Postgres-backed central ingest/state/stream service for Command Center.

## Endpoints

- `POST /api/ingest`  
  CloudEvents ingest with project adapter validation, idempotency, stale-event rejection, and dead-letter writes.
- `GET /api/state`  
  Materialized state view for UI consumption.
- `GET /api/stream`  
  SSE stream for live state updates.
- `GET /health`

## Required env vars

- `DATABASE_URL`

Optional:

- `COMMAND_CENTER_INGEST_TOKEN` or `COMMAND_CENTER_INGEST_TOKEN_SHA256`
- `COMMAND_CENTER_ADMIN_TOKEN`
- `COMMAND_CENTER_BASELINE_SNAPSHOT_PATH`
- `COMMAND_CENTER_OPERATOR_CONFIG_PATH`
- `COMMAND_CENTER_BLOCK_STALE_API`
- `COMMAND_CENTER_STALE_AFTER_MISSED_HEARTBEATS`
- `COMMAND_CENTER_HEARTBEAT_EVAL_INTERVAL_MS`

## Local run

```bash
cd control-plane
npm install
npm run migrate
npm run sync:adapters
npm run dev
```

## Fly deploy

```bash
cd control-plane
fly launch --no-deploy
fly secrets set DATABASE_URL=postgres://...
fly deploy
```

The Fly config runs an idempotent schema migration on each deploy via release command.

## Adapter sync after config changes

```bash
cd control-plane
npm run sync:adapters
```

Recommended automation:
- GitHub workflow `control-plane-sync-adapters.yml` on `operator.config.json` changes.
- Required GitHub secrets:
  - `FLY_API_TOKEN`
  - `CONTROL_PLANE_MPG_CLUSTER_ID`

## Create a project-scoped ingest key

```bash
cd control-plane
npm run gen:key -- --project-id outreach-pipeline --key-id outreach-agent-1
```
