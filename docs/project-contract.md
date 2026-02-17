# Project Contract (Realtime + Dynamic Modules)

Every project should emit a local JSON artifact so Command Center can stay realtime without brittle, hardcoded mapping.

Default lookup order per project:
1. `<repoPath>/command-center/project_contract.json`
2. `<repoPath>/runtime/command_center_contract.json`
3. `<repoPath>/runtime/project_contract.json`

You can override the path with:
- `operator.config.json -> projects[].commandCenter.contractPath`

## Required fields

```json
{
  "generatedAt": "2026-02-17T18:40:00Z",
  "maxStalenessSeconds": 900,
  "status": "monitoring",
  "summary": "One-line project state summary",
  "cards": {},
  "modules": []
}
```

- `generatedAt`: update every build cycle/heartbeat.
- `maxStalenessSeconds`: hard SLO for this project’s freshness.
- `status`: `ok|warn|critical|monitoring|stale`.
- `summary`: concise operator-facing summary.
- `cards`: optional mode-specific Problem/Solution overrides.
- `modules`: optional dynamic cards rendered directly in project section.

## Cards schema

```json
{
  "cards": {
    "reviews": {
      "problem": {
        "title": "What happened",
        "body": "What OpenClaw changed and why review is required.",
        "tags": ["review", "branch-flow"],
        "impact": "Deployment confidence",
        "evidenceHref": "https://..."
      },
      "solution": {
        "title": "What to verify",
        "body": "Exact checks to run before promotion.",
        "tags": ["verify", "preflight"],
        "eta": "4 minutes to verify",
        "command": "python3 scripts/verify_launch_guards.py",
        "verifyHref": "https://...",
        "verifyLabel": "Check solution"
      }
    }
  }
}
```

Supported modes: `reviews`, `solve`, `prevent`.

## Modules schema

```json
{
  "replaceDefaultModules": false,
  "modules": [
    {
      "id": "health-pulse",
      "title": "Health Pulse",
      "description": "Fast telemetry summary.",
      "kind": "stats",
      "modes": ["reviews", "solve", "prevent"],
      "stats": [
        { "label": "Queue", "value": "61" },
        { "label": "Failures", "value": "0" }
      ],
      "items": ["Last run passed verify guard."],
      "tags": ["pipeline", "realtime"],
      "footer": ["Owner: James"],
      "actions": [
        { "kind": "queue", "label": "Queue verify", "actionKey": "verify" },
        { "kind": "go-live", "label": "Run solve action", "actionKey": "go_live" },
        { "kind": "copy", "label": "Copy rollback", "actionKey": "rollback" },
        { "kind": "link", "label": "Evidence", "href": "https://..." }
      ]
    }
  ]
}
```

If `replaceDefaultModules` is `true`, Command Center shows only these dynamic modules for that project.

## Fail-closed behavior

`scripts_sync_snapshot.sh` now injects `projectContracts` into `snapshot.json` and validates:
- project contracts exist for configured projects
- each contract freshness is within threshold
- each project has dynamic module content
- optional strict mode to require physical project contract files

Related env vars:
- `COMMAND_CENTER_MAX_PROJECT_CONTRACT_AGE_MINUTES` (default `120`)
- `COMMAND_CENTER_PROJECT_CONTRACTS_REQUIRED` (default `true`)
- `COMMAND_CENTER_REQUIRE_PROJECT_MODULES` (default `true`)
- `COMMAND_CENTER_REQUIRE_PROJECT_CONTRACT_FILES` (default `false`)

