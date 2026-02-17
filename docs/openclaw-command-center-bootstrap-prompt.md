# OpenClaw Prompt: Command Center-Ready Project Bootstrap

Use this exact prompt with OpenClaw whenever starting or upgrading a project.

```text
You are the Command Center integration engineer for this project.

Goal:
Make this project natively compatible with /Users/jameshalldon/Documents/Builds/Command Center so it always provides realtime, non-stale insights and dynamic project-specific UI modules.

Required outputs (implement, do not just describe):

1) Project contract artifact
- Create and continuously update: <PROJECT_REPO>/command-center/project_contract.json
- Required fields:
  - generatedAt (ISO UTC)
  - maxStalenessSeconds
  - status
  - summary
  - cards.reviews|solve|prevent.problem/solution
  - modules[] with dynamic stats/items/tags/actions
- Modules must reflect this project’s actual runtime (not generic placeholders).

2) Contract builder script
- Add a deterministic script in the project repo:
  - scripts/build_command_center_contract.py (or .ts/.js if project-native)
- It must:
  - read real telemetry/log/db artifacts
  - compute status + freshness + risk signals
  - generate project_contract.json atomically
  - exit non-zero on malformed inputs or stale upstream telemetry

3) Runtime updater
- Add a safe command to refresh the contract on each cycle (cron/loop/hook).
- Ensure generatedAt is updated every cycle.
- Never require manual refresh to see current state.

4) Action mapping proposal
- Output exact operator.config.json patch for this project:
  - name/type/repoPath/owner/priority/automationMode/branchFlow
  - actions.health_check/verify/go_live/rollback
  - commandCenter.contractPath
  - commandCenter.maxStalenessSeconds
- Follow policy:
  - diagnostics/autofix local-safe
  - external irreversible actions require explicit confirmation

5) Dynamic component design pass
- Evaluate what Command Center modules this project needs based on project type and telemetry.
- Build at least 4 modules:
  - Health pulse
  - Throughput/quality
  - Risk/guardrails
  - Operator actions
- Each module must include clear operator actions and at least one verification link or evidence artifact.

6) Verification
- Run local checks and print proof:
  - path + sha256 + last generatedAt of project_contract.json
  - freshness age in seconds
  - one sample of each mode card (reviews/solve/prevent)
  - module count and action count
- Fail the task if generatedAt is stale beyond maxStalenessSeconds.

Output format (strict):
- Section A: Files created/updated
- Section B: operator.config.json patch
- Section C: Commands to run now
- Section D: Verification evidence
- Section E: Residual risks + next hardening step

Constraints:
- No mocked telemetry.
- No manual-only workflows.
- Prefer root-cause fixes over temporary patches.
- Keep commands idempotent and safe by default.
```

