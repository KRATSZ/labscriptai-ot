# 远程分支探针能力对比：`feature/flex-liquid-presence-detection`

**对比基准：** 本地 `main`（`32410f4`）+ 工作区未提交改动  
**远程分支：** `origin/feature/flex-liquid-presence-detection`（`7b99039`，相对 main **+1 commit**）  
**调研日期：** 2026-07-02  
**方法：** `git fetch`（只读）→ `git diff main...origin/feature/flex-liquid-presence-detection` → `git show origin/...:path`

---

## 一句话

远程分支在 **main 已有 `probe_wells` 三模式协议生成** 之上，补齐 **Flex 电容 LPD 的 MCP 闭环**：`apply_liquid_probe_results` 批量写回、`observed_height_mm` 会话字段、`auto_apply_to_session`、真机验收 runbook/协议与作者参考；**未**包含本地工作区正在做的 **height→volume / trust_level=observed / pending_state_writeback 闸门**。

---

## 分支关系

| 项 | 说明 |
|---|---|
| 远程相对 main | 仅 1 commit：`7b99039` — *Add Flex capacitive LPD MCP closure, docs, and live validation protocols.* |
| main 相对远程 | 无额外 commit（远程基于当前 main） |
| 本地工作区 | 相对 main **有大量未提交** 探针/writeback 改动（见文末「若只选远程会丢失什么」） |

**变更规模（main → remote）：** 20 files，+1214 / −78 lines。

---

## 功能清单

### 远程分支新增 / 强化

| 能力 | 说明 |
|---|---|
| **`apply_liquid_probe_results` MCP 工具 [L2]** | 将 `probe_wells` 的 `PROBE_RESULT:` 批量写入 session `liquid_tracking`；仅 bookkeeping，不运动 |
| **`observed_height_mm` / `observed_probe_mode`** | `state.js` 与 `record_liquid_source_map` schema 扩展；与 `expected_presence` 分离 |
| **`probe_wells.auto_apply_to_session`** | 真机探针成功后可选自动调用 apply（默认 `false`） |
| **`lib/liquid-probe-results.js`** | 共享模块：`resolveProbeContext`、`probeResultToSourceUpdate`、`buildSourcesFromProbeResults`、`applyLiquidProbeResults` |
| **CLI 瘦身** | `scripts/apply-liquid-probe-results.mjs` 改为调用 MCP handler，去掉内联映射逻辑 |
| **工作流文档** | `policy/workflows.md` 新增 *Optional Flex liquid probe* 标准序列 |
| **Runbook** | `docs/runbooks/probe-wells-live-validation.md` — simulate → opt-in → live → gate |
| **作者参考** | `skills/opentrons-protocol-author/references/liquid-presence-detection-flex.md` + `assets/flex_liquid_probe_example.py` |
| **真机验收协议** | `automation/new/protocol_flex_lpd_live_validation.py`（detect/require/measure/measure_aspirate/negative）、`protocol_flex_lpd_measure_heights.py`、`protocol_b2_tip_c2_water_to_c1.py` |
| **测试** | `test/apply-liquid-probe-results.test.js`；`probe-wells.test.js` 增加 `auto_apply_to_session` 用例 |
| **技能链** | `opentrons-experiment-run`、`opentrons-protocol-author` 增加 LPD 指引 |

### main 与 remote **共有**（远程未改核心探针生成）

| 能力 | 说明 |
|---|---|
| **`probe_wells` [L3]** | 生成临时协议 → 本地 simulate → 可选真机（`OPENTRONS_ENABLE_PROBE_WELLS=1`） |
| **三探针模式** | `detect_presence` / `require_presence` / `measure_height` |
| **`lib/probe.js` 核心** | `buildProbeWellsProtocol` + `extractProbeResultsFromCommands`（远程与 main 均为 ~140 行，**无** height→volume） |
| **`live_liquid_recovery_gate`** | 只读 go/no-go（远程在 gate 文案中引用 apply 工具） |
| **CLI apply（main）** | main 已有 `apply-liquid-probe-results.mjs`，但 **无** MCP 工具；仅写 `observed_presence`（boolean） |

