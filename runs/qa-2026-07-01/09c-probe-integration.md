# 探针整合报告：`feature/probe-integration`

**日期：** 2026-07-02  
**基准：** 本地 main + 工作区 V2-plumbing 改动  
**并入源：** `origin/feature/flex-liquid-presence-detection`（`7b99039`）  
**方法：** 手动 port（非 cherry-pick）——工作区未提交改动过多，cherry-pick 冲突面大

---

## 一句话结论

在保留本地 **height→volume / trust_level=observed / pending_probe_writeback / suffix 三锁** 的前提下，并入远程 **batch apply、`observed_height_mm`、auto_apply_to_session、runbook/验收协议/作者参考**；`apply_liquid_probe_results` MCP handler 为唯一真相，CLI 已改调 handler。

---

## 整合策略与选择

| 维度 | 决策 |
|---|---|
| 整合方式 | **手动 merge**（未 cherry-pick `7b99039`） |
| 本地保留 | `heightMmToVolumeUl`、`canOverwriteTrust`、`pending-probe-runs`、`suffix-monitor`、五端 outbox wake、`consume-runtime-outbox` |
| 远程并入 | `liquid-probe-results.js`、batch apply schema、`observed_height_mm`/`observed_probe_mode`、`auto_apply_to_session`、runbook、Flex LPD 协议、作者参考、`apply-liquid-probe-results.test.js` |
| apply 统一 | 单孔 + batch 均走 `TOOL_HANDLERS.apply_liquid_probe_results`；batch 经 `writeObservedProbeResults` 写 VLS（非旧 `record_liquid_source_map` 直写） |
| CLI | `scripts/apply-liquid-probe-results.mjs` → 薄封装调 MCP handler（不再内联 source-map 映射） |

---

## 冲突与解法

| 冲突点 | 解法（本地优先） |
|---|---|
| 两套 `apply_liquid_probe_results` API | **双模式合一**：有 `probe_results[]`/`probe_artifact_path` → batch；有 `well_name` 且无 batch 输入 → 单孔 V2 |
| 远程 batch 仅 `record_liquid_source_map` | batch 路径改为 `writeObservedProbeResults`：`setLiquidContainerState(trust_level:"observed")` + `heightMmToVolumeUl` + `clearPendingProbeWell` |
| 远程无 `pending_state_writeback` | **保留** pending gate；`auto_apply_to_session=true` 时跳过 pending（apply 已清 well） |
| `state.js` 字段 | 合并：本地 trust 字段 + 远程 `observed_height_mm`/`observed_probe_mode` |
| 远程 `apply-liquid-probe-results.test.js` vs 本地 `apply-liquid-probe-results-mcp.test.js` | **并存**：模块测 + MCP 单孔/pending/suffix 测均保留 |
| 文档 `MCP_TOOLS.md` 等 | 未从远程整文件覆盖（避免冲掉本地 pending 契约）；仅 checkout 远程 runbook/skills/workflows |

---

## 关键实现

### `lib/liquid-probe-results.js`（新建）

- `resolveProbeContext` / `probeResultToSourceUpdate` / `buildSourcesFromProbeResults` — 来自远程
- `applyLiquidProbeResults` — 注入 `writeObservedProbeResults`（index.js），不再直调 `record_liquid_source_map`

### `index.js`

- `writeObservedProbeResults`：batch 每孔 `trust_level:"observed"`、测高转 `volume_ul`、`observed_height_mm` 入库、清 pending
- `probe_wells`：`auto_apply_to_session`（默认 false）；true 时自动 batch apply 且不标 `pending_state_writeback`
- `apply_liquid_probe_results` schema：单孔参数 + batch 参数合并

### CLI

```bash
# 现走 MCP handler（batch V2 writeback）
node scripts/apply-liquid-probe-results.mjs --probe-artifact runs/.../probe.json --session-id ...
```

---

## 测试结果

```bash
cd servers/opentrons-mcp && node --test
# → 307 pass / 0 fail（整合前本地 300；新增 7：apply-liquid-probe-results.test.js×6、probe-wells auto_apply×1）
```

探针相关子集（手动）：

```bash
node --test test/probe-wells.test.js test/probe-height-volume.test.js \
  test/apply-liquid-probe-results-mcp.test.js test/apply-liquid-probe-results.test.js \
  test/live-liquid-recovery-gate.test.js
# → 全部 PASS
```

---

## 改动文件清单

**核心代码**

- `servers/opentrons-mcp/lib/liquid-probe-results.js`（新增）
- `servers/opentrons-mcp/index.js`（batch/single apply、auto_apply、writeObservedProbeResults）
- `servers/opentrons-mcp/lib/state.js`（observed_height_mm、observed_probe_mode）
- `scripts/apply-liquid-probe-results.mjs`（CLI → MCP handler）

**测试**

- `servers/opentrons-mcp/test/apply-liquid-probe-results.test.js`（新增，远程 port + trust 断言）
- `servers/opentrons-mcp/test/fixtures/probe-protocol-slot-c2.py`（新增）
- `servers/opentrons-mcp/test/probe-wells.test.js`（+auto_apply 用例）
- 保留：`apply-liquid-probe-results-mcp.test.js`、`probe-height-volume.test.js`、`suffix-e2e-scenario.test.js`

**文档 / 运营资产（来自远程）**

- `docs/runbooks/probe-wells-live-validation.md`
- `skills/opentrons-protocol-author/references/liquid-presence-detection-flex.md`
- `skills/opentrons-protocol-author/assets/flex_liquid_probe_example.py`
- `automation/new/protocol_flex_lpd_live_validation.py`
- `automation/new/protocol_flex_lpd_measure_heights.py`
- `automation/new/protocol_b2_tip_c2_water_to_c1.py`
- `policy/workflows.md`（Optional Flex liquid probe 段）
- `skills/opentrons-experiment-run/SKILL.md`、`skills/opentrons-protocol-author/SKILL.md`（LPD 指引）

**本报告**

- `runs/qa-2026-07-01/09c-probe-integration.md`

---

## 未纳入 / 后续

- 未 push（留给 upload worker）
- `docs/MCP_TOOLS.md` 本地 pending 契约与远程 batch schema 文档可再手工对齐
- 真机 V2 writeback 回归报告仍 open（ROADMAP）

---

## 参考

- [`09a-probe-branch-remote.md`](09a-probe-branch-remote.md)
- [`09b-probe-branch-local.md`](09b-probe-branch-local.md)
