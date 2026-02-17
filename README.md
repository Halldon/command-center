# Command Center

Realtime command center with:
- central ingest/state/stream architecture
- strict freshness SLOs (stale after missed heartbeats)
- fail-closed ingest + publish gates
- project-specific dynamic cards/modules

## Primary architecture

1. **OpenClaw project agents** emit CloudEvents to ingest API.
2. **Control plane (Fly + Postgres)** validates adapters, enforces idempotency, writes durable state.
3. **UI** reads from centralized `/api/state` and `/api/stream` (SSE).
4. **GitHub Actions snapshot sync** is backup reporting/publishing, not primary realtime transport.

Reference:
- `/Users/jameshalldon/Documents/Builds/Command Center/docs/control-plane-architecture.md`

## Repo layout

- UI app + transitional local APIs:
  - `/Users/jameshalldon/Documents/Builds/Command Center/index.html`
  - `/Users/jameshalldon/Documents/Builds/Command Center/api/state.js`
  - `/Users/jameshalldon/Documents/Builds/Command Center/api/stream.js`
  - `/Users/jameshalldon/Documents/Builds/Command Center/api/ingest.js`
- Fly/Postgres control plane service:
  - `/Users/jameshalldon/Documents/Builds/Command Center/control-plane`
- OpenClaw standards/templates:
  - `/Users/jameshalldon/Documents/Builds/Command Center/templates/openclaw`
  - `/Users/jameshalldon/Documents/Builds/Command Center/scripts/bootstrap_openclaw_project.py`
  - `/Users/jameshalldon/Documents/Builds/Command Center/skills/command-center-project-standard/SKILL.md`

## Operator config

All project + realtime contracts live in:
- `/Users/jameshalldon/Documents/Builds/Command Center/operator.config.json`

Important sections:
- `realtime`: API base/paths, freshness SLO, incident routing
- `projects[].adapter`: heartbeat cadence, required metrics, severity map, runbooks
- `projects[].actions`: execution allowlist for `/api/execute`

## Control plane (Fly + Postgres)

### Local bootstrap

```bash
cd /Users/jameshalldon/Documents/Builds/Command\ Center/control-plane
npm install
npm run migrate
npm run sync:adapters
npm run dev
```

### Fly deploy

```bash
cd /Users/jameshalldon/Documents/Builds/Command\ Center/control-plane
fly launch --no-deploy
fly secrets set DATABASE_URL=postgres://...
fly deploy
```

### CI automation

Added workflows:
- `/Users/jameshalldon/Documents/Builds/Command Center/.github/workflows/control-plane-deploy.yml`
- `/Users/jameshalldon/Documents/Builds/Command Center/.github/workflows/control-plane-sync-adapters.yml`

Required GitHub secrets:
- `FLY_API_TOKEN`
- `CONTROL_PLANE_MPG_CLUSTER_ID`

### Endpoints

- `POST /api/ingest`: CloudEvents ingest (idempotency + adapter enforcement)
- `GET /api/state`: centralized materialized state
- `GET /api/stream`: SSE updates
- `GET /health`

## UI runtime

The UI is stream-first and reads realtime state from configured endpoints in `operator.config.json > realtime`.

Set this after control-plane deploy:

```json
{
  "realtime": {
    "apiBaseUrl": "https://<your-control-plane>.fly.dev",
    "statePath": "/api/state",
    "streamPath": "/api/stream",
    "ingestPath": "/api/ingest"
  }
}
```

Local UI smoke:

```bash
cd /Users/jameshalldon/Documents/Builds/Command\ Center
python3 -m http.server 4173
```

## OpenClaw standardization

Generate required files for any project:

```bash
python3 /Users/jameshalldon/Documents/Builds/Command\ Center/scripts/bootstrap_openclaw_project.py \
  --repo-path "/path/to/project" \
  --project-name "My Project" \
  --project-type "outreach" \
  --owner "James" \
  --priority "P1"
```

Generated:
- `openclaw/HEARTBEAT.md`
- `openclaw/CONSTITUTION.md`
- `openclaw/SOUL.md`
- `command-center/project_adapter.json`
- `command-center/project_contract.json`

Install Codex skill for repeatable use:

```bash
bash /Users/jameshalldon/Documents/Builds/Command\ Center/scripts/install_codex_command_center_skill.sh
```

## Backup snapshot pipeline (secondary)

Snapshot sync script remains available:

```bash
bash /Users/jameshalldon/Documents/Builds/Command\ Center/scripts_sync_snapshot.sh
```

This is backup/reporting only. Realtime authority is central ingest/state APIs.

## Existing execution endpoint

`/api/execute` remains action allowlisted and token-gated for project commands.

Set token:
- `COMMAND_CENTER_EXEC_TOKEN`

## Key docs

- `/Users/jameshalldon/Documents/Builds/Command Center/docs/control-plane-architecture.md`
- `/Users/jameshalldon/Documents/Builds/Command Center/docs/codex-claude-openclaw-orchestration.md`
- `/Users/jameshalldon/Documents/Builds/Command Center/docs/project-contract.md`
- `/Users/jameshalldon/Documents/Builds/Command Center/docs/openclaw-agent-standards.md`
- `/Users/jameshalldon/Documents/Builds/Command Center/docs/openclaw-command-center-bootstrap-prompt.md`
