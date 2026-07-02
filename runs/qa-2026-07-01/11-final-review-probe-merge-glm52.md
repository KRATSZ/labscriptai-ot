# Probe Integration — Final Review (GLM-5.2, independent of GPT-5.5)

**Repository:** `/Users/gaoyuan/Documents/test/Flexagent/labscriptai-ot`
**Branch / commit:** `feature/probe-integration` @ `9080166`
**Reviewer:** GLM-5.2 (final-review tier)
**Date:** 2026-07-02
**Scope:** read-only verification + this Markdown report. No source edits, no merge, no push.
**Inputs read:** [`09a-probe-branch-remote.md`](09a-probe-branch-remote.md), [`09b-probe-branch-local.md`](09b-probe-branch-local.md), [`09c-probe-integration.md`](09c-probe-integration.md), [`10-acceptance-probe-integration-gpt55.md`](10-acceptance-probe-integration-gpt55.md)

---

## 结论：**REJECT**（不可按现状合并）

GPT-5.5 报告的 **307/307 PASS 是真实的，但仅在「脏工作区」中成立**——它依赖若干**未提交、未跟踪**的文件（最关键的是 `lib/suffix-monitor.js`）。在 commit `9080166` 自身的快照上，`index.js` **无法加载**（`ERR_MODULE_NOT_FOUND: lib/suffix-monitor.js`），MCP 服务起不来。

因此：把 `9080166` 原样 fast-forward 合并到 `main` 会让 `main` 上的 MCP server **启动失败**，且 09c/10 所声明的「保留 height→volume / trust_level=observed / pending_probe_writeback / suffix 三锁」**在 commit 内并不成立**（相关实现与测试多数未提交）。

**Merge 风险（Top 1）：** commit `9080166` 静态 `import "./lib/suffix-monitor.js"`，但该文件未包含在 commit、也未在 `main`，仅以未跟踪文件存在于工作区 → 合并后 `main` 的 `index.js` 加载即抛 `ERR_MODULE_NOT_FOUND`，MCP server 不可用；307/307 是靠工作区未跟踪文件跑出来的。

---

## 1. 独立全量复核 `cd servers/opentrons-mcp && node --test`

### 1a. 工作区（当前脏树，含未跟踪/未提交文件）

```bash
cd servers/opentrons-mcp && node --test
# → tests 307 / pass 307 / fail 0   ✅
```

与 GPT-5.5 报告一致。探针子集 46/46 PASS：
`apply-liquid-probe-results.test.js`、`apply-liquid-probe-results-mcp.test.js`、`probe-wells.test.js`、`probe-height-volume.test.js`、`suffix-e2e-scenario.test.js`、`live-liquid-recovery-gate.test.js`。

### 1b. Commit `9080166` 自身快照（隔离 git worktree，无工作区脏文件）

```bash
git worktree add --detach /tmp/probe-commit-check 9080166
cd servers/opentrons-mcp && node --test
# → tests 163 / pass 130 / fail 33   ❌
```

根因（加载 `index.js`）：
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../servers/opentrons-mcp/lib/suffix-monitor.js'
  imported from .../servers/opentrons-mcp/index.js
