# Agent output contract

Agents should end each major phase with a short human-readable summary **and** a structured status block so operators know where they are and what to do next.

Workflow order remains in [workflows.md](workflows.md). Error taxonomy remains in [error-response.md](error-response.md).

## Status JSON template

Include this fenced JSON block at phase boundaries (intent complete, protocol drafted, simulation result, live preflight, execution outcome):

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
| `status` | yes | `passed`, `failed`, `blocked`, `needs_confirmation` |
| `summary` | yes | Plain-language outcome |
| `next_action` | yes | Concrete next step; use `null` only when truly complete |
| `artifacts` | no | Paths or labels for files the user may need |
| `sensors_used` | no | Tools used in this subphase (e.g. `live_readiness_check`, `vision_check`) |
| `vlm_used` | no | `true` when Ark/Kimi VLM was invoked |
| `vlm_escalated` | no | `true` when YOLO triggered VLM second opinion |
| `blocked_reason` | when `status` is `blocked` or `failed` | Short reason; align with `error-response.md` leaves when applicable |

### Status semantics

- **passed** — Gate cleared; proceed to next phase unless operator must confirm live steps.
- **failed** — Fix required in this phase (e.g. simulation error → repair loop).
- **blocked** — Cannot proceed without external input (missing robot IP, door open, reconciliation required).
- **needs_confirmation** — Readiness checks passed but live motion requires explicit operator opt-in.

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
  "sensors_used": ["live_readiness_check", "robot_status", "module_status"],
  "vlm_used": false
}
```

### Live preflight deck vision needs confirmation (Phase 3b)

```json
{
  "phase": "live_preflight",
  "subphase": "deck_vision",
  "status": "needs_confirmation",
  "summary": "YOLO low confidence on D3; Ark VLM agrees a 96-well plate is present.",
  "next_action": "Confirm D3 layout, then continue critical probe.",
  "sensors_used": ["vision_check", "analyze_image_with_ark"],
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

### Live preflight needs confirmation (legacy summary)

```json
{
  "phase": "live_preflight",
  "status": "needs_confirmation",
  "summary": "Robot reachable, modules ready, deck reconciled.",
  "next_action": "Confirm you want to start the run; then call run_protocol with robot_ip.",
  "artifacts": []
}
```

## See also

- [workflows.md](workflows.md)
- [error-response.md](error-response.md)
- [docs/GLOSSARY.md](../docs/GLOSSARY.md)
