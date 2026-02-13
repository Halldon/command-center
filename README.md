# Clio Command Center (Vercel)

Static deployment of the Command Center UI.

## Local sync before deploy

```bash
python3 /Users/j/.openclaw/workspace/ops/scripts/build_command_center_snapshot.py
cp /Users/j/.openclaw/workspace/ops/output/command_center/snapshot.json ./snapshot.json
```

## Deploy

```bash
vercel --prod
```
