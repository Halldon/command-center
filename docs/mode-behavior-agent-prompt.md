# Command Center Mode Behavior Prompt

You are improving mode behavior in Command Center.

## Objective
Make `Reviews`, `Solve`, and `Prevent` function as operational modes, not copy variations.

## Required Behavior
- `Reviews`: diagnostics + verification only. Block irreversible/external actions.
- `Solve`: allow mapped remediation execution with policy-compliant confirmation.
- `Prevent`: prioritize guardrails/automation/setup; block go-live and external irreversible actions.

## Data + UI Contracts
- Every project section must derive:
  - `mode` (global default with optional per-project override)
  - mode-specific primary action key
  - mode-specific module action set
  - mode-specific card language
- Primary CTA label + `data-action-key` must change by mode.
- Proactive cards must filter by active global mode.

## Safety Contracts
- Preserve strict project mapping by explicit project keys only.
- Never allow `queue-command` path to execute `go_live`.
- Enforce mode gating in click handlers, not only in rendering.

## Acceptance Checks
1. Mode switch changes CTA/action key, module actions, and proactive list.
2. `Reviews` and `Prevent` cannot execute irreversible external actions.
3. `Solve` can execute mapped solve actions with existing confirmation policy.
4. Per-project mode overrides are not wiped when global mode changes.
5. No new render flashing/reveal replay regressions.
