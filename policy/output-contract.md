# Agent output contract

Give the operator a short, plain-language result and a concrete next action. For routine completion, use up to three short bullets: what completed, what needs the user (omit when none), and links to the protocol/preview. Show gate names, exit codes, PIDs and per-check metrics only when they explain a problem or the user requests details. A successful local check normally needs one sentence, not a full test report. Distinguish local software checks from physical robot checks; never turn an unavailable check into a pass. Ask for missing blocking facts instead of guessing.

Keep structured status in the client's state or a single `status.json` beside the protocol, updating it at major phase boundaries. Do not paste this JSON, internal phase names or full logs into normal chat. Show structured output only when the user or client explicitly requests it. A brief clarification does not need a status file or a report.

Reuse returned tool results when recording status; do not rerun successful gates or inspect their implementation just to copy a report. Link existing artifacts and save only the compact outcome the operator needs.

Workflow order remains in [workflows.md](workflows.md). Error taxonomy remains in [error-response.md](error-response.md).

## Plain-language defaults

Use everyday words in normal replies; keep tool names and internal statuses in artifacts unless needed for troubleshooting.

For an already authorized action, prefer one or two short sentences: “按你要求跳过这两项，开始本次测试。” Mention new limitations only when they affect the next decision. Avoid bureaucratic words such as “豁免、准入、风险承诺” and repeated explanations of warnings the user has already addressed.

| Internal term | Say to the user |
|---------------|-----------------|
| preflight / gate | 上机前检查 / 这一步检查 |
| LogicPass / liquid ledger | 液体用量检查 |
| unevaluable / unsupported command | 这个工具暂时查不了这一步 |
| LPD / critical sources | 液位探测 / 优先检查的试剂孔 |
| reconcile_state / deck truth | 核对台面和记录是否一致 |
| skipped / not_checked | 已按你要求跳过 / 这项还没检查 |
| operator override / scoped authorization | 按你这次的要求继续 |

Optional checks are suggestions, not mandatory prerequisites. Keep “tool cannot check”, “not checked” and “a fault was detected” distinct. State a limitation once and proceed within the user’s existing instructions; do not make the operator repeat the same permission or use special wording. Offer practical options when a real problem needs a decision.

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
| `status` | yes | `passed`, `failed`, `skipped`, `not_checked`, `blocked`, `needs_confirmation`, `auto_fixable`, `needs_operator_physical_action` |
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
| **failed** | Agent / authoring loop | A check actually detected a failure (e.g. simulation error → repair). |
| **skipped** / **not_checked** | Agent continues where allowed | Optional check declined/unavailable, or named software gate explicitly waived. Record the omission; never turn it into a pass. |
| **auto_fixable** | Agent | Soft mismatch or uncertainty the agent can resolve with tools (prefer `reconcile_state`, re-check, repair) before any human ask. |
| **needs_operator_physical_action** | Operator (physical) | Hardware/lab state needs hands-on work (door, refill, rearrange labware). Report blockers; do not re-ask go-live confirm. |
| **blocked** | Stop | Cannot proceed (missing IP, hard stop, or requested live probe lacking its opt-in flag). Surfaced reason; no stacked “confirm this subgate?” prompts. |
| **needs_confirmation** | Operator (verbal, once) | Before the first physical motion lacking scoped authorization; may cover targeted probing and a conditional run together. See HumanConfirmBudget. |

### HumanConfirmBudget (go-live)

Use the scoped authorization rules in [workflows.md](workflows.md#humanconfirmbudget-go-live). No repeated permission questions for passing machine checks. Explicit authorization and an operator at the robot are required **before** live probing or any other physical motion; an env flag alone is insufficient. One prompt may cover selected probing and the planned run, including named software-check waivers. Reuse that authorization only while the protocol, deck and action scope remain unchanged.

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
  "sensors_used": ["live_readiness_check", "robot_status"],
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
  "next_action": "Continue selected probing, or skip it and proceed under the existing run authorization.",
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

### Live preflight needs scoped motion authorization

Use `needs_confirmation` before the first physical action not already covered by explicit authorization, not after every passing subgate.

```json
{
  "phase": "live_preflight",
  "status": "needs_confirmation",
  "summary": "Read-only checks passed; the selected targeted probe and run await authorization.",
  "next_action": "Authorize the selected probe and planned run, including any named software-check waivers.",
  "artifacts": []
}
```

## See also

- [workflows.md](workflows.md)
- [error-response.md](error-response.md)
- [docs/GLOSSARY.md](../docs/GLOSSARY.md)