```

33 个失败用例文件**全部**是导入 `index.js` 的测试（`probe-wells`、`live-liquid-recovery-gate`、`liquid-source-substitution`、`runtime-watch`、`runtime-outbox`、`health-check`、`experiment-history` 等）——不是逻辑失败，而是 `index.js` 根本无法被 import。

**全量 import 扫描（commit 快照内所有已跟踪 .js 的相对导入）：** 唯一缺失目标即
`index.js -> ./lib/suffix-monitor.js`。

> 结论：commit `9080166` 单独不可运行；307/307 验收针对的是包含未跟踪文件的工作区，而非被验收的 commit。GPT-5.5 gap #3 把「dirty working tree」当作卫生问题低估了——实际是 commit 不可用。

worktree 已清理（`git worktree remove --force`），未触碰主工作区。

---

## 2. 抽查（工作区内源码，确认设计意图存在）

| 抽查项 | 结果 | 证据 |
|---|---|---|
| `apply_liquid_probe_results` 双模式 | **PASS（工作区）** | `index.js:5016` — 有 `probe_results[]`/`probe_artifact_path` → batch 走 `applyLiquidProbeResults`→`writeObservedProbeResults`；否则单孔走 `slot_name`+`well_name`+`actual_volume_ul`/`height_mm`/`observed_presence` |
| batch 走 V2 writeback，非旧 `record_liquid_source_map` 直写 | **PASS（工作区）** | `lib/liquid-probe-results.js:119` `applyLiquidProbeResults` 注入 `writeObservedProbeResults`；`index.js:262` 写 `trust_level:"observed"` + `heightMmToVolumeUl` + `observed_height_mm` + `clearPendingProbeWell` |
| CLI 不走旧路径 | **PASS** | `scripts/apply-liquid-probe-results.mjs:58-68` import `TOOL_HANDLERS` 并调 `apply_liquid_probe_results`；无内联 `record_liquid_source_map` |
| `trust_level=observed` / 单调信任 | **PASS（工作区）** | `index.js:278/5093` `canOverwriteTrust(currentTrust,"observed")` 防降级；`state.js` `LIQUID_TRUST_LEVELS` |
| `pending_probe_writeback` / pending 闸门 | **PASS（工作区）** | `index.js:7253` `recordPendingProbeRun`；`7273-7277` 返回 `pending_state_writeback:true` + `required_next_tool`；`clearPendingProbeWell:231` |
| `auto_apply_to_session` 默认 false | **PASS** | `index.js:1520-1522` schema `default:false`；`true` 时自动 batch apply 且不标 pending |
| suffix 三锁 E2E | **PASS（工作区）** | `suffix-e2e-scenario.test.js` lock1/2/3a/3b + e2e 5 例全过 |
| height→volume | **PASS（工作区）** | `lib/probe.js:358` `heightMmToVolumeUl`、`346` `lookupLabwareGeometry`、`142` `APPROXIMATE_LABWARE_GEOMETRY` |

> 重要修订：以上「PASS（工作区）」结论**仅对当前脏工作区成立**。在 commit `9080166` 快照中：
> - `lib/suffix-monitor.js` **缺失** → suffix 锁模块不存在；
> - `lib/probe.js` **未含** `heightMmToVolumeUl`（+276 行为工作区未提交改动）→ `callHeightMmToVolumeUl` 因 `typeof fn!=="function"` 静默返回 `null`，height→volume **静默失效**；
> - `apply-liquid-probe-results-mcp.test.js`、`suffix-e2e-scenario.test.js`、`probe-height-volume.test.js`、`suffix-monitor.test.js` 均为**未跟踪文件**，commit 快照不执行它们 → trust/pending/suffix/height 的覆盖在 commit 内**为零**。

---

## 3. git 状态

### `git log -3`

```
9080166 Integrate remote Flex LPD probe closure with local V2 writeback.
32410f4 Merge branch 'feature/dry-run-tip-return'
4f82ef3 Merge branch 'feature/flex-deck-vision'
```

### `git diff main...feature/probe-integration --stat`（17 文件，+2015 / −83）

```
 automation/new/protocol_b2_tip_c2_water_to_c1.py       |  67 ++
 automation/new/protocol_flex_lpd_live_validation.py    | 242 +++++++
 automation/new/protocol_flex_lpd_measure_heights.py    |  84 +++
 docs/runbooks/probe-wells-live-validation.md           |  99 +++
 policy/workflows.md                                    |  17 +
 runs/qa-2026-07-01/09c-probe-integration.md            | 125 ++++
 scripts/apply-liquid-probe-results.mjs                 |  96 +--
 servers/opentrons-mcp/index.js                         | 714 ++++++++++++++++++++-
 servers/opentrons-mcp/lib/liquid-probe-results.js      | 163 +++++
 servers/opentrons-mcp/lib/state.js                     |  87 ++-
 servers/opentrons-mcp/test/apply-liquid-probe-results.test.js        | 100 +++
 servers/opentrons-mcp/test/fixtures/probe-protocol-slot-c2.py        |   8 +
 servers/opentrons-mcp/test/probe-wells.test.js         |  85 +++
 skills/opentrons-experiment-run/SKILL.md               |   4 +
 skills/opentrons-protocol-author/SKILL.md              |   2 +
 skills/opentrons-protocol-author/assets/flex_liquid_probe_example.py | 109 ++++
 skills/opentrons-protocol-author/references/liquid-presence-detection-flex.md | 96 +++
