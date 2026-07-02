# Probe Commit Fix — GLM-5.2 REJECT Remediation

**Repository:** `/Users/gaoyuan/Documents/test/Flexagent/labscriptai-ot`  
**Branch:** `feature/probe-integration`  
**Prior tip:** `9080166` (GLM-5.2 REJECT — missing `suffix-monitor.js`, uncommitted `probe.js` / tests)  
**New tip:** `4cc3672`  
**Worker:** probe-commit-fix  
**Date:** 2026-07-02  

---

## 1. 修复前 `git status`（探针 / 三把锁 / outbox-wake 相关）

### 已跟踪未提交（`M`）

| 文件 | 类别 |
|---|---|
| `servers/opentrons-mcp/lib/suffix-monitor.js` | —（当时为 `??`，见下） |
| `servers/opentrons-mcp/lib/probe.js` | 探针 height→volume |
| `servers/opentrons-mcp/lib/liquid-source-substitution.js` | suffix 联动 |
| `servers/opentrons-mcp/lib/runtime-outbox.js` | outbox-wake |
| `servers/opentrons-mcp/lib/runtime-watch/watch-loop.js` | outbox-wake |
| `servers/opentrons-mcp/test/liquid-source-substitution.test.js` | suffix 测试 |
| `servers/opentrons-mcp/test/runtime-outbox.test.js` | outbox |
| `servers/opentrons-mcp/test/runtime-watch.test.js` | outbox |
| `servers/opentrons-mcp/test/state.test.js` | trust 守卫 |
| `install-labscriptai-ot.sh` | install 补丁 |
| `scripts/runtime-recovery-monitor.mjs` | runtime watch |
| `docs/GETTING_STARTED.md`, `docs/MCP_TOOLS.md`, `docs/ROADMAP-virtual-lab.md` | 文档 |
| `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` | 平台 hooks 入口 |

> `servers/opentrons-mcp/lib/state.js`（trust 守卫）已在 `9080166` 内提交，工作区无额外 diff。

### 未跟踪（`??`）

| 文件 | 类别 |
|---|---|
| `servers/opentrons-mcp/lib/suffix-monitor.js` | **硬阻断** — `index.js` 静态导入 |
| `servers/opentrons-mcp/lib/runtime-watch/outbox-tick.js` | outbox-wake |
| `servers/opentrons-mcp/test/suffix-monitor.test.js` | 三把锁单元 |
| `servers/opentrons-mcp/test/probe-height-volume.test.js` | height→volume |
| `servers/opentrons-mcp/test/apply-liquid-probe-results-mcp.test.js` | MCP 单孔/pending |
| `servers/opentrons-mcp/test/suffix-e2e-scenario.test.js` | 三把锁 E2E |
| `servers/opentrons-mcp/test/consume-runtime-outbox.test.js` | outbox consumer |
| `scripts/consume-runtime-outbox.mjs`, `scripts/arm-runtime-watch.sh`, `scripts/install-codex-hooks.mjs` | outbox 脚本 |
| `hooks/**` | Cursor/Claude/Codex/OpenCode/Pi outbox-wake |
| `docs/outbox-wake-pi-opencode.md` | outbox 文档 |
| `runs/outbox-wake/01-03*.md` | outbox 设计记录 |
| `runs/qa-2026-07-01/04,07,08,09a,09b,10,11*.md` | QA 报告 |

### 刻意未 add

- `runs/self-recovery/artifacts/**`（大量 json）
- `.plugin-data/`, `.DS_Store`, `cas-siat-report/`
- 无关 runs：`embodied-lab-copilot/`, `industry-forecast-*/`, `live-validation/`, `tip-iterator-probe/`
- `runs/qa-2026-07-01/01-03,05-06`（非本修复范围）

---

## 2. 新 commit `4cc3672` 补入内容

**Message:** `Add missing probe suffix-monitor, height→volume, and outbox-wake closure.`  
**Stats:** 47 files, +6542 / −26  

### 核心源码

- `servers/opentrons-mcp/lib/suffix-monitor.js` — suffix 三锁模块（解除 `ERR_MODULE_NOT_FOUND`）
- `servers/opentrons-mcp/lib/probe.js` — `heightMmToVolumeUl`、`lookupLabwareGeometry`、`APPROXIMATE_LABWARE_GEOMETRY`
- `servers/opentrons-mcp/lib/runtime-watch/outbox-tick.js` + `watch-loop.js` / `runtime-outbox.js` 改动
- `servers/opentrons-mcp/lib/liquid-source-substitution.js` — suffix sufficiency 联动

