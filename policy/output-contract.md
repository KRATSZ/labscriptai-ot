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
| `status` | yes | `passed`, `failed`, `blocked`, `needs_confirmation` |
| `summary` | yes | Plain-language outcome |
| `next_action` | yes | Concrete next step; use `null` only when truly complete |
| `artifacts` | no | Paths or labels for files the user may need |
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

### Live preflight needs confirmation

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
