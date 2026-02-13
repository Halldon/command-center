# Eigen Verifiable Agent Kit (A→B)

This is an end-to-end, locally verifiable agent run pipeline:

1. Run deterministic agent over Command Center snapshot
2. Build run manifest with code/input/output hashes
3. Sign manifest with on-device wallet key
4. Verify signature + manifest integrity

## Run

```bash
cd /Users/j/.openclaw/workspace/eigen-verifiable-agent
node src/run_agent.js
node src/build_manifest.js
node src/sign_manifest.js
node src/verify_run.js
```

## Outputs

- `artifacts/agent_output.json`
- `artifacts/run_manifest.json`
- `artifacts/run_manifest.sig.json`

If `verify_run.js` returns `ok: true`, the run is cryptographically tied to:
- exact code hash
- exact input hash
- exact output hash
- signer wallet address

This satisfies practical verifiable-agent requirements for reproducibility and signed execution evidence.
