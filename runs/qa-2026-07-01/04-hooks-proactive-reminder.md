# 插件 Hook 与主动提醒调研（2026-07-01）

## ① 结论先行

**插件能否自带 Hook、三平台通用自动唤起？**  
三平台在 2026 年文档层面都支持「插件包内带 Hook」，但**没有单一、开箱即用的跨平台通用自动唤起**；本仓目前**未配置任何 Hook**，主动唤醒依赖 MCP outbox + 各宿主侧额外接线（Hook、`/loop`、Monitor、外部 cron/webhook），且 Codex 插件 Hook 加载、Claude VS Code 插件 Hook、Cursor 长间隔 `/loop` 等仍有已知缺口。

**当前主动提醒是否 CLI-only？**  
**不是设计上 CLI-only**：MCP 在任意宿主下都能生成 outbox 并投递到 `claudecode`/`cursor`/`codex`/`cli`/`webhook` 适配器；但**能真正「无人输入就唤醒 Agent」** 仍主要依赖宿主能力（Cursor `/loop`、Claude CLI Monitor、Codex Hook/外部轮询），**IDE 内没有插件自带的消费端**，因此多数场景下 operator 仍需手动起一轮对话或跑 CLI 监控脚本。

---

## ② 三平台 Hook / 自动唤起能力对照

| 维度 | Cursor | Claude Code | Codex |
|------|--------|-------------|-------|
| **插件能否自带 Hook** | **能**。官方 Plugins 文档将 Hooks 列为可打包组件；`hooks.json` 可随 `.cursor-plugin/` 分发，脚本路径可用 `${CURSOR_PLUGIN_ROOT}`。 | **能**。`hooks/hooks.json` 在插件启用时与用户/项目 Hook 合并；另有实验性 **`monitors/monitors.json`**（会话启动或 skill 首次调用时自动拉起后台进程，stdout 行作为通知）。 | **文档称能**（`hooks/hooks.json` 或 `plugin.json` 的 `hooks` 字段）；但 OpenAI/codex#17331 报告**插件 manifest 的 hooks 未进入运行时 discovery**，需以实测为准。 |
| **自动唤起方式（IDE）** | Agent 生命周期 Hook（`sessionStart`、`stop`、`workspaceOpen` 等）；内置 **`/loop`** skill（本地定时间隔/目标驱动）；**Cloud Automations**（云端 cron/PR/Slack 等，与本地 `/loop` 分离）。 | Hook 事件（`Stop`、`UserPromptSubmit`、`SessionStart` 等）；**Plugin Monitors**（CLI 会话自动 arm）。VS Code 扩展对**插件内 `hooks.json` 有未完全加载的 bug 报告**（anthropics/claude-code#18547）。 | 项目/用户 `hooks.json` 或 `config.toml [hooks]`；`Stop`/`UserPromptSubmit` 等可续跑；**无一等公民 `/loop`**（需 Hook + 外部 sleep 或 MCP `runtime_watch_loop`）。 |
| **自动唤起方式（CLI）** | Cursor CLI 同样可用 `/loop` + 后台 shell sentinel 唤醒。 | CLI 完整支持插件 Hook + Monitor；`/hooks` 查看已加载项。 | `codex` CLI + `~/.codex/hooks.json`；`/hooks` 审查与信任；非 managed Hook 需人工 trust。 |
| **自动唤起方式（Cloud）** | **Cloud Agents** 可执行仓库根 `.cursor/hooks.json` 中的 command Hook（子集）；**Automations** 为独立云端调度，可接 MCP/webhook。 | Cloud / 非交互场景 Monitor **不可用**（文档：仅 interactive CLI）。 | 以本地/企业 `requirements.toml` managed hooks 为主；云 Agent 能力因产品形态而异。 |
| **与本插件 outbox 的契合** | 可写 Hook/`/loop` 轮询 `${PLUGIN_DATA}/host-adapters/cursor/<session>.jsonl` 或调用 `runtime_get_outbox`。 | 可用 Monitor 跑 `runtime-recovery-monitor.mjs` 或 tail adapter JSONL；Hook 在 `Stop` 时注入 context。 | 用户级 `~/.codex/hooks.json` 更可靠；插件内 Hook 待 Codex 运行时修复；webhook 适配器最稳。 |
| **主要瓶颈** | `/loop` 绑定本地会话（关 IDE 即停）；长间隔 background shell 有已知 bug；Hook 不能直接替代 MCP push UI。 | Monitor **仅 CLI**；VS Code 插件 Hook 加载不一致；企业 `disableAllHooks` 可封插件 Hook。 | 插件 Hook 加载存疑；Hook 需 trust；`PreToolUse` 等对非 Bash 工具覆盖不完整。 |