```

> 注意：`lib/probe.js` 与 `lib/suffix-monitor.js` 均**不在**此 diff。`index.js` 的 +714 行调用 `probeLib.heightMmToVolumeUl` 并 `import "./lib/suffix-monitor.js"`，但二者未进入 commit。

### 工作区未提交但被 commit 依赖的文件

未跟踪（`??`，不在 commit、不在 main）：

| 文件 | 影响 |
|---|---|
| `servers/opentrons-mcp/lib/suffix-monitor.js` | **硬阻断**：`index.js` 静态导入它 |
| `servers/opentrons-mcp/lib/runtime-watch/outbox-tick.js` | commit 内未被引用（仅被未提交的 `watch-loop.js` 改动引用），非硬阻断 |
| `servers/opentrons-mcp/test/probe-height-volume.test.js` | 7 例，验证 height→volume |
| `servers/opentrons-mcp/test/apply-liquid-probe-results-mcp.test.js` | 7 例，单孔/pending/suffix MCP |
| `servers/opentrons-mcp/test/suffix-e2e-scenario.test.js` | 5 例，三锁 E2E |
| `servers/opentrons-mcp/test/suffix-monitor.test.js` | 6 例 |
| `servers/opentrons-mcp/test/consume-runtime-outbox.test.js` | 14 例（outbox-wake 相关） |

未提交改动（已跟踪文件 ` M`，被 commit 漏掉）：

| 文件 | 与探针关系 |
|---|---|
| `servers/opentrons-mcp/lib/probe.js`（+276） | **直接**：新增 `heightMmToVolumeUl`/`lookupLabwareGeometry`/`APPROXIMATE_LABWARE_GEOMETRY` |
| `servers/opentrons-mcp/lib/liquid-source-substitution.js` | 间接（suffix/换源联动） |
| `servers/opentrons-mcp/lib/runtime-outbox.js`、`lib/runtime-watch/watch-loop.js` | outbox-wake，非探针核心 |
| `scripts/runtime-recovery-monitor.mjs`、若干 test 文件、`docs/*`、`install-labscriptai-ot.sh`、`.claude-plugin/`、`.codex-plugin/` | 非探针核心 |

---

## 4. 安全

| 检查 | 结果 |
|---|---|
| `LICENSE`（3098B）、`CITATION.cff`（1311B）存在且**未被分支触碰** | **PASS** — `git diff main...feature/probe-integration -- LICENSE CITATION*` 为空；引用义务未削弱 |
| diff 内 secrets 扫描（api_key/token/password/private_key/AKIA/ghp_ 等） | **PASS** — 仅命中一处函数名 `resolveSiliconFlowApiKey,`（`./lib/siliconflow.js` 的既有 import，且为 diff **上下文行**非新增）；无任何字面量密钥/令牌 |
| 探针安全默认（simulate-first、`OPENTRONS_ENABLE_PROBE_WELLS=1`、apply 无运动） | 工作区内保持 |

---

## 5. 合并风险与必须修复项

### Top 1 风险（阻断性）
commit `9080166` 的 `index.js` 静态导入 `./lib/suffix-monitor.js`，但该文件未在 commit、也未在 `main`（仅工作区未跟踪）。合并后 `main` 的 MCP server 加载即失败。307/307 PASS 是脏工作区结果，不是 commit 结果。

### 合并前必须完成（任一未做即不可合并）
1. **提交 `servers/opentrons-mcp/lib/suffix-monitor.js`** 与 `test/suffix-monitor.test.js`（解除硬阻断）。
2. **提交 `servers/opentrons-mcp/lib/probe.js` 的工作区改动**（+276：`heightMmToVolumeUl` 等），否则 commit 内 height→volume 静默失效、与 09c 声明不符。
3. **提交未跟踪探针测试**：`probe-height-volume.test.js`、`apply-liquid-probe-results-mcp.test.js`、`suffix-e2e-scenario.test.js`（否则 trust/pending/suffix/height 在 commit 内无覆盖）。
4. **裁决 outbox-wake 未提交文件**（`lib/runtime-watch/outbox-tick.js`、`test/consume-runtime-outbox.test.js`、`lib/runtime-outbox.js`、`lib/runtime-watch/watch-loop.js`、`lib/liquid-source-substitution.js` 等）：要么并入本分支，要么明确排除并确认 commit 内 `watch-loop.js` 不引用 `outbox-tick.js`（已确认 commit 快照不引用）。
5. **在干净 worktree 中、于新 commit tip 重跑 `node --test`**，确认 307/307 在**提交快照**（而非脏工作区）成立；建议 upload worker 合并前同样在隔离 worktree 验证一次。

### 非阻断但建议
- `docs/MCP_TOOLS.md` 本地 pending 契约与远程 batch schema 文案可再对齐（09c 已记）。
- 真机 V2 writeback 回归报告仍 open（ROADMAP）。
- `verify-setup` 的 vision 依赖 warning 与本整合无关，沿用 GPT-5.5 结论。

---

## 6. 给 upload worker 的指令

**不要**直接合并 `9080166` 到 `main` 并 push。需先在 `feature/probe-integration` 上补提上述第 1–3 项（必要时含第 4 项），形成新 tip，在隔离 worktree 复测 307/307 且 `index.js` 可正常 import 后，再由 composer 合并 `main` 并 push GitHub。

---

## 附：复核可复现命令

```bash
# 工作区全量
cd servers/opentrons-mcp && node --test          # 307/307（脏树）

# commit 快照隔离验证
git worktree add --detach /tmp/pcc 9080166
ln -s $PWD/servers/opentrons-mcp/node_modules /tmp/pcc/servers/opentrons-mcp/node_modules
cd /tmp/pcc/servers/opentrons-mcp && node --test   # 130 pass / 33 fail
node -e "import('./index.js')" 2>&1 | rg ERR_MODULE_NOT_FOUND   # suffix-monitor.js

# import 完整性扫描（commit 快照）
git -C /tmp/pcc ls-files '*.js' | …  # 仅 index.js -> ./lib/suffix-monitor.js 缺失

# 安全
git diff main...feature/probe-integration -- LICENSE CITATION.cff   # 空
git diff main...feature/probe-integration | rg -i "api_key|secret|token|password|private_key|AKIA|ghp_"   # 仅函数名上下文行
```
