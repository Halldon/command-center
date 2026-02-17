# Verification Runbook

## A) Control plane health

```bash
curl -s http://localhost:4190/health
```

Expect:
- `ok: true`
- valid timestamp

## B) Adapter sync sanity

```bash
cd /Users/jameshalldon/Documents/Builds/Command\ Center/control-plane
npm run sync:adapters
```

Expect:
- `[sync:adapters] synced N project adapters` (N >= configured project count)

## C) Ingest smoke

```bash
curl -s -X POST http://localhost:4190/api/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "specversion":"1.0",
    "id":"smoke-verify-1",
    "source":"openclaw://smoke/verify",
    "type":"commandcenter.heartbeat",
    "subject":"outreach-pipeline",
    "projectid":"outreach-pipeline",
    "time":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "data":{
      "projectId":"outreach-pipeline",
      "status":"ok",
      "metrics":{"queueDepth":1,"healthRows":1,"failingChecks":0}
    }
  }'
```

Expect:
- `accepted >= 1`
- `rejected = 0`

## D) State + stream verification

```bash
curl -s http://localhost:4190/api/state | head -n 60
curl -N http://localhost:4190/api/stream
```

Expect:
- `realtime.projects` populated
- SSE emits `snapshot` or `heartbeat` without reconnect storms

## E) UI verification

```bash
cd /Users/jameshalldon/Documents/Builds/Command\ Center
python3 -m http.server 4173
```

Open `http://localhost:4173` and confirm:
1. Footer points to `/api/state` and `/api/stream`.
2. Reviews/Solve/Prevent cards switch by mode and map to correct project links.
3. Stream pill updates without full-page flicker.
