# Rollback Instructions

## 1) Soft rollback (no code revert)

If control plane is unhealthy, temporarily run UI in snapshot fallback mode:

1. In `operator.config.json`, set:
   - `realtime.apiBaseUrl` to `""` (or a healthy endpoint)
2. Ensure `realtime.fallbackSnapshotPath` points to a valid local snapshot.
3. Run:

```bash
bash /Users/jameshalldon/Documents/Builds/Command\ Center/scripts_sync_snapshot.sh
```

This keeps operators unblocked while preserving realtime architecture for recovery.

## 2) Control-plane rollback

If a new control-plane deploy is bad:

1. Roll back Fly app to previous release.
2. Re-run adapter sync:

```bash
cd /Users/jameshalldon/Documents/Builds/Command\ Center/control-plane
npm run sync:adapters
```

3. Verify:

```bash
curl -s http://localhost:4190/health
curl -s http://localhost:4190/api/state | head -n 40
```

## 3) Snapshot pipeline fallback (backup only)

If ingest remains unavailable:

```bash
bash /Users/jameshalldon/Documents/Builds/Command\ Center/scripts_sync_snapshot.sh
```

Use this as temporary backup transport only.

## 4) Safety posture during rollback

- Keep irreversible actions gated by explicit confirmation.
- Prefer diagnostics/verify/rollback actions while incident is open.
- Keep incident feed visible until stale/critical items clear.
