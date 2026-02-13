# Operator Quickstart

## 1) Refresh data pipeline

```bash
bash /Users/j/.openclaw/workspace/command-center-app/scripts_sync_snapshot.sh
```

## 2) Run app locally

```bash
cd /Users/j/.openclaw/workspace/command-center-app
python3 -m http.server 4173
```

Open: `http://localhost:4173`

## 3) Daily operating loop (recommended)

1. **Attention Queue**: Execute top 1–2 ranked items first.
2. **Daily Brief**: Scan highlights + deltas in under 60 seconds.
3. **Decision Console**: Queue dry-run controls, verify audit trail.
4. **Reliability Radar**: Watch lock contention + cron drift trend.
5. **Revenue Layer**: Check confidence and leakage before scaling sends.
6. **Focus Mode**: Toggle critical-only during quiet hours/high alert load.
7. **Scenario Simulator**: Compare policy options before major changes.

## 4) One-click actions

- **Copy recommended action**: Copies command from Attention Queue row.
- **Queue dry-run**: Adds an operator-local audit entry for execution tracking.
- **Copy rollback**: Copies rollback command/runbook step.

## 5) Preference capture

Use **Operator Memory** section:
- add `key/value`
- click **Save Preference**
- preferences persist in browser localStorage and bias prioritization.
