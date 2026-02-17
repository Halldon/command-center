#!/usr/bin/env python3
"""Emit Command Center heartbeat CloudEvents for configured projects.

This bridge keeps realtime state fresh while native per-project emitters
are being finalized. It is safe to run on an interval (launchd/cron).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "operator.config.json"
DEFAULT_ENV_LOCAL = ROOT / ".env.local"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slugify(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower())
    return text.strip("-")


def load_env_local(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip()


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def http_json(url: str, method: str = "GET", body: Any = None, headers: dict[str, str] | None = None, timeout: int = 20) -> Any:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url=url, data=payload, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


@dataclass
class CmdResult:
    ok: bool
    exit_code: int
    duration_ms: int
    stderr_tail: str


def run_command(command: str, timeout_seconds: int) -> CmdResult:
    started = time.time()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        ms = int((time.time() - started) * 1000)
        err_tail = (proc.stderr or "").strip()[-500:]
        return CmdResult(ok=proc.returncode == 0, exit_code=proc.returncode, duration_ms=ms, stderr_tail=err_tail)
    except subprocess.TimeoutExpired:
        ms = int((time.time() - started) * 1000)
        return CmdResult(ok=False, exit_code=124, duration_ms=ms, stderr_tail="health_check timeout")


def extract_leading_cd_path(command: str) -> str:
    pattern = r'^\s*cd\s+("([^"]+)"|\'([^\']+)\'|([^&;]+?))\s*&&'
    match = re.match(pattern, str(command or ""))
    if not match:
        return ""
    raw = match.group(2) or match.group(3) or match.group(4) or ""
    return str(raw).strip()


def default_metric_value(name: str) -> float:
    metric = str(name or "").strip()
    key = metric.lower()
    if "healthrows" in key:
        return 1
    if "failingchecks" in key:
        return 0
    if "queuedepth" in key:
        return 0
    if "riskscore" in key:
        return 0
    if "looplatency" in key:
        return 0
    if "openpositions" in key:
        return 0
    if "count" in key:
        return 0
    return 0


def resolve_project_id(project: dict[str, Any]) -> str:
    return slugify(project.get("id") or project.get("projectId") or project.get("slug") or project.get("name") or "")


def resolve_endpoints(config: dict[str, Any]) -> tuple[str, str]:
    realtime = config.get("realtime") if isinstance(config.get("realtime"), dict) else {}
    base = str(realtime.get("apiBaseUrl") or "").rstrip("/")
    ingest_path = str(realtime.get("ingestPath") or "/api/ingest")
    if not ingest_path.startswith("/"):
        ingest_path = f"/{ingest_path}"
    ingest_url = f"{base}{ingest_path}" if base else f"http://localhost:4190{ingest_path}"
    state_path = str(realtime.get("statePath") or "/api/state")
    if not state_path.startswith("/"):
        state_path = f"/{state_path}"
    state_url = f"{base}{state_path}" if base else f"http://localhost:4190{state_path}"
    return ingest_url, state_url


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit project heartbeats to command center ingest API.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--env-local", default=str(DEFAULT_ENV_LOCAL))
    parser.add_argument("--timeout-seconds", type=int, default=30)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    load_env_local(Path(args.env_local))
    token = str(os.environ.get("COMMAND_CENTER_INGEST_TOKEN") or "").strip()
    if not token:
        print("[heartbeat] missing COMMAND_CENTER_INGEST_TOKEN", file=sys.stderr)
        return 1

    cfg_path = Path(args.config).expanduser().resolve()
    cfg = read_json(cfg_path, {})
    projects = cfg.get("projects") if isinstance(cfg.get("projects"), list) else []
    if not projects:
        print("[heartbeat] no projects found in operator config", file=sys.stderr)
        return 1

    ingest_url, state_url = resolve_endpoints(cfg)
    headers = {"Authorization": f"Bearer {token}"}

    # Best effort baseline metrics from current state to avoid metric churn.
    baseline_metrics: dict[str, dict[str, Any]] = {}
    try:
        state = http_json(state_url, headers=headers, timeout=15)
        realtime = state.get("realtime") if isinstance(state.get("realtime"), dict) else {}
        rows = realtime.get("projects") if isinstance(realtime.get("projects"), dict) else {}
        for project_id, row in rows.items():
            if isinstance(row, dict) and isinstance(row.get("metrics"), dict):
                baseline_metrics[str(project_id)] = dict(row.get("metrics"))
    except Exception:
        pass

    events = []
    sent_at = now_iso()
    for project in projects:
        if not isinstance(project, dict):
            continue
        project_id = resolve_project_id(project)
        if not project_id:
            continue
        project_name = str(project.get("name") or project_id)
        adapter = project.get("adapter") if isinstance(project.get("adapter"), dict) else {}
        required_metrics = adapter.get("requiredMetrics") if isinstance(adapter.get("requiredMetrics"), list) else []
        actions = project.get("actions") if isinstance(project.get("actions"), dict) else {}
        health = actions.get("health_check") if isinstance(actions.get("health_check"), dict) else {}
        health_cmd = str(health.get("cmd") or "").strip()
        repo_path = str(project.get("repoPath") or "").strip()
        repo_exists = bool(repo_path and Path(repo_path).expanduser().exists())

        cmd_result = CmdResult(ok=True, exit_code=0, duration_ms=0, stderr_tail="")
        health_mode = "executed"
        if health_cmd:
            cd_path = extract_leading_cd_path(health_cmd)
            if cd_path and not Path(cd_path).expanduser().exists():
                health_mode = "skipped_missing_cd_path"
                cmd_result = CmdResult(
                    ok=False,
                    exit_code=2,
                    duration_ms=0,
                    stderr_tail=f"skipped: cd path missing ({cd_path})",
                )
            else:
                cmd_result = run_command(health_cmd, timeout_seconds=max(5, int(args.timeout_seconds)))
        else:
            health_mode = "skipped_no_health_command"
            cmd_result = CmdResult(ok=False, exit_code=2, duration_ms=0, stderr_tail="skipped: no health_check command configured")

        metrics = dict(baseline_metrics.get(project_id, {}))
        for key in required_metrics:
            k = str(key or "").strip()
            if not k:
                continue
            if k not in metrics:
                metrics[k] = default_metric_value(k)

        metrics["healthCheckOk"] = 1 if cmd_result.ok else 0
        metrics["healthCheckExitCode"] = cmd_result.exit_code
        metrics["healthCheckDurationMs"] = cmd_result.duration_ms
        metrics["healthCheckSkipped"] = 1 if health_mode.startswith("skipped") else 0
        metrics["repoPathExists"] = 1 if repo_exists else 0

        if not repo_exists or health_mode == "skipped_missing_cd_path":
            status = "critical"
            severity = "critical"
        elif health_mode.startswith("skipped"):
            status = "warn"
            severity = "warn"
        elif cmd_result.ok:
            status = "ok"
            severity = "ok"
        else:
            status = "critical"
            severity = "critical"

        events.append(
            {
                "specversion": "1.0",
                "id": f"hb-{project_id}-{int(time.time())}",
                "source": f"command-center://heartbeat-bridge/{project_id}",
                "type": "commandcenter.heartbeat",
                "subject": project_id,
                "time": sent_at,
                "projectid": project_id,
                "service.name": "command-center-heartbeat-bridge",
                "deployment.environment": "production",
                "data": {
                    "projectId": project_id,
                    "projectName": project_name,
                    "status": status,
                    "severity": severity,
                    "agentId": "command-center-heartbeat-bridge",
                    "metrics": metrics,
                    "healthCheck": {
                        "ok": cmd_result.ok,
                        "exitCode": cmd_result.exit_code,
                        "mode": health_mode,
                        "durationMs": cmd_result.duration_ms,
                        "stderrTail": cmd_result.stderr_tail,
                    },
                    "repoPath": repo_path,
                    "repoPathExists": repo_exists,
                },
            }
        )

    payload = {"events": events}
    if args.dry_run:
        print(json.dumps({"dryRun": True, "ingestUrl": ingest_url, "events": len(events)}, indent=2))
        return 0

    try:
        result = http_json(ingest_url, method="POST", body=payload, headers=headers, timeout=30)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        print(f"[heartbeat] ingest HTTP {err.code}: {body}", file=sys.stderr)
        return 1
    except Exception as err:
        print(f"[heartbeat] ingest failed: {err}", file=sys.stderr)
        return 1

    summary = result.get("summary") if isinstance(result, dict) else {}
    print(json.dumps({"ok": True, "ingestUrl": ingest_url, "summary": summary}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