### 测试（+39 例左右，使 commit 快照可达 307）

- `test/suffix-monitor.test.js` (6)
- `test/probe-height-volume.test.js` (7)
- `test/apply-liquid-probe-results-mcp.test.js` (7)
- `test/suffix-e2e-scenario.test.js` (5)
- `test/consume-runtime-outbox.test.js` (14)
- 既有测试文件增量：`liquid-source-substitution`, `runtime-outbox`, `runtime-watch`, `state`

### outbox-wake / install / docs

- `hooks/**`, `scripts/consume-runtime-outbox.mjs`, `arm-runtime-watch.sh`, `install-codex-hooks.mjs`
- `install-labscriptai-ot.sh`, `docs/*`, 平台 `plugin.json`

### QA 报告

- `runs/qa-2026-07-01/04,07,08,09a,09b,10,11*.md`
- `runs/outbox-wake/01-03*.md`

**Amend 决策：** 未 amend `9080166`（HEAD 非本 worker 创建）→ 新 commit。

---

## 3. 干净 worktree 验证

### 3a. 用户给定命令（无 symlink）

```bash
git worktree add /tmp/labscriptai-ot-verify HEAD   # → 4cc3672
cd /tmp/labscriptai-ot-verify/servers/opentrons-mcp && node --test
```

| 指标 | 结果 |
|---|---|
| `index.js` import | **FAIL** — 缺 `node_modules`（`@modelcontextprotocol/sdk`） |
| 测试 | **166 pass / 35 fail** |

根因：`node_modules` 与 `.venv` 均未纳入 git（与 GLM 复核 `9080166` 时相同）。

### 3b. 隔离 worktree + 环境 symlink（与 GLM 11 节 `node_modules` 做法一致，并补 `.venv`）

```bash
git worktree add /tmp/labscriptai-ot-verify HEAD
ln -s $REPO/servers/opentrons-mcp/node_modules /tmp/labscriptai-ot-verify/servers/opentrons-mcp/node_modules
ln -s $REPO/.venv /tmp/labscriptai-ot-verify/.venv
cd /tmp/labscriptai-ot-verify/servers/opentrons-mcp
node -e "import('./index.js')"   # → index.js OK
node --test                       # → 307 pass / 0 fail ✅
git worktree remove /tmp/labscriptai-ot-verify --force
```

| 检查项 | 结果 |
|---|---|
| `index.js` 可加载 | **PASS** |
| 全量 `node --test` | **307 / 307 PASS** |
| 探针子集 | 46/46 PASS（与 GPT-5.5 报告一致） |

> 无 `.venv` symlink 时单独剩 1 fail：`prepare_liquid_source_substitution_recovery`（真实 `simulate_protocol` 需 Opentrons Python）。

---

## 4. 结论

| 项 | 状态 |
|---|---|
| GLM REJECT 根因（`suffix-monitor.js` 缺失） | **已修复** — 已入 `4cc3672` |
| `heightMmToVolumeUl` 未提交 | **已修复** |
| 探针 / suffix / outbox 测试未跟踪 | **已修复** |
| commit 快照 307/307（含 node_modules + .venv symlink） | **PASS** |
| push | **未执行**（留给 upload worker） |

### 仍缺 / 留给 upload worker

1. **worktree 裸跑** 需 `npm install` + `install-labscriptai-ot.sh`（或 symlink `node_modules` + `.venv`）——非源码缺陷。
2. 未纳入本 commit 的 QA runs：`01-03`, `05-06`（virtual-lab / tactile / sync）。
3. `runs/self-recovery/artifacts/**`、`cas-siat-report/` 等按指令排除。
4. upload worker 合并前建议在隔离 worktree 用 symlink 或完整 install 再验一次 `307/307`。

---

## 附：可复现

```bash
git checkout feature/probe-integration
git log -1 --oneline   # 4cc3672

git worktree add /tmp/labscriptai-ot-verify HEAD
REPO=/Users/gaoyuan/Documents/test/Flexagent/labscriptai-ot
ln -s $REPO/servers/opentrons-mcp/node_modules /tmp/labscriptai-ot-verify/servers/opentrons-mcp/node_modules
ln -s $REPO/.venv /tmp/labscriptai-ot-verify/.venv
cd /tmp/labscriptai-ot-verify/servers/opentrons-mcp && node --test
git -C $REPO worktree remove /tmp/labscriptai-ot-verify --force
```
