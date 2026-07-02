# Probe Integration Acceptance — GPT-5.5

**Repository:** `/Users/gaoyuan/Documents/test/Flexagent/labscriptai-ot`  
**Branch / commit:** `feature/probe-integration` @ `9080166`  
**Date:** 2026-07-02  
**Scope:** read-only validation plus this Markdown report; no source edits, no push.

## Conclusion

**PASS.** The integrated probe stack meets the stated merge promises: full and targeted tests pass, setup verification has no failures, `apply_liquid_probe_results` now supports both batch and single-well paths, `probe_wells.auto_apply_to_session` remains opt-in by default, and the apply CLI is a thin MCP handler wrapper instead of the old `record_liquid_source_map` path.

**Full test pass rate:** 307 / 307 = **100%**  
**Can merge to main:** **Yes**, from this acceptance result. Remaining items below are live-operation/documentation risks, not merge blockers for the code integration.

## Test Results

| Check | Command / target | Result |
|---|---|---|
| Branch check | `git branch --show-current && git rev-parse --short HEAD` | `feature/probe-integration`, `9080166`; checkout not needed |
| Full MCP tests | `cd servers/opentrons-mcp && node --test` | **PASS** — 307 tests, 307 pass, 0 fail |
| Targeted probe tests | `node --test test/apply-liquid-probe-results.test.js test/apply-liquid-probe-results-mcp.test.js test/probe-wells.test.js test/probe-height-volume.test.js test/suffix-e2e-scenario.test.js` | **PASS** — 32 tests, 32 pass, 0 fail |
| Setup verification | `node scripts/verify-setup.mjs` | **PASS with warning** — 19 passed, 0 failures, 1 warning |
| Runbook existence | `docs/runbooks/probe-wells-live-validation.md` | **Present** |

`verify-setup` warning: `ultralytics` / `opencv` / `pillow` are not importable in the current venv. The script still reports setup usable, with the warning to resolve before live robot work.

## Integration Promise Check

| Promise | Acceptance |
|---|---|
| `liquid-probe-results.js` exists | **PASS** — `servers/opentrons-mcp/lib/liquid-probe-results.js` exists |
| `apply_liquid_probe_results` supports batch + single well | **PASS** — batch path delegates to `applyLiquidProbeResults`; single-well path supports `actual_volume_ul`, `height_mm`, and `observed_presence` |
| `auto_apply_to_session` default false | **PASS** — `probe_wells` schema default is `false`; pending writeback is recorded unless explicitly true |
| CLI calls MCP handler, not old `record_liquid_source_map` path | **PASS** — `scripts/apply-liquid-probe-results.mjs` imports `TOOL_HANDLERS` and calls `TOOL_HANDLERS.apply_liquid_probe_results` |
| Local trust / pending / suffix behavior not regressed | **PASS** — targeted tests cover trust monotonicity, pending probe writeback gate block/clear, and suffix sufficiency / final auto-resume eligibility |

## Gaps Top 3

1. **Live hardware validation not rerun in this acceptance.** The runbook exists and mocks/software tests pass, but this pass did not execute a real Flex probe cycle.
2. **Vision Python dependency warning remains.** `verify-setup` has 0 failures but warns that vision dependencies are missing; resolve before any workflow that relies on deck vision.
3. **Branch is still local/unpushed with a dirty working tree.** This does not affect the tested acceptance commit, but final merge hygiene should ensure only intended probe-integration files are included.

