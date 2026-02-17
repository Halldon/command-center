#!/usr/bin/env python3
"""Generate OpenClaw + Command Center contract files for a project."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Iterable, List


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "templates" / "openclaw"


def slugify(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", value.strip().lower())
    return text.strip("-")


def default_metrics(project_type: str) -> List[str]:
    t = project_type.lower().strip()
    if t == "outreach":
        return ["queueDepth", "healthRows", "failingChecks"]
    if t in {"polymarket", "trading"}:
        return ["loopLatencyMs", "openPositions", "riskScore"]
    if t == "ops":
        return ["queueBacklog", "incidentCount"]
    return ["healthScore"]


def render_template(path: Path, replacements: dict[str, str]) -> str:
    text = path.read_text(encoding="utf-8")
    for key, value in replacements.items():
        text = text.replace(f"{{{{{key}}}}}", value)
    return text


def metrics_bullets(metrics: Iterable[str]) -> str:
    rows = [f"- `{m}`" for m in metrics]
    return "\n".join(rows)


def metrics_json_lines(metrics: Iterable[str]) -> str:
    rows = [f'    "{m}"' for m in metrics]
    return ",\n".join(rows)


def write(path: Path, text: str, overwrite: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        return
    path.write_text(text, encoding="utf-8")


def build_project_contract_stub(
    project_id: str,
    heartbeat_interval_seconds: int,
    required_metrics: list[str],
    runbook_reviews: str,
    runbook_solve: str,
    runbook_prevent: str,
) -> dict:
    return {
        "generatedAt": "1970-01-01T00:00:00Z",
        "maxStalenessSeconds": heartbeat_interval_seconds * 3,
        "status": "monitoring",
        "summary": "Bootstrap contract generated. Wire real metrics next.",
        "cards": {
            "reviews": {
                "problem": {
                    "title": "Review latest OpenClaw run output",
                    "body": "Inspect generated changes and validation output before promotion.",
                    "tags": ["reviews", project_id],
                    "impact": "Release safety",
                    "evidenceHref": runbook_reviews,
                },
                "solution": {
                    "title": "Run verification suite and approve",
                    "body": "Run project verification checks and promote only after pass.",
                    "tags": ["verify", "approval"],
                    "eta": "5 minutes to verify",
                    "verifyHref": runbook_reviews,
                    "verifyLabel": "Review checks",
                },
            },
            "solve": {
                "problem": {
                    "title": "Highest-impact issue to solve now",
                    "body": "Use current telemetry to execute one concrete solve action.",
                    "tags": ["solve", project_id],
                    "impact": "Execution quality",
                    "evidenceHref": runbook_solve,
                },
                "solution": {
                    "title": "Execute solve action with rollback ready",
                    "body": "Run solve action, confirm outcome, and keep rollback command ready.",
                    "tags": ["execute", "rollback-ready"],
                    "eta": "3 minutes to execute",
                    "verifyHref": runbook_solve,
                    "verifyLabel": "Solve runbook",
                },
            },
            "prevent": {
                "problem": {
                    "title": "Future drift risk",
                    "body": "Identify automation or guardrail to prevent repeated incidents.",
                    "tags": ["prevent", "guardrail"],
                    "impact": "Reliability posture",
                    "evidenceHref": runbook_prevent,
                },
                "solution": {
                    "title": "Install preventive guardrail",
                    "body": "Add a recurring guardrail that detects and remediates drift early.",
                    "tags": ["automation", "hardening"],
                    "eta": "4 minutes to queue",
                    "verifyHref": runbook_prevent,
                    "verifyLabel": "Prevent runbook",
                },
            },
        },
        "replaceDefaultModules": False,
        "modules": [
            {
                "id": "health-pulse",
                "title": "Health Pulse",
                "description": "Realtime heartbeat and freshness view.",
                "kind": "stats",
                "modes": ["reviews", "solve", "prevent"],
                "stats": [
                    {"label": "Heartbeat", "value": "unknown"},
                    {"label": "Status", "value": "monitoring"},
                ],
                "items": [f"Required metrics: {', '.join(required_metrics)}"],
                "tags": [project_id, "bootstrap"],
                "footer": ["Replace placeholder values with live telemetry outputs."],
                "actions": [
                    {"kind": "link", "label": "Project contract docs", "href": "./docs/project-contract.md"}
                ],
            }
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap OpenClaw/Command Center contracts for a project.")
    parser.add_argument("--repo-path", required=True)
    parser.add_argument("--project-name", required=True)
    parser.add_argument("--project-type", default="generic")
    parser.add_argument("--priority", default="P1")
    parser.add_argument("--owner", default="Unknown")
    parser.add_argument("--project-id", default="")
    parser.add_argument("--agent-id", default="openclaw-agent")
    parser.add_argument("--environment", default="prod")
    parser.add_argument("--heartbeat-interval-seconds", type=int, default=600)
    parser.add_argument("--max-event-age-seconds", type=int, default=1800)
    parser.add_argument("--required-metric", action="append", default=[])
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo_path).expanduser().resolve()
    project_name = args.project_name.strip()
    project_id = args.project_id.strip() or slugify(project_name)
    project_type = args.project_type.strip()
    required_metrics = args.required_metric or default_metrics(project_type)

    runbook_reviews = "./docs/operator-quickstart.md"
    runbook_solve = "./docs/verification.md"
    runbook_prevent = "./docs/project-contract.md"
    runbook_rollback = "./docs/rollback.md"

    replacements = {
        "PROJECT_ID": project_id,
        "PROJECT_NAME": project_name,
        "PROJECT_NAME_SLUG": slugify(project_name),
        "PROJECT_TYPE": project_type,
        "PRIORITY": args.priority.strip(),
        "OWNER": args.owner.strip(),
        "AGENT_ID": args.agent_id.strip(),
        "ENVIRONMENT": args.environment.strip(),
        "HEARTBEAT_INTERVAL_SECONDS": str(args.heartbeat_interval_seconds),
        "MAX_EVENT_AGE_SECONDS": str(args.max_event_age_seconds),
        "REQUIRED_METRICS_BULLETS": metrics_bullets(required_metrics),
        "REQUIRED_METRICS_JSON_LINES": metrics_json_lines(required_metrics),
        "RUNBOOK_REVIEWS": runbook_reviews,
        "RUNBOOK_SOLVE": runbook_solve,
        "RUNBOOK_PREVENT": runbook_prevent,
        "RUNBOOK_ROLLBACK": runbook_rollback,
    }

    files = {
        repo / "openclaw" / "HEARTBEAT.md": TEMPLATES / "heartbeat.md",
        repo / "openclaw" / "CONSTITUTION.md": TEMPLATES / "constitution.md",
        repo / "openclaw" / "SOUL.md": TEMPLATES / "soul.md",
        repo / "command-center" / "project_adapter.json": TEMPLATES / "project_adapter.template.json",
    }

    for target, template in files.items():
        rendered = render_template(template, replacements)
        write(target, rendered, overwrite=args.overwrite)

    contract_stub = build_project_contract_stub(
        project_id=project_id,
        heartbeat_interval_seconds=args.heartbeat_interval_seconds,
        required_metrics=required_metrics,
        runbook_reviews=runbook_reviews,
        runbook_solve=runbook_solve,
        runbook_prevent=runbook_prevent,
    )
    contract_path = repo / "command-center" / "project_contract.json"
    if args.overwrite or not contract_path.exists():
        contract_path.parent.mkdir(parents=True, exist_ok=True)
        contract_path.write_text(json.dumps(contract_stub, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({
        "ok": True,
        "projectId": project_id,
        "repoPath": str(repo),
        "generatedFiles": [str(path) for path in files.keys()] + [str(contract_path)]
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