### 本地工作区相对 **main + remote** 的额外能力（未在远程分支）

| 能力 | 说明 |
|---|---|
| **`heightMmToVolumeUl`** | `probe.js` +275 行：labware 几何近似，探针高度 → `volume_ul` |
| **另一套 `apply_liquid_probe_results`** | 单孔 API（`slot_name`+`well_name`+`height_mm`/`actual_volume_ul`）；写 `trust_level:"observed"` 与 `volume_ul` |
| **`pending_state_writeback` 契约** | 真机 `probe_wells` 返回 `pending_state_writeback:true` + `required_next_tool`；持久化 `pending-probe-runs/` |
| **gate 集成** | `live_liquid_recovery_gate` 可因 `pending_probe_writeback` 阻断 |
| **测试** | `probe-height-volume.test.js`、`apply-liquid-probe-results-mcp.test.js`、`suffix-e2e-scenario.test.js` 等 |

---

## 关键代码路径

### Opentrons pLLD API 接法（remote / main 相同）

```
probe_wells (MCP)
  → buildProbeWellsProtocol()          servers/opentrons-mcp/lib/probe.js
  → Python 协议（apiLevel 2.24, Flex, liquid_presence_detection=True）
       detect_presence  → pipette.detect_liquid_presence(well)  → bool
       require_presence → pipette.require_liquid_presence(well) → pass/fail
       measure_height   → pipette.measure_liquid_height(well)   → mm（相对孔底）
  → protocol.comment("PROBE_RESULT:" + json)
  → run_protocol (opt-in live)
  → extractProbeResultsFromCommands()  解析 /runs/{id}/commands comment
```

### 远程 writeback 路径（remote 新增）

```
probe_wells (execute_on_robot=true, auto_apply_to_session=true?)
  → applyLiquidProbeResults()          servers/opentrons-mcp/lib/liquid-probe-results.js
       probeResultToSourceUpdate()      observed_presence + observed_height_mm + observed_probe_mode
  → record_liquid_source_map (batch)
  → summarize_liquid_source_map
```

或独立调用：

```
apply_liquid_probe_results(probe_results[] | probe_artifact_path)
scripts/apply-liquid-probe-results.mjs --probe-artifact ...
```

### 本地 writeback 路径（工作区，remote 无）

```
probe_wells (live) → pending-probe-runs.json + pending_state_writeback
apply_liquid_probe_results(slot, well, height_mm?)
  → heightMmToVolumeUl() → volume_ul
  → setLiquidContainerState(trust_level:"observed")
  → clearPendingProbeWell()
live_liquid_recovery_gate → blocked_by: pending_probe_writeback
```

---

## 相对 main 的新增能力（远程分支专有的增量）

1. **MCP 级 apply 闭环** — main 只有 CLI + gate 文案里的工具名，**没有**注册的 `apply_liquid_probe_results` handler。
2. **测高语义进 session** — `observed_height_mm` 字段与 `measure_height` 模式的一等映射。
3. **一键写回** — `auto_apply_to_session` 减少探针后手工 apply 步骤。
4. **可操作的验收资产** — runbook + 3 个 Flex LPD 真机协议 + 作者示例（含 `measure_aspirate` 教学流）。
5. **模块边界清晰** — apply 逻辑集中在 `liquid-probe-results.js`，CLI/MCP 共用。

---

## 优点

