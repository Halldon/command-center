# Rollback Instructions

## Fast rollback (UI + snapshot)

```bash
cd /Users/j/.openclaw/workspace/command-center-app
git checkout -- index.html snapshot.json README.md scripts_sync_snapshot.sh docs/
```

Then redeploy:

```bash
vercel --prod
```

## Snapshot pipeline rollback

If new schema generation causes issues:

```bash
# restore prior script versions from your VCS history if available
# then rebuild + sync
python3 /Users/j/.openclaw/workspace/ops/scripts/build_command_center_snapshot.py
cp /Users/j/.openclaw/workspace/ops/output/command_center/snapshot.json /Users/j/.openclaw/workspace/command-center-app/snapshot.json
```

## Safe-operating fallback

If uncertain, keep console actions in dry-run mode only:
- Use Decision Console queue/copy actions without executing.
- Validate snapshot freshness and critical alerts before applying any recovery commands.

## Verification after rollback

- Open app and confirm no JS errors.
- Confirm `snapshot.json` renders KPI row + project cards.
- Confirm deploy URL serves expected (older) view.
