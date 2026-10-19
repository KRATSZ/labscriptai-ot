---
name: opentrons-experiment-intent-review
description: Plate mapping, tip strategy, deck alignment — validate experiment intent before coding or live runs.
type: prompt-only
mcp_tools: []
---

# Experiment Intent Review

Use when the task involves **what should happen on the deck** (patterns, mappings,
which wells, how many tips, source vs target).

Trigger: drawing, stamping, arbitrary well subsets, "does not look right",
wasteful tip usage, ambiguous deck orientation or slot assignments.

## Two-Phase Interaction

This skill has two modes inside the same skill. Do not create a separate skill.

### Phase A: Brief

Use this when the user is still describing the experiment in natural language.
The goal is to turn a rough request into a clear, short brief without making the
user fill out a form.

- Bundle the minimum blocking questions into one initial round. If the reply leaves a safety-critical fact unresolved, ask a focused follow-up rather than guessing.
- If only one preference is missing (for example tip reuse policy), explain the
  trade-off and give a recommendation.
- If the protocol can still be drafted safely, hand off with a recommended
  default instead of waiting forever for perfect inputs.
- Output a `brief_summary` and list only the missing items that could change
  safety, mapping, or simulation outcome.
- Answer only the decision the user is discussing now. For a mapping/tip discussion, aim for a short paragraph plus at most three concise questions (about 200 Chinese characters or 150 English words). Do not request the entire future protocol setup, add speculative plate rotations, change the assay to save tips, or propose unrequested hardware alternatives.
- Explain tip trade-offs qualitatively: fresh tips reduce carryover risk; reuse requires the experiment's contamination policy or validated SOP. Do not promise that either policy guarantees or destroys quantitative accuracy.
- If that policy is unknown, recommend fresh tips per transfer as a provisional default and ask whether reuse is allowed. A serial transfer intentionally carries sample onward, but this does not prove that residual liquid or adsorption has no effect on the dilution ratio.
- Do not lock a well list that conflicts with the user's direction words, invent a full deck layout, or write design files before that ambiguity is resolved. A brief clarification does not require reading supporting checklists or authoring schemas.
- When offering alternative row/column mappings, preserve the requested number of wells (for eight positions: A1–A8 versus A1–H1).

### Phase B: Lock

Use this when the user confirms the brief or asks to proceed.
The goal is to lock the intent before protocol authoring or live execution.

- Record the eight-block structured handoff below; give the user a brief summary and any blocking questions, not the full internal checklist.
- Mark all remaining assumptions as explicit defaults.
- If any safety-critical item is still unknown, set `recommendation` to
  `stop_for_human` instead of pretending the design is locked.

## Review Checklist

1. **Restate intent** in one paragraph (volumes, liquids, success criteria).
2. **Deck snapshot** — slots, load names, pipette mounts; flag anything unstated.
3. **Plate mapping** — 8x12 indexing, orientation vs human "up"; produce
   ASCII or table preview of target wells.
4. **Protocol alignment** — does well list match preview? Extra/missing wells?
5. **Critical sources** — identify wash buffer, enzyme, and other go/no-go
   source wells for Phase 3c probing. Output `critical_sources` with
   `slot`, `well`, `role`, and `required: true`.
6. **Tip and liquid strategy**
   - Same sterile liquid to many wells: one tip + repeated aspirate/dispense
     is acceptable; ask if biosafety requires one tip per well.
   - Minimize motion: batch paths, avoid unnecessary pick/drop.
   - If user has not chosen a tip policy yet, give one recommended default plus
     one sentence on when to choose the stricter option.
   - Record `dry_run_on` separately from contamination policy. Default `False`.
     When enabled, require a liquid-free deck and return each tip to its pickup
     position. Returned tips remain used and cannot be assumed clean for a wet run.
7. **Risks** — overflow, wrong reservoir well, wrong tip rack density,
   Flex vs OT-2 naming (requirements, trash, pipette API).

## Supporting references (read when needed)

Bundled checklists (extend with lab-specific SOPs as separate files if needed):

- [references/deck-constraints.md](references/deck-constraints.md) — slots, labware, pipettes, modules, orientation.
- [references/biology-constraints.md](references/biology-constraints.md) — sample/reagent semantics, contamination policy, success criteria.

## Required Output

Produce these sections for the downstream author (eight blocks):

1. `intent_summary` — bullet list of non-negotiables.
2. `biology_constraints` — short bullets; use `unknown` + one question if unspecified. See `references/biology-constraints.md` only when you need the checklist.
3. `deck_constraints` — robot type, intended slots/load names, pipettes, modules, orientation vs indexing; must match what will be simulated and later `reconcile_state`. See `references/deck-constraints.md` only when needed.
4. `plate_mask` or `target_wells` — explicit list or grid.
5. `critical_sources` — wells that require pre-run LPD probe (wash, enzyme, etc.).
6. `tip_policy` — e.g. `single_tip_reuse_same_buffer` vs `one_tip_per_destination`;
   include `dry_run_on: false` unless the operator explicitly requests dry mode.
7. `open_questions` — numbered; block live run until answered if safety-critical.
8. `recommendation` — `go` | `revise_mapping` | `revise_protocol` | `stop_for_human`.

Once the intent is ready for handoff, save `design-notes.json` following the schema in `opentrons-protocol-author/references/authoring-appendix.md`. A brief clarification before intent is locked does not need this file. Required fields:

- `deck_layout` — object with `description` (10+ chars summarizing the layout) and `slots_used`.
- `pipette_choice` — object with `name` and `reason` (explain why this pipette fits the volume range and well access pattern).
- `tip_strategy` — object with `policy` and `reason` (explain the trade-off: why fresh vs reuse, tip budget math).
- `key_decisions` — array capturing assumptions and design choices.

**Workflow-specific additions** that the structure checker evaluates:
- Mapping preview: include an ASCII or table preview of target wells in `deck_layout.description`.
- Tip tradeoff: explain in `tip_strategy.reason` why this policy is preferred over alternatives.

Keep `open_questions` short. In the common case it should contain zero or one
item, not a long survey.

## Optional

- `reference_sources` — **only if** you opened a bundled file under `references/` to shape `biology_constraints` or `deck_constraints`; list those paths (one line). Omit in the common case (checklist-only review).

## Handoff

- Intent confirmed -> `opentrons-protocol-author`
- Only import/simulate errors -> `opentrons-simulation-repair` or `opentrons-protocol-verify`