| 维度 | 评价 |
|---|---|
| **产品闭环** | 探针 → apply → gate 在文档与 MCP 工具层面对齐，operator 路径明确 |
| **与 Opentrons API 对齐** | 直接使用官方 Flex LPD 三 API；`liquid_presence_detection=True`；apiLevel ≥ 2.24 |
| **安全默认** | simulate-first、`OPENTRONS_ENABLE_PROBE_WELLS=1`、apply 无运动、expected vs observed 分离 |
| **可测试** | 单测覆盖 measure_height 映射、auto_apply、协议 slot 推断 |
| **真机导向** | 专用 live validation 协议 + runbook 步骤表；commit message 声明 hardware validated |
| **作者生态** | protocol-author 参考文档降低 Flex LPD 误用（导电 tip、simulate vs live） |

---

## 缺点与风险

| 风险 | 说明 |
|---|---|
| **写回模型偏 source-map** | apply 走 `record_liquid_source_map`，**不**设置 `trust_level:"observed"` 或 `volume_ul`；与 ROADMAP V2-plumbing / 本地 Virtual Lab State 方向不一致 |
| **无 writeback 强制闸门** | 远程 `probe_wells` **不**返回 `pending_state_writeback`；gate 无法因「探针未 apply」硬阻断 |
| **测高未转体积** | `observed_height_mm` 入库，但无 `heightMmToVolumeUl`；语义恢复仍缺 observed volume |
| **双轨 apply API 冲突** | 若合并本地工作区，两套 `apply_liquid_probe_results` 参数模型（batch `probe_results[]` vs 单孔 `height_mm`）需统一 |
| **文档附带 diff 噪音** | `docs/MCP_TOOLS.md` 顺带改动 `runtime_watch_loop` 层级描述与 virtual lab 文案（非探针核心，合并时需审） |
| **真机证据在分支外** | 分支内 **无** `runs/liquid-probe/` 归档；hardware validated 仅 commit message + 协议注释；本地 `runs/self-recovery/` 有 2026-06-22/23 Flex 探针 artifact，但属于更早主线实验 |
| **仿真不反映物理** | runbook 已说明；`require_presence` 空孔在 simulate 可能仍 pass |
| **OT-2 不适用** | 全链 Flex-only；无 OT-2 降级路径 |

---

## 真机验证痕迹

| 来源 | 内容 |
|---|---|
| **Commit message** | *Flex LPD validation and height-survey protocols validated on hardware* |
| **分支内协议** | `protocol_flex_lpd_live_validation.py` — 注释写明 deck B2 tips / C2 reservoir / A1 含水 / A2 空孔对照；期望 detect=true、measure 为正 mm |
| **Runbook** | 逐步 live 流程；要求 archive 到 `runs/liquid-probe/`（**分支未提交该目录**） |
| **本地主线 artifact（非本分支）** | `runs/self-recovery/artifacts/apply-liquid-probe-results-*.json`、`liquid-failure-replay-d3h1-*` 等 — Flex `192.168.66.102` 2026-06-22/23（见 `02-tactile-integration.md`） |
| **远程单测** | 全 mock fetch/simulate；`auto_apply_to_session` 用 fake run commands |

---

## 与 Opentrons pLLD API 的接法（摘要）

| Opentrons API | MCP / 协议用法 |
|---|---|
| `load_instrument(..., liquid_presence_detection=True)` | `buildProbeWellsProtocol` 默认 True；`probe_wells.liquid_presence_detection` 可关 |
| `pipette.detect_liquid_presence(well)` | `mode=detect_presence` → `value: bool` |
| `pipette.require_liquid_presence(well)` | `mode=require_presence` → 成功则 `value: true`；失败则 run 失败 |
| `pipette.measure_liquid_height(well)` | `mode=measure_height` → `value: float` mm；远程写入 `observed_height_mm` |
| 结果回传 | `protocol.comment("PROBE_RESULT:"+json)` → HTTP `/runs/{id}/commands` → `extractProbeResultsFromCommands` |

**注意：** Opentrons 文档中 `measure_liquid_height` 为相对孔底高度；作者参考建议 `well.bottom(height - clearance)` 或 `well.meniscus` 做 aspirate 深度。

