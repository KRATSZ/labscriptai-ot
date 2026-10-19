# Agent output contract

Give the operator a short, plain-language result and a concrete next action. Distinguish local software checks from physical robot checks; never turn an unavailable check into a pass. Ask for missing blocking facts instead of guessing.

Keep structured status in the client's state or a single `status.json` beside the protocol, updating it at major phase boundaries. Do not paste this JSON, internal phase names or full logs into normal chat. Show structured output only when the user or client explicitly requests it. A brief clarification does not need a status file or a report.

Reuse returned tool results when recording status; do not rerun successful gates or inspect their implementation just to copy a report. Link existing artifacts and save only the compact outcome the operator needs.

Workflow order remains in [workflows.md](workflows.md). Error taxonomy remains in [error-response.md](error-response.md).

## Status JSON template

Use this structure for recorded status (intent complete, protocol drafted, simulation result, live preflight, execution outcome):

```json
{
  "phase": "simulation",
  "status": "passed",
  "summary": "One-sentence conclusion for the operator.",
  "next_action": "What the user or agent should do next.",
  "artifacts": ["protocol.py", "sim-log.txt"],
  "blocked_reason": null
}
```

### Fields

| Field | Required | Values / notes |
|-------|----------|----------------|
| `phase` | yes | `intent`, `protocol`, `simulation`, `live_preflight`, `execution`, `recovery` |
| `subphase` | for `live_preflight` | `dashboard`, `deck_vision`, `critical_probe` |
| `status` | yes | `passed`, `failed`, `blocked`, `needs_confirmation`, `auto_fixable`, `needs_operator_physical_action` |
| `summary` | yes | Plain-language outcome |
| `next_action` | yes | Concrete next step; use `null` only when truly complete |
| `artifacts` | no | Paths or labels for files the user may need |
| `sensors_used` | no | Tools used in this subphase (e.g. `live_readiness_check`, `deck_vision_check(mode=local)`) |
| `vlm_used` | no | `true` when Ark/Kimi VLM was invoked |
| `vlm_escalated` | no | `true` when YOLO triggered VLM second opinion |
| `blocked_reason` | when `status` is `blocked` or `failed` | Short reason; align with `error-response.md` leaves when applicable |

### Status semantics (escalate vs auto-fix)

| Status | Who acts | When |
|--------|----------|------|
| **passed** | Agent continues | Machine-judged gate cleared (incl. sensor-aligned vision). No verbal human re-confirm of this subgate. |
| **failed** | Agent / authoring loop | Fix required in this phase (e.g. simulation error → repair). |
| **auto_fixable** | Agent | Soft mismatch or uncertainty the agent can resolve with tools (prefer `reconcile_state`, re-check, repair) before any human ask. |
| **needs_operator_physical_action** | Operator (physical) | Hardware/lab state needs hands-on work (door, refill, rearrange labware). Report blockers; do not re-ask go-live confirm. |
| **blocked** | Stop | Cannot proceed (missing IP, hard stop, env gate not set). Surfaced reason; no stacked “confirm this subgate?” prompts. |
| **needs_confirmation** | Operator (verbal, once) | **Final go-live only** — after Phase 3a/3b/3c machine gates pass, before `run_protocol` / play. May bundle `dry_run_on` and whether live-probe env is already opted in. |

### HumanConfirmBudget (go-live)

Phase **3a / 3b / 3c** tool outcomes are **machine-judged**. Agents must **not** verbally re-confirm each passed subgate (“Door OK?”, “Vision OK?”, “Probe OK?”).

The **only** go-live verbal confirmation is the final `run_protocol` / play confirmation. That single prompt may bundle:

- proceed with live run,
- resolved `dry_run_on`,
- whether `OPENTRONS_ENABLE_PROBE_WELLS=1` (or equivalent) is already set when live probe was used.

Do **not** remove env / opt-in hard gates themselves — if probe live motion requires the env flag and it is unset, status is `blocked` (set the env), not a conversational substitute for the gate.

## Examples

### Simulation passed

```json
{
  "phase": "simulation",
  "status": "passed",
  "summary": "Local simulation completed with no errors.",
  "next_action": "If you want to run on the robot, provide robot IP for live_readiness_check.",
  "artifacts": ["examples/01-flex-serial-dilution/protocol.py"]
}
```

### Simulation failed

```json
{
  "phase": "simulation",
  "status": "failed",
  "summary": "Simulation failed: missing trash on Flex deck.",
  "next_action": "Revise protocol to load trash_bin, then re-run simulate_protocol.",
  "artifacts": [],
  "blocked_reason": "MISSING_TRASH_OR_SETUP"
}
```

### Live preflight dashboard passed (Phase 3a)

```json
{
  "phase": "live_preflight",
  "subphase": "dashboard",
  "status": "passed",
  "summary": "Door closed, estop clear, modules ready, session consistent.",
  "next_action": "Continue Phase 3b with deck_vision_check.",
  "sensors_used": ["live_readiness_check", "robot_status", "robot_status"],
  "vlm_used": false
}
```

### Live preflight deck vision passed — sensor-aligned (Phase 3b)

YOLO uncertainty escalated to VLM; VLM agrees with expected layout → **passed**. Do not teach agents to ask the human to “confirm D3”.

```json
{
  "phase": "live_preflight",
  "subphase": "deck_vision",
  "status": "passed",
  "summary": "YOLO low confidence on D3; Ark VLM agrees a 96-well plate is present and matches session layout.",
  "next_action": "Continue Phase 3c critical probe (machine gate); no human re-confirm of vision.",
  "sensors_used": ["deck_vision_check(mode=local)", "analyze_image(provider=ark)"],
  "vlm_escalated": true,
  "vlm_used": true
}
```

### Live preflight deck vision auto-fixable — reconcile before human (Phase 3b)

```json
{
  "phase": "live_preflight",
  "subphase": "deck_vision",
  "status": "auto_fixable",
  "summary": "Vision layout differs from session bookkeeping on D3.",
  "next_action": "Call reconcile_state and re-check robot APIs before any operator ask.",
  "sensors_used": ["deck_vision_check(mode=local)", "analyze_image(provider=ark)"],
  "vlm_escalated": true,
  "vlm_used": true
}
```

### Live preflight critical probe blocked (Phase 3c)

```json
{
  "phase": "live_preflight",
  "subphase": "critical_probe",
  "status": "blocked",
  "summary": "Wash buffer well D3-A1 has no liquid.",
  "next_action": "Refill D3-A1 or update source map before run_protocol.",
  "blocked_reason": "INSUFFICIENT_VOLUME",
  "vlm_used": false
}
```

### Live preflight needs confirmation — final go-live only

Use `needs_confirmation` **once** after machine-judged 3a/3b/3c pass (or skip), not per subgate.

```json
{
  "phase": "live_preflight",
  "status": "needs_confirmation",
  "summary": "Phases 3a–3c machine gates passed; robot reachable, deck reconciled, critical sources probed.",
  "next_action": "Confirm start of run_protocol (may include dry_run_on and live-probe env already opted in).",
  "artifacts": []
}
```

## See also

- [workflows.md](workflows.md)
- [error-response.md](error-response.md)
- [docs/GLOSSARY.md](../docs/GLOSSARY.md)