### 参考文档（2026）

- Cursor Hooks / Plugins：[cursor.com/docs/hooks](https://cursor.com/docs/hooks)、[cursor.com/docs/plugins](https://cursor.com/docs/plugins)、[cursor.com/changelog/shared-canvases](https://cursor.com/changelog/shared-canvases)（`/loop`）
- Cursor Cloud Automations：[cursor.com/docs/cloud-agent/automations](https://cursor.com/docs/cloud-agent/automations)
- Claude Code Hooks / Plugins：[code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)、[code.claude.com/docs/en/plugins-reference](https://code.claude.com/docs/en/plugins-reference)（含 Monitors）
- Codex Hooks：[developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks)

---

## ③ 本仓现状证据

### 3.1 平台配置文件：无 Hook / Automation / Trigger

已检查的清单文件**均未声明 hooks、monitors、automations 或 triggers**：

| 路径 | 内容摘要 |
|------|----------|
| `.claude-plugin/plugin.json` | `skills`、`mcpServers`、界面元数据；**无 `hooks` / `monitors`** |
| `.claude-plugin/mcp.json` | 仅 `opentrons-lab` MCP |
| `.claude-plugin/marketplace.json` | 市场条目 |
| `.codex-plugin/plugin.json` | `skills`、`mcpServers`、`policy`；**无 `hooks`** |
| `.codex-plugin/marketplace.json` | Codex 市场 |
| `.cursor-plugin/plugin.json` | `mcp`、`skills`、`rules`；**无 `hooks`** |
| `.cursor/mcp.json` | 工作区 MCP（`${workspaceFolder}` 路径） |
| `.cursor/rules/labscriptai-ot.mdc` | 安全/工作流规则，`alwaysApply: false` |
| `mcp.json` / `server.json` | 根级 MCP 服务定义 |
| `.codex/config.toml` | 本机 MCP 与 approval；**无 `[hooks]`** |

全仓 **`hooks.json`、`hooks/`、`monitors/` 文件不存在**（`Glob` 与 `Grep` 均为 0 匹配）。

`install-labscriptai-ot.sh` 仅 `npm install` + `verify-setup.mjs`，**不安装 Hook、不注册定时任务**。

### 3.2 主动提醒：MCP 侧已实现，宿主消费端未打包

架构在 `docs/GETTING_STARTED.md` 与 `policy/workflows.md` 中写清：

1. **事件源**：`runtime_recovery_monitor`、`runtime_watch_poll`、`runtime_watch_loop`（goal auto-wake）在 tick 时写入 durable **alert/outbox**。
2. **投递**：`runtime_deliver_outbox` / `notify_adapters` 将事件送到适配器：
   - `claudecode` / `codex` / `cursor` → 追加 JSONL 到 `host-adapters/<adapter>/<session_id>.jsonl`（默认根目录 `${PLUGIN_DATA}/host-adapters`）
   - `cli` → 可打印短消息
   - `webhook` → HTTP POST
3. **关键限制**（`docs/GETTING_STARTED.md` L473）：

   > MCP cannot force every host UI to open a new chat message by itself; each host must either expose a notification API or run a small hook/adapter that consumes the outbox.

4. **设计意图**（`docs/ROADMAP-virtual-lab.md` L31）：

   > The host IDE watches its adapter outbox file and wakes the agent on each sentinel.

5. **实现证据**：
   - `servers/opentrons-mcp/lib/runtime-outbox.js` — `deliverToAdapter()` 对三 IDE 适配器仅 **append JSONL 文件**，无 UI push API。
   - `skills/opentrons-experiment-goal/SKILL.md` — 描述 `/loop` + `/goal` 模式，agent 被 sentinel 唤醒后读 `runtime_get_outbox`。
   - `scripts/runtime-recovery-monitor.mjs` — CLI 包装器，支持 `--cycles`、`--notify-adapters`；Markdown 输出含「**主动提醒**」节（统计 outbox 发布与投递，非 IDE 弹窗）。

**结论**：本插件的「主动提醒」= **MCP 生成 + 文件/webhook 投递**；**不是** MCP server 向 IDE 主动 push 聊天消息。跨宿主「自动唤起」在文档层预留了 adapter 邮箱，但**仓库内没有配套的 host hook/loop 脚本**。

### 3.3 与 preflight / gate 的关系

- **Preflight / simulation gate**：工作流规则（`AGENTS.md`、`policy/workflows.md`）要求 simulate → live_readiness → opt-in；这是 **skill/MCP 调用链**，不是 Hook 自动触发。
- Hook 可用于「会话开始自动 preflight」「工具调用前 gate」，但**当前未实现**。

---

## ④ 可行路径建议

在「平台不允许或不可靠地加载插件内 Hook」的前提下，推荐 **「MCP outbox 为单一真相 + 分平台薄消费层」**，而不是指望一份 `hooks.json` 三端 identical。

### 路径 A：插件内分平台 Hook 包 + 安装脚本兜底（推荐）

1. **在插件根增加可分发组件**（未来 PR，本次调研未改代码）：
   - `hooks/cursor/hooks.json` + `scripts/consume-runtime-outbox.sh`（`workspaceOpen` / `stop` 或配合文档引导用户 `/loop`）
   - `hooks/claude/hooks.json`（`SessionStart` / `Stop` 注入 outbox context）
   - `hooks/codex/hooks.json`（同上；manifest `hooks` 字段指向该路径）
   - `monitors/monitors.json`（Claude）：`command` 跑 `node scripts/runtime-recovery-monitor.mjs --cycles N --notify-adapters cli`，`when: "on-skill-invoke: opentrons-experiment-goal"`
2. **`install-labscriptai-ot.sh` 可选步骤**：
   - Codex：若插件 Hook 未加载，**复制/合并**到 `~/.codex/hooks.json`（文档已说明 user 层最稳）
   - Claude VS Code：若插件 Hook 不 fire，合并到 `.claude/settings.json`
   - Cursor：依赖 marketplace 插件加载；或提示用户在项目 `.cursor/hooks.json` symlink 到插件 `hooks/cursor/`
3. **统一消费逻辑**：脚本只读 `runtime_get_outbox` 或 tail `host-adapters/<host>/<session>.jsonl`，输出 Hook 要求的 JSON `additionalContext` / sentinel，唤醒 agent 执行 `opentrons-experiment-goal` 协议。

### 路径 B：运维层 webhook + 外部调度（最不依赖 IDE）

1. 监控/goal loop 开启 `notify_adapters: ["webhook"]`，指向自建 receiver（Slack/企业微信/cron worker）。
2. Receiver 再触发：Cursor Cloud Automation、Claude 通知、或人工 on-call——适合 **7×24 机台旁无人盯 IDE** 的场景。
3. 本地 IDE 会话仍可用 `runtime_get_alerts` 手动拉取，不依赖 Hook。

### 路径 C：文档与 skill 引导（零配置、半自动）

1. 在 `docs/GETTING_STARTED.md` 增加「Unattended wake」小节：明确 **arm `runtime_watch_loop` → 宿主 `/loop` 或 Monitor → 读 outbox** 的三步配方。
2. `opentrons-experiment-goal` skill 已定义 agent 协议；operator 说「盯到跑完」时 agent 自行 arm loop + 建议 `notify_adapters`。
3. 适合能接受 **「半自动」**（需一次人工启动 loop/monitor）的 lab 场景。

### 跨平台「通用」的现实边界

| 能力 | 能否三端同一套配置 | 说明 |
|------|-------------------|------|
| MCP outbox 事件格式 | **能** | 已是宿主无关 |
| Hook JSON schema | **不能** | Cursor / Claude / Codex 字段与事件名不同 |
| 自动唤醒语义 | **部分** | 均需本地会话或 cloud automation；无统一 push API |
| Preflight 自动跑 | **能（分端实现）** | `sessionStart` / `workspaceOpen` / Monitor 各写一条 command |
| 出错自动恢复 | **能（受安全模型约束）** | `runtime_watch_loop` + goal skill；L0 以上仍需 opt-in |

---

## 附录：调研方法

- 全量读取 `.claude-plugin/`、`.codex-plugin/`、`.cursor-plugin/`、`.cursor/`、`mcp.json`、`server.json`、`.codex/config.toml`
- 仓库内检索：`hook`、`notify`、`outbox`、`/loop`、`主动`、`preflight`、`runtime_deliver_outbox` 等
- WebSearch / 官方文档（查询词含 **2026**）：Cursor Hooks & Plugins & `/loop` & Automations；Claude Code Hooks & Plugin Monitors；Codex Hooks & plugin-bundled hooks issue

---

*调研产出路径：`runs/qa-2026-07-01/04-hooks-proactive-reminder.md`*
