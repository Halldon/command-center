# Operator Quickstart

## 1) Start control plane (realtime source)

```bash
cd /Users/jameshalldon/Documents/Builds/Command\ Center/control-plane
npm install
npm run migrate
npm run sync:adapters
npm run dev
```

Required env:
- `DATABASE_URL`

## 2) Run UI locally

```bash
cd /Users/jameshalldon/Documents/Builds/Command\ Center
python3 -m http.server 4173
```

Open: `http://localhost:4173`

## 3) Verify live state + stream

```bash
curl -s http://localhost:4190/api/state | head -n 40
curl -N http://localhost:4190/api/stream
```

You should see a `snapshot` or `heartbeat` SSE event and a valid `realtime` block in `/api/state`.

## 4) Backup snapshot pipeline (secondary)

Use only as backup/reporting:

```bash
bash /Users/jameshalldon/Documents/Builds/Command\ Center/scripts_sync_snapshot.sh
```

## 5) Daily operator loop

1. Reviews mode: inspect OpenClaw-proposed changes and evidence.
2. Solve mode: execute highest impact mapped action with verification.
3. Prevent mode: queue/install guardrails and cadence checks.
4. Incident feed: clear stale/critical items first.