---

## 若只选远程探针 stack，相对本地会丢失什么

以下均指 **当前工作区未提交改动** + **main 上已有、但与远程设计冲突或未合并的部分**：

1. **`heightMmToVolumeUl` 全链** — 探针 mm → `volume_ul` 几何换算及 `probe-height-volume.test.js`。
2. **Virtual Lab State observed volume writeback** — `trust_level:"observed"`、`setLiquidContainerState`、`canOverwriteTrust` 防降级。
3. **`pending_state_writeback` / `pending-probe-runs`** — 真机探针后强制 apply 的状态机与 gate `blocked_by: pending_probe_writeback`。
4. **单孔 apply API** — `slot_name`+`well_name`+`height_mm`/`actual_volume_ul`/`observed_presence` 模型及对应 MCP 测试。
5. **suffix / substitution E2E 探针锁** — `suffix-e2e-scenario.test.js` 中 probe-without-apply blocks gate 场景。
6. **本地 MCP 文档 writeback 契约** — `docs/MCP_TOOLS.md` 中 L3 `probe_wells` 的 `pending_state_writeback` 字段说明（远程文档用 `auto_apply` 叙事替代）。
7. **ROADMAP Phase V2-plumbing 进度** — 本地 `docs/ROADMAP-virtual-lab.md` 记录的 parallel worker 方向与远程 source-map-only apply **不兼容**，需重规划合并策略。

**保留远程 stack 仍可获得、本地 main 原本没有的：** MCP apply 工具、测高字段、`auto_apply_to_session`、runbook、Flex LPD 验收协议、作者参考、`liquid-probe-results.js` 模块测试。

**合并建议（供后续，非本任务范围）：** 以远程 **文档 + batch apply + observed_height_mm** 为壳，迁入本地 **height→volume + trust writeback + pending gate**；统一为一个 `apply_liquid_probe_results` schema。

---

## 关键文件列表（远程分支）

| 路径 | 角色 |
|---|---|
| `servers/opentrons-mcp/lib/probe.js` | 探针协议生成与 command 解析（与 main 同核心） |
| `servers/opentrons-mcp/lib/liquid-probe-results.js` | **remote 新增** — apply 共享逻辑 |
| `servers/opentrons-mcp/index.js` | `probe_wells`、`apply_liquid_probe_results`、`auto_apply_to_session` |
| `servers/opentrons-mcp/lib/state.js` | `observed_height_mm`、`observed_probe_mode` |
| `scripts/apply-liquid-probe-results.mjs` | CLI → MCP apply 薄封装 |
| `docs/runbooks/probe-wells-live-validation.md` | 真机验收 runbook |
| `docs/MCP_TOOLS.md` | L2 apply + probe_wells 参数更新 |
| `policy/workflows.md` | Optional Flex liquid probe 流程 |
| `skills/opentrons-protocol-author/references/liquid-presence-detection-flex.md` | Flex LPD 作者指南 |
| `skills/opentrons-protocol-author/assets/flex_liquid_probe_example.py` | 示例协议 |
| `automation/new/protocol_flex_lpd_live_validation.py` | 真机验收套件 |
| `automation/new/protocol_flex_lpd_measure_heights.py` | 测高 survey |
| `automation/new/protocol_b2_tip_c2_water_to_c1.py` | Deck 布局参考协议 |
| `servers/opentrons-mcp/test/apply-liquid-probe-results.test.js` | apply 模块单测 |
| `servers/opentrons-mcp/test/probe-wells.test.js` | 含 auto_apply 集成测 |

---

## 参考命令

```bash
git fetch origin feature/flex-liquid-presence-detection
git log --oneline main..origin/feature/flex-liquid-presence-detection
git diff --stat main...origin/feature/flex-liquid-presence-detection
git show origin/feature/flex-liquid-presence-detection:servers/opentrons-mcp/lib/liquid-probe-results.js
```
