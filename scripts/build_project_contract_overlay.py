#!/usr/bin/env python3
"""
Build project contract overlay data and inject it into snapshot.json.

This script gives Command Center a stable, per-project contract surface:
- freshness and staleness status per project
- optional mode-specific card overrides
- optional dynamic modules for project-specific layouts
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_MAX_STALENESS_SECONDS = {
    "outreach": 15 * 60,
    "polymarket": 5 * 60,
    "ops": 10 * 60,
    "infrastructure": 10 * 60,
    "generic": 20 * 60,
}

SUPPORTED_MODES = ("reviews", "solve", "prevent")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def to_iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def slugify(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def read_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def project_type_from_name(name: str) -> str:
    n = (name or "").lower()
    if "outreach" in n:
        return "outreach"
    if "polymarket" in n or "trading" in n:
        return "polymarket"
    if "ops" in n or "decision" in n or "automation" in n:
        return "ops"
    if "infra" in n or "reliability" in n:
        return "infrastructure"
    return "generic"


def project_key_set(project: Dict[str, Any]) -> set[str]:
    keys: set[str] = set()

    def add(value: Any) -> None:
        key = slugify(value)
        if key:
            keys.add(key)

    add(project.get("name"))
    add(project.get("id"))
    add(project.get("projectId"))
    add(project.get("slug"))
    for alias in (project.get("aliases") or []):
        add(alias)
    for alias in (project.get("matchNames") or []):
        add(alias)
    return keys


def match_snapshot_project(
    configured_project: Dict[str, Any], snapshot_projects: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    config_keys = project_key_set(configured_project)
    if not config_keys:
        return None
    for row in snapshot_projects:
        if config_keys.intersection(project_key_set(row)):
            return row
    return None


def read_project_contract(
    configured_project: Dict[str, Any],
) -> Tuple[Optional[Dict[str, Any]], Optional[Path], str]:
    command_center = configured_project.get("commandCenter") or {}
    repo_path = str(configured_project.get("repoPath") or "").strip()

    candidates: List[Path] = []

    for candidate in (
        command_center.get("contractPath"),
        configured_project.get("contractPath"),
    ):
        if candidate:
            candidates.append(Path(str(candidate)).expanduser())

    if repo_path:
        repo = Path(repo_path).expanduser()
        candidates.extend(
            [
                repo / "command-center" / "project_contract.json",
                repo / "runtime" / "command_center_contract.json",
                repo / "runtime" / "project_contract.json",
            ]
        )

    seen = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if not candidate.exists():
            continue
        try:
            payload = read_json(candidate)
        except Exception as exc:
            return None, candidate, f"Invalid contract JSON: {exc}"
        if not isinstance(payload, dict):
            return None, candidate, "Contract root must be a JSON object."
        return payload, candidate, ""

    return None, None, ""


def normalize_string_list(value: Any, limit: int = 8) -> List[str]:
    if not isinstance(value, list):
        return []
    out: List[str] = []
    for item in value:
        text = str(item or "").strip()
        if not text:
            continue
        if text in out:
            continue
        out.append(text[:140])
        if len(out) >= limit:
            break
    return out


def sanitize_cards(raw_cards: Any) -> Dict[str, Any]:
    if not isinstance(raw_cards, dict):
        return {}
    out: Dict[str, Any] = {}
    for mode in SUPPORTED_MODES:
        mode_data = raw_cards.get(mode)
        if not isinstance(mode_data, dict):
            continue
        problem = mode_data.get("problem") if isinstance(mode_data.get("problem"), dict) else {}
        solution = mode_data.get("solution") if isinstance(mode_data.get("solution"), dict) else {}
        problem_title = str(problem.get("title") or "").strip()
        solution_title = str(solution.get("title") or "").strip()
        if not problem_title and not solution_title:
            continue
        out[mode] = {
            "problem": {
                "title": problem_title,
                "body": str(problem.get("body") or "").strip(),
                "impact": str(problem.get("impact") or "").strip(),
                "evidenceHref": str(problem.get("evidenceHref") or "").strip(),
                "tags": normalize_string_list(problem.get("tags"), limit=8),
            },
            "solution": {
                "title": solution_title,
                "body": str(solution.get("body") or "").strip(),
                "eta": str(solution.get("eta") or "").strip(),
                "verifyHref": str(solution.get("verifyHref") or "").strip(),
                "verifyLabel": str(solution.get("verifyLabel") or "").strip(),
                "tags": normalize_string_list(solution.get("tags"), limit=8),
            },
        }
    return out


def sanitize_module_actions(raw_actions: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_actions, list):
        return []
    out: List[Dict[str, str]] = []
    for action in raw_actions:
        if not isinstance(action, dict):
            continue
        label = str(action.get("label") or "").strip()
        if not label:
            continue
        normalized = {
            "kind": str(action.get("kind") or "queue").strip().lower(),
            "label": label[:80],
            "actionKey": str(action.get("actionKey") or "").strip(),
            "command": str(action.get("command") or "").strip(),
            "href": str(action.get("href") or "").strip(),
        }
        out.append(normalized)
        if len(out) >= 6:
            break
    return out


def sanitize_modules(raw_modules: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_modules, list):
        return []
    out: List[Dict[str, Any]] = []
    for idx, module in enumerate(raw_modules):
        if not isinstance(module, dict):
            continue
        title = str(module.get("title") or "").strip()
        if not title:
            continue
        row = {
            "id": str(module.get("id") or f"module-{idx + 1}").strip(),
            "title": title[:90],
            "description": str(module.get("description") or "").strip()[:220],
            "kind": str(module.get("kind") or "list").strip().lower(),
            "modes": [
                mode
                for mode in normalize_string_list(module.get("modes"), limit=3)
                if mode in SUPPORTED_MODES
            ],
            "stats": [],
            "items": normalize_string_list(module.get("items"), limit=12),
            "tags": normalize_string_list(module.get("tags"), limit=10),
            "footer": normalize_string_list(module.get("footer"), limit=6),
            "actions": sanitize_module_actions(module.get("actions")),
        }
        stats = module.get("stats")
        if isinstance(stats, list):
            normalized_stats = []
            for stat in stats:
                if not isinstance(stat, dict):
                    continue
                label = str(stat.get("label") or "").strip()
                if not label:
                    continue
                normalized_stats.append(
                    {
                        "label": label[:80],
                        "value": str(stat.get("value") or "").strip()[:90],
                    }
                )
                if len(normalized_stats) >= 12:
                    break
            row["stats"] = normalized_stats
        out.append(row)
        if len(out) >= 10:
            break
    return out


def derived_generated_at(
    snapshot: Dict[str, Any],
    project_type: str,
    snapshot_project: Optional[Dict[str, Any]],
    contract: Optional[Dict[str, Any]],
) -> str:
    candidates: List[Any] = []
    if contract:
        candidates.extend(
            [
                contract.get("generatedAt"),
                contract.get("snapshotGeneratedAt"),
                contract.get("lastUpdate"),
            ]
        )
    if snapshot_project:
        candidates.extend(
            [
                snapshot_project.get("generatedAt"),
                snapshot_project.get("lastUpdate"),
            ]
        )
    if project_type == "outreach":
        outreach = snapshot.get("outreach") or {}
        candidates.extend(
            [
                (outreach.get("telemetry") or {}).get("generatedAt"),
                (outreach.get("snapshot") or {}).get("generatedAt"),
            ]
        )
    elif project_type == "polymarket":
        candidates.append((snapshot.get("portfolioCommandView") or {}).get("generatedAt"))
    elif project_type == "ops":
        candidates.append((snapshot.get("decisionConsole") or {}).get("generatedAt"))
    candidates.append(snapshot.get("generatedAt"))

    for value in candidates:
        parsed = parse_iso(value)
        if parsed is not None:
            return to_iso_z(parsed)
    return ""


def derive_status(
    snapshot: Dict[str, Any],
    project_type: str,
    snapshot_project: Optional[Dict[str, Any]],
    contract: Optional[Dict[str, Any]],
    is_stale: bool,
) -> str:
    if is_stale:
        return "stale"

    candidates: List[Any] = []
    if contract:
        candidates.append(contract.get("status"))
    if snapshot_project:
        candidates.append(snapshot_project.get("status"))
    if project_type == "outreach":
        candidates.append(((snapshot.get("outreach") or {}).get("telemetry") or {}).get("overallStatus"))
    elif project_type == "ops":
        candidates.append((snapshot.get("headline") or {}).get("globalStatus"))

    for candidate in candidates:
        text = str(candidate or "").strip()
        if text:
            return text
    return "monitoring"


def derive_summary(
    configured_project: Dict[str, Any],
    snapshot: Dict[str, Any],
    project_type: str,
    snapshot_project: Optional[Dict[str, Any]],
    contract: Optional[Dict[str, Any]],
) -> str:
    candidates: List[Any] = []
    if contract:
        candidates.append(contract.get("summary"))
    candidates.append(configured_project.get("summary"))
    if snapshot_project:
        candidates.append(snapshot_project.get("summary"))
    if project_type == "outreach":
        outreach_snapshot = (snapshot.get("outreach") or {}).get("snapshot") or {}
        queue_count = outreach_snapshot.get("adaptiveQueueCount")
        health_rows = outreach_snapshot.get("healthRows")
        if queue_count is not None and health_rows is not None:
            candidates.append(f"Queue {queue_count} | health rows {health_rows}")
    for candidate in candidates:
        text = str(candidate or "").strip()
        if text:
            return text
    return "No summary provided."


def build_missing_contract_module(project_name: str, project_id: str) -> Dict[str, Any]:
    return {
        "id": "missing-contract",
        "title": "Project Contract Missing",
        "description": "This project has no command-center contract artifact yet.",
        "kind": "list",
        "stats": [],
        "items": [
            "Create command-center/project_contract.json in the project repo.",
            "Emit generatedAt every run and set maxStalenessSeconds.",
            "Define cards and modules for Reviews, Solve, and Prevent.",
        ],
        "tags": [project_id, "contract-required"],
        "footer": [f"Project: {project_name}"],
        "actions": [
            {
                "kind": "link",
                "label": "Open Contract Guide",
                "actionKey": "",
                "command": "",
                "href": "./docs/project-contract.md",
            }
        ],
    }


def build_overlay(snapshot: Dict[str, Any], operator_config: Dict[str, Any]) -> Dict[str, Any]:
    now = now_utc()
    snapshot_projects = snapshot.get("projects") if isinstance(snapshot.get("projects"), list) else []
    configured_projects = (
        operator_config.get("projects") if isinstance(operator_config.get("projects"), list) else []
    )

    overlay_projects: List[Dict[str, Any]] = []
    stale_count = 0
    missing_contract_count = 0
    invalid_contract_count = 0

    for configured in configured_projects:
        if not isinstance(configured, dict):
            continue
        project_name = str(configured.get("name") or "").strip() or "Unnamed Project"
        project_id = (
            slugify(configured.get("id"))
            or slugify(configured.get("projectId"))
            or slugify(configured.get("slug"))
            or slugify(project_name)
        )
        project_type = str(configured.get("type") or "").strip() or project_type_from_name(project_name)
        snapshot_project = match_snapshot_project(configured, snapshot_projects)
        contract, contract_path, contract_error = read_project_contract(configured)
        command_center_cfg = configured.get("commandCenter") or {}

        max_age = (
            command_center_cfg.get("maxStalenessSeconds")
            if isinstance(command_center_cfg, dict)
            else None
        )
        if max_age is None and contract:
            max_age = contract.get("maxStalenessSeconds")
        try:
            max_age_seconds = int(max_age) if max_age is not None else DEFAULT_MAX_STALENESS_SECONDS.get(project_type, DEFAULT_MAX_STALENESS_SECONDS["generic"])
        except Exception:
            max_age_seconds = DEFAULT_MAX_STALENESS_SECONDS.get(project_type, DEFAULT_MAX_STALENESS_SECONDS["generic"])
        max_age_seconds = max(30, max_age_seconds)

        generated_at = derived_generated_at(snapshot, project_type, snapshot_project, contract)
        generated_dt = parse_iso(generated_at)
        age_seconds = int((now - generated_dt).total_seconds()) if generated_dt else None
        is_stale = age_seconds is None or age_seconds > max_age_seconds
        stale_reason = ""
        if age_seconds is None:
            stale_reason = "missing_generated_at"
        elif age_seconds > max_age_seconds:
            stale_reason = f"stale:{age_seconds}s>{max_age_seconds}s"

        if is_stale:
            stale_count += 1

        cards = sanitize_cards((contract or {}).get("cards"))
        modules = sanitize_modules((contract or {}).get("modules"))
        replace_default_modules = bool((contract or {}).get("replaceDefaultModules"))
        contract_found = contract_path is not None and contract is not None
        contract_valid = contract is not None and not contract_error

        if not contract_found:
            missing_contract_count += 1
            modules = modules or [build_missing_contract_module(project_name, project_id)]
        if contract_path is not None and not contract_valid:
            invalid_contract_count += 1

        overlay_projects.append(
            {
                "projectId": project_id,
                "name": project_name,
                "type": project_type,
                "owner": str(configured.get("owner") or "").strip(),
                "priority": str(configured.get("priority") or "").strip(),
                "generatedAt": generated_at,
                "ageSeconds": age_seconds,
                "maxStalenessSeconds": max_age_seconds,
                "isStale": is_stale,
                "staleReason": stale_reason,
                "status": derive_status(snapshot, project_type, snapshot_project, contract, is_stale),
                "summary": derive_summary(configured, snapshot, project_type, snapshot_project, contract),
                "cards": cards,
                "modules": modules,
                "replaceDefaultModules": replace_default_modules,
                "contractFound": contract_found,
                "contractValid": contract_valid,
                "contractSource": str(contract_path) if contract_path else "",
                "contractError": contract_error,
            }
        )

    return {
        "generatedAt": to_iso_z(now),
        "expectedProjectCount": len([p for p in configured_projects if isinstance(p, dict)]),
        "projectCount": len(overlay_projects),
        "staleCount": stale_count,
        "missingContractCount": missing_contract_count,
        "invalidContractCount": invalid_contract_count,
        "projects": overlay_projects,
    }


def run(snapshot_path: Path, operator_config_path: Path, output_path: Path) -> None:
    snapshot = read_json(snapshot_path)
    operator_config = read_json(operator_config_path)

    overlay = build_overlay(snapshot, operator_config)
    snapshot["projectContracts"] = overlay

    write_json(output_path, snapshot)

    print(
        "[contract-overlay] updated: "
        f"projects={overlay.get('projectCount', 0)} "
        f"stale={overlay.get('staleCount', 0)} "
        f"missingContracts={overlay.get('missingContractCount', 0)} "
        f"invalidContracts={overlay.get('invalidContractCount', 0)}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Inject project contract overlay into snapshot JSON.")
    parser.add_argument("--snapshot", default="snapshot.json", help="Input snapshot.json path")
    parser.add_argument(
        "--operator-config",
        default="operator.config.json",
        help="operator.config.json path",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Output file path (defaults to --snapshot for in-place update)",
    )
    args = parser.parse_args()

    snapshot_path = Path(args.snapshot).expanduser().resolve()
    operator_config_path = Path(args.operator_config).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve() if args.output else snapshot_path

    if not snapshot_path.exists():
        print(f"[contract-overlay] ERROR: snapshot path does not exist: {snapshot_path}")
        return 1
    if not operator_config_path.exists():
        print(f"[contract-overlay] ERROR: operator config does not exist: {operator_config_path}")
        return 1

    try:
        run(snapshot_path, operator_config_path, output_path)
    except Exception as exc:
        print(f"[contract-overlay] ERROR: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
