# Worker 3：piagent + opencode + 五端统一 Outbox Wake 方案

> 仓库：`labscriptai-ot`  
> 范围：在现有 MCP outbox（`runtime_get_outbox` / `runtime_deliver_outbox` / `runtime_watch_loop`）之上，补齐 **Pi Coding Agent** 与 **OpenCode** 的主动唤醒，并给出 Cursor / Claude Code / Codex / Pi / OpenCode 五端可打进插件的统一打包方案。  
> 状态：调研 + 设计稿（尚未落地 `hooks/` 与 `consume-runtime-outbox.mjs`）

---

## 1. 调研结论

### 1.1 Pi Coding Agent（用户所称 **piagent**）

| 维度 | 结论 |
|------|------|
| **是什么** | 开源终端 AI coding agent（[pi.dev](https://pi.dev)、[pi-mono](https://github.com/badlogic/pi-mono) / `@mariozechner/pi-coding-agent`）。TUI 驱动、模型无关、2025–2026 与 Claude Code / Aider / OpenCode 同属「CLI agent」赛道。 |
| **MCP** | **核心不内置**；官方倾向轻量 prompt。社区扩展：`pi-mcp-adapter`、`0xKobold/pi-mcp`、`irahardianto/pi-mcp-extension`。配置：`~/.pi/agent/mcp.json` 或项目 `.pi/mcp.json`（需信任项目 + 安装扩展）。 |
| **Skills** | 原生支持；`settings.json` 的 `skills` 数组 + 自动发现 `~/.pi/agent/skills/`、`.pi/skills/`、`.agents/skills/`。 |
| **Hooks / 扩展** | **TypeScript Extensions** 为一等公民：`pi.on('agent_end' \| 'tool_execution_end' \| 'session_start' …)`；发现路径 `~/.pi/agent/extensions/`、`.pi/extensions/`，或在 `settings.json` → `extensions`。2026 初已合并 hooks + custom tools 为统一 extensions（`--extension` / `-e`）。 |
| **Claude Code 兼容 hooks** | 社区 `pi-autohooks` / `hsingjui/pi-hooks`：把 Claude Code 的 `PreToolUse` / `PostToolUse` / `Stop` 映射到 Pi 事件；**Stop → `agent_end`**，可用 `decision: "block"` + hidden context 触发下一轮（`sendMessage(..., { triggerTurn: true })`）。 |
| **Continuation 注入** | 扩展内 `ctx.sendMessage(text, { triggerTurn: true })`；或 Stop 类 hook 返回 `reason` / `additionalContext`。需用 `stop_hook_active` 防无限循环。 |
| **后台监控** | Pi **无**内置「守护进程 + 自动开新 session」；需 **外部** `arm-runtime-watch.sh` 轮询 MCP/CLI monitor，把事件写入 `host-adapters/piagent/*.jsonl`，再由 **扩展在 `agent_end` 读邮箱** 或 **webhook → 本地 HTTP → 扩展** 唤醒。 |
| **缺什么** | 无官方 outbox/mailbox；无 JSON `hooks.json` 一等配置（需 TS 扩展或第三方 pi-hooks）；MCP 需额外装扩展；无 GUI「弹出新聊天」API——只能靠再开一轮 agent turn。 |

**一句话**：Pi 有成熟的 **TS 扩展 + 可选 Claude 兼容 shell hooks**，MCP 靠社区包，**wake 要靠我们自己的 extension 读 outbox 邮箱或 webhook，在 `agent_end` 里 `sendMessage` 续跑**。

### 1.2 OpenCode

| 维度 | 结论 |
|------|------|
| **是什么** | SST/Anomaly 维护的开源多模型 coding agent（[opencode.ai](https://opencode.ai)、[anomalyco/opencode](https://github.com/anomalyco/opencode)）。TUI + Desktop + VS Code/Cursor/Zed 扩展；2025-04 起快速迭代，2026 已是主流 CLI agent 之一。 |
| **MCP** | **原生**：`opencode.jsonc` → `mcpServers`（stdio、streamable-http）；与 Claude Desktop 配置可桥接（`opencode-claude-code-bridge`）。 |
| **Skills** | **原生**；`~/.config/opencode/skills/`、`.opencode/skills/`，并 **兼容** `.claude/skills/`。 |
| **Hooks** | **TypeScript Plugin**（非 JSON shell）：`tool.execute.before` / `tool.execute.after`、`session.idle`、`session.created`、`stop`、`event` 等 24+ 事件；项目 `.opencode/plugin/` 或 `opencode.jsonc` → `plugin` / `plugins`。 |
| **Continuation 注入** | Plugin 内 `await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "..." }] } })`；或 `stop` hook 在 agent 停顿时注入。社区模式：`session.idle` + todo-continuation（Oh My OpenCode 的 boulder 机制）。 |
| **后台监控** | 同 Pi：**外部** monitor 写 outbox；OpenCode plugin 在 **`session.idle` / `stop`** 调 `consume-runtime-outbox.mjs --adapter opencode` 决定是否 `session.prompt`。长轮询可配合 `arm-runtime-watch.sh`。 |
| **缺什么** | 无与 Claude Code 相同的 declarative `hooks.json`；plugin 需 TS 编译/加载；MCP 工具的 `tool.execute.after` 对 MCP 与 native 工具行为略有差异（[#25918](https://github.com/anomalyco/opencode/issues/25918) 已澄清两条路径）；无跨 session 强制 UI 聚焦 API。 |

**一句话**：OpenCode **原生 MCP + Skills + TS 插件**，最适合用 **`.opencode/plugin/labscriptai-outbox-wake.ts` 在 `session.idle`/`stop` 消费 outbox 并 `session.prompt` 续跑**，无 hook 时走 webhook。

### 1.3 与 Claude Code / Codex / Cursor 的相似点

| 能力 | Claude Code | Codex | Cursor | Pi | OpenCode |
|------|-------------|-------|--------|-----|----------|
| MCP | 原生 | 原生（`.mcp.json`） | 原生 | 扩展 | 原生 |
| Skills | 原生 | 插件 manifest | rules + skills 目录 | 原生 | 原生 + `.claude/skills` |
| 生命周期 hook | JSON + shell（29 事件） | TOML/插件（heartbeat 等） | `hooks.json` + shell | TS extensions + 可选 CC 兼容 | TS plugins |
| Stop 后续跑 | `Stop` hook | heartbeat / hook | `stop` → `followup_message` | `agent_end` → `sendMessage` | `session.idle` / `stop` → `session.prompt` |
| 本仓库已有投递 | `host-adapters/claudecode/` | `host-adapters/codex/` | `host-adapters/cursor/` | **待增** `piagent/` | **待增** `opencode/` |

现有 MCP 侧已实现：`runtime-outbox.js` 向 `claudecode|codex|cursor` 追加 JSONL（`deliverToAdapter`），以及 `webhook`、`cli`。**缺**：`piagent` / `opencode` adapter 名、消费脚本、各端薄 hook。

---

## 2. 五端对照表

| 端 | 配置入口 | Wake 触发点 | Continuation 载体 | Outbox 邮箱路径 | 无 hook 时 fallback |
|----|----------|-------------|-------------------|-----------------|---------------------|
| **Cursor** | `.cursor/hooks.json` | `stop`（`wake:true` 时） | `followup_message` | `.plugin-data/host-adapters/cursor/{session}.jsonl` | `webhook` → 本地 `scripts/outbox-webhook-relay.mjs` 写邮箱；或 cron `consume-runtime-outbox.mjs --adapter cursor --emit stdout` 人工粘贴 |
| **Claude Code** | `.claude-plugin/` + 项目 `hooks/` 或 `.claude/settings.json` hooks | `Stop` | `decision:block` + `reason` | `host-adapters/claudecode/{session}.jsonl` | Codex/CLI 同 webhook；Claude `UserPromptSubmit` 无法自动——靠 **monitors.json 后台 deliver** + 下次打开会话读邮箱 |
| **Codex** | `.codex-plugin/` + `.codex/config.toml` hooks | plugin heartbeat / `stop` 等价 | heartbeat 注入 continuation 文本 | `host-adapters/codex/{session}.jsonl` | `OPENTRONS_RUNTIME_ALERT_WEBHOOK_URL`；或 `runtime-recovery-monitor.mjs --notify-adapters webhook` |
| **Pi** | `.pi/settings.json` → `extensions` | `agent_end`（扩展） | `sendMessage(..., { triggerTurn: true })` | `host-adapters/piagent/{session}.jsonl` | **webhook** → `hooks/piagent/webhook-relay.ts`；或 **纯 shell**：`agent_end` 调 `node …/consume-runtime-outbox.mjs` |
| **OpenCode** | `opencode.jsonc` → `plugin` | `session.idle` / `stop` | `client.session.prompt(...)` | `host-adapters/opencode/{session}.jsonl` | webhook；或 `arm-runtime-watch.sh` + `--notify-adapters webhook,cli` |

**统一语义**（已有，`docs/MCP_TOOLS.md`）：

- `event.wake === true` → 宿主应开新一轮 agent turn  
- `event.wake === false`（`kind: heartbeat`）→ 只记日志，不唤醒  
- `needs_user` / `hard_stop` **必须** wake  

---

## 3. 统一架构

```
┌─────────────────────────────────────────────────────────────────┐
│ MCP server (opentrons-mcp)                                       │
│  runtime_watch_loop / runtime_recovery_monitor                   │
│    → runtime-outbox (canonical): .plugin-data/runtime-outbox/  │
│    → runtime_deliver_outbox(adapters=[...])                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │ append JSONL delivery records
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ host-adapters/  (per-adapter mailbox — NOT source of truth)      │
│   cursor/ claudecode/ codex/ piagent/ opencode/                  │
│   {session_id}.jsonl  ← { delivered_at, adapter, event }           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
 consume-runtime-outbox.mjs (平台无关)
   --adapter cursor|claudecode|codex|piagent|opencode
   --session-id … --cursor-file … --ack
         │
         ▼
  continuation payload (JSON stdout)
    { action: "wake"|"noop", prompt, outbox_id, kind, … }
         │
    ┌────┴────┬────────────┬────────────┐
    ▼         ▼            ▼            ▼
 Cursor    Claude/Codex    Pi ext     OpenCode plugin
 stop      Stop/heartbeat  agent_end  session.idle
```

**原则**

1. **Canonical outbox** 只在 `PLUGIN_DATA/runtime-outbox/{session}/outbox.jsonl`；adapter 邮箱是 **投递副本**，便于无 MCP 时 hook 只读文件。  
2. **`consume-runtime-outbox.mjs`** 是唯一「读邮箱 → 判 wake → 格式化 continuation → ack」的实现；各端 hook **只调这一条命令**，不复制业务逻辑。  
3. **`arm-runtime-watch.sh`** 是唯一「后台 monitor + deliver」入口；与 IDE 是否打开无关。  
4. 新增 adapter 时只改：`runtime-outbox.js` 的 `DEFAULT_ADAPTERS` + `deliverToAdapter` + consume 的 prompt 模板表。

---

## 4. `consume-runtime-outbox.mjs` 接口设计

### 4.1 CLI

```bash
node scripts/consume-runtime-outbox.mjs \
  --adapter cursor|claudecode|codex|piagent|opencode|webhook-relay \
  --session-id self-recovery-liquid \
  [--run-id <run-id>] \
  [--host-adapter-dir "$PLUGIN_DATA/host-adapters"] \
  [--outbox-dir "$PLUGIN_DATA/runtime-outbox"] \
  [--cursor-file "$PLUGIN_DATA/host-adapters/cursor/.consume-cursor.json"] \
  [--limit 5] \
  [--include-heartbeats] \
  [--ack] \
  [--format json|text|cursor-stop|claude-stop|pi-message|opencode-prompt] \
  [--dry-run]
```

| Flag | 说明 |
|------|------|
| `--adapter` | 读 `host-adapters/{adapter}/{session}.jsonl`；决定默认 `--format` |
| `--cursor-file` | 每 adapter 持久化 `{ last_line, last_outbox_id }`，避免重复 wake |
| `--ack` | 成功后调 MCP `runtime_ack_outbox`（或直写 outbox.jsonl 的 `acked_at`） |
| `--format` | 各端薄适配器解析 stdout；默认随 adapter 映射 |
| `--dry-run` | 打印将 wake 的 event，不写 cursor、不 ack |

### 4.2 退出码

| Code | 含义 |
|------|------|
| `0` | 有 `wake:true` 事件并已输出 continuation |
| `1` | 错误（路径不存在、JSON 损坏） |
| `2` | 无新事件或仅 `wake:false` heartbeat（**正常空闲**） |

### 4.3 输出 JSON（`--format json`，默认）

```json
{
  "action": "wake",
  "adapter": "opencode",
  "outbox_id": "uuid",
  "kind": "blocked",
  "session_id": "self-recovery-liquid",
  "run_id": "abc123",
  "prompt": "【LabscriptAI runtime wake】kind=blocked …\n下一步：runtime_get_outbox → safe_next_action …",
  "recommended_next_tool": "safe_next_action",
  "no_robot_motion": true,
  "source_line": 42
}
```

`action: "noop"` 时 `prompt` 为空，exit `2`。

### 4.4 Adapter → 默认 format → 宿主动作

| adapter | default format | 宿主解析 |
|---------|----------------|----------|
| `cursor` | `cursor-stop` | `{ "followup_message": "<prompt>" }` |
| `claudecode` | `claude-stop` | `{ "decision": "block", "reason": "<prompt>" }` |
| `codex` | `text` | heartbeat handler 把 stdout 当下一条 user message |
| `piagent` | `pi-message` | 扩展读 JSON → `sendMessage(prompt, { triggerTurn: true })` |
| `opencode` | `opencode-prompt` | 插件读 JSON → `session.prompt` |
| `webhook-relay` | `json` | 中继服务再 fan-out |

**Prompt 模板**（所有 adapter 共享正文，仅包装不同）引用 `skills/opentrons-experiment-goal/SKILL.md` 的单行状态协议 + `recommended_next_tool`。

### 4.5 实现要点

- 依赖：仅 Node 内置 + 可选动态 `import()` 本仓库 `servers/opentrons-mcp/lib/runtime-outbox.js` 做 ack（与 `runtime-recovery-monitor.mjs` 一致）。  
- 去重：`dedupe_key` + cursor 文件 + `outbox_id`。  
- **只消费** `delivered_at` 晚于 cursor 且 `event.wake !== false` 的行；若行内无 `wake` 字段，回退 `requires_attention || kind !== 'heartbeat'`。

---

## 5. 各端薄适配器（插件目录建议）

```
hooks/
  cursor/
    hooks.json                 # stop → consume → followup_message
    runtime-outbox-stop.sh
  claude/
    hooks.json                 # Stop hook
    monitors.json              # 可选：后台 deliver 周期（Claude 无全局 daemon）
    runtime-outbox-stop.sh
  codex/
    hooks.json                 # 或 document config.toml [hooks] 片段
    runtime-outbox-heartbeat.sh
  piagent/
  pi-outbox-wake.ts            # Pi extension：agent_end 调 consume
    settings.fragment.json     # 合并到 .pi/settings.json 的 extensions 项
    webhook-relay.mjs          # fallback
  opencode/
    labscriptai-outbox-wake.ts # OpenCode plugin
    opencode.fragment.jsonc    # mcpServers + plugin 条目
scripts/
  consume-runtime-outbox.mjs   # 平台无关核心
  arm-runtime-watch.sh         # 后台 monitor
  outbox-webhook-relay.mjs     # 可选：POST in → 写多 adapter 邮箱
```

### 5.1 Cursor（`hooks/cursor/runtime-outbox-stop.sh`）

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENTRONS_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
OUT=$(node "$ROOT/scripts/consume-runtime-outbox.mjs" \
  --adapter cursor --session-id "${OPENTRONS_SESSION_ID:-default}" \
  --format cursor-stop --ack 2>/dev/null || true)
[ -z "$OUT" ] && exit 0
echo "$OUT"
```

`hooks.json`：`stop` → 上述脚本；`loop_limit: 5`。

### 5.2 Claude Code

同脚本，`--adapter claudecode --format claude-stop`。`monitors.json` 登记 `arm-runtime-watch.sh` 供 Claude 插件生态的 monitor 槽（若可用）。

### 5.3 Codex

Heartbeat / stop 钩子调 `--adapter codex --format text`；与现有 `.codex-plugin` manifest 并列文档化。

### 5.4 Pi（`hooks/piagent/pi-outbox-wake.ts` 骨架）

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    const root = process.env.OPENTRONS_PLUGIN_ROOT!;
    const session = process.env.OPENTRONS_SESSION_ID || "default";
    try {
      const { stdout } = await execFileAsync("node", [
        `${root}/scripts/consume-runtime-outbox.mjs`,
        "--adapter", "piagent",
        "--session-id", session,
        "--format", "json",
        "--ack",
      ]);
      const payload = JSON.parse(stdout);
      if (payload.action === "wake" && payload.prompt) {
        await ctx.sendMessage(payload.prompt, { triggerTurn: true });
      }
    } catch (e: any) {
      if (e?.code === 2) return; // noop
      ctx.ui.notify(`outbox consume: ${e.message}`, "warning");
    }
  });
}
```

`.pi/settings.json` 片段（installer 合并）：

```json
{
  "extensions": ["<OPENTRONS_PLUGIN_ROOT>/hooks/piagent/pi-outbox-wake.ts"],
  "skills": ["<OPENTRONS_PLUGIN_ROOT>/skills"]
}
```

`.pi/mcp.json`：stdio 指向 `servers/opentrons-mcp/index.js`（或引导用户装 `pi-mcp-extension`）。

### 5.5 OpenCode（`hooks/opencode/labscriptai-outbox-wake.ts` 骨架）

```typescript
import type { Plugin } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LabscriptaiOutboxWake: Plugin = async () => ({
  "session.idle": async (input) => {
    const root = process.env.OPENTRONS_PLUGIN_ROOT!;
    const session = process.env.OPENTRONS_SESSION_ID || "default";
    const sessionID = (input as { sessionID?: string }).sessionID;
    if (!sessionID) return;
    try {
      const { stdout } = await execFileAsync("node", [
        `${root}/scripts/consume-runtime-outbox.mjs`,
        "--adapter", "opencode",
        "--session-id", session,
        "--format", "json",
        "--ack",
      ]);
      const payload = JSON.parse(stdout);
      if (payload.action !== "wake") return;
      // client 由 OpenCode 注入到 plugin context
      await (input as any).client?.session?.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: payload.prompt }] },
      });
    } catch (e: any) {
      if (e?.code === 2) return;
    }
  },
});
```

`opencode.jsonc` 片段：

```jsonc
{
  "mcpServers": {
    "opentrons-lab": {
      "type": "stdio",
      "command": "node",
      "args": ["<OPENTRONS_PLUGIN_ROOT>/servers/opentrons-mcp/index.js"],
      "env": {
        "OPENTRONS_PLUGIN_ROOT": "<OPENTRONS_PLUGIN_ROOT>",
        "PLUGIN_DATA": "<PLUGIN_DATA>"
      }
    }
  },
  "plugin": ["<OPENTRONS_PLUGIN_ROOT>/hooks/opencode/labscriptai-outbox-wake.ts"]
}
```

### 5.6 Webhook fallback（Pi / OpenCode 无 hook 或 IDE 关闭）

```bash
export OPENTRONS_RUNTIME_ALERT_WEBHOOK_URL=http://127.0.0.1:18765/outbox
node scripts/outbox-webhook-relay.mjs --port 18765 \
  --fan-out piagent,opencode,cursor,claudecode,codex
```

Monitor 侧：

```bash
--notify-adapters webhook,piagent,opencode
```

Relay 将 POST body 的 `event` 写入各 adapter JSONL；**仍须**某处运行 consume（Pi/OpenCode 会话内 plugin，或 Cursor stop hook）。

---

## 6. `arm-runtime-watch.sh`

```bash
#!/usr/bin/env bash
# 用法：arm-runtime-watch.sh --session-id ID --robot-ip IP [--adapters ...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="${OPENTRONS_SESSION_ID:-default}"
ADAPTERS="${OPENTRONS_NOTIFY_ADAPTERS:-cursor,claudecode,codex,piagent,opencode,cli}"
# nohup 或 launchd/systemd user unit
exec node "$ROOT/scripts/runtime-recovery-monitor.mjs" \
  --session-id "$SESSION" \
  "$@" \
  --cycles 0 --interval-ms 30000 \
  --notify-adapters "$ADAPTERS" \
  --out "$ROOT/runs/self-recovery/artifacts/runtime-recovery-monitor-latest.json"
```

`--cycles 0` 表示无限（需在 monitor 脚本支持；若尚未支持则用大 cycles + 文档说明 cron）。

**职责**：只负责 **产事件 + deliver 到邮箱/webhook**；**不**直接调 LLM。Wake 由各端 hook/plugin 调 `consume-runtime-outbox.mjs` 完成。

---

## 7. MCP 侧增量（`runtime-outbox.js`）

```javascript
// DEFAULT_ADAPTERS 增加：
"piagent", "opencode"

// deliverToAdapter 增加：
if (["claudecode", "codex", "cursor", "piagent", "opencode"].includes(adapter)) {
  // 同现有 JSONL append
}
```

`runtime_watch_loop` / `runtime_recovery_monitor` 的 `notify_adapters` enum 同步扩展。  
`runtime-recovery-monitor.mjs` 的 `CONFIGURABLE_NOTIFY_ADAPTERS` 与 auto-detect 列表加入 `piagent`, `opencode`。

---

## 8. 插件打包清单

| 路径 | 动作 |
|------|------|
| `scripts/consume-runtime-outbox.mjs` | **新增** |
| `scripts/arm-runtime-watch.sh` | **新增** |
| `scripts/outbox-webhook-relay.mjs` | **新增**（可选） |
| `hooks/cursor/*` | **新增** |
| `hooks/claude/*` | **新增** |
| `hooks/codex/*` | **新增** |
| `hooks/piagent/*` | **新增** |
| `hooks/opencode/*` | **新增** |
| `servers/opentrons-mcp/lib/runtime-outbox.js` | **修改** adapter 列表 |
| `servers/opentrons-mcp/index.js` | **修改** tool schema enum |
| `scripts/runtime-recovery-monitor.mjs` | **修改** notify adapters |
| `install-labscriptai-ot.sh` | **修改** 打印 wake 指引 + 可选 `--enable-outbox-wake` |
| `docs/GETTING_STARTED.md` | **新增** § Unattended wake |
| `.pi/settings.json` / `opencode.jsonc` | **installer 生成片段**（不覆盖用户全文） |
| `docs/MCP_TOOLS.md` | 更新 adapter 表 |

**不打包**：用户机器上的 `~/.cursor`、`~/.pi/agent`、全局 `opencode.jsonc`——installer 只 **拷贝片段** 或 **print 合并说明**。

---

## 9. Install + GETTING_STARTED「Unattended wake」大纲（5 分钟）

### 9.1 `install-labscriptai-ot.sh` 增量（建议）

```bash
# 在 verify-setup 之后：
if [ "${LABSCRIPTAI_ENABLE_OUTBOX_WAKE:-}" = "1" ]; then
  bash "$PLUGIN_ROOT/scripts/install-outbox-wake.sh" --all
else
  echo "Optional unattended wake: docs/GETTING_STARTED.md#unattended-wake"
  echo "  LABSCRIPTAI_ENABLE_OUTBOX_WAKE=1 bash install-labscriptai-ot.sh"
fi
```

`install-outbox-wake.sh`：

1. `chmod +x scripts/arm-runtime-watch.sh hooks/*/*.sh`
2. 按 `--cursor|--claude|--codex|--pi|--opencode|--all` 复制/合并 hook 片段  
3. 写 `$PLUGIN_DATA/host-adapters/{adapter}/.gitkeep`  
4. 打印 `export OPENTRONS_SESSION_ID=…` 与一次自检命令  

### 9.2 GETTING_STARTED 新节大纲

```markdown
## Unattended wake（outbox）

Prerequisites: MCP `health_check` pass; `runtime_recovery_self_test` pass.

1. Set session env:
   export OPENTRONS_PLUGIN_ROOT=...
   export PLUGIN_DATA=.../.plugin-data
   export OPENTRONS_SESSION_ID=my-run

2. Enable your host adapter (pick one):
   - Cursor: copy hooks/cursor → .cursor/hooks.json
   - Claude Code: hooks/claude
   - Codex: hooks/codex + reload
   - Pi: merge .pi/settings.json extensions + trust project
   - OpenCode: merge opencode.jsonc plugin + mcpServers

3. Smoke test (no robot):
   node scripts/consume-runtime-outbox.mjs --adapter cursor --dry-run

4. Arm monitor after live run_id exists:
   bash scripts/arm-runtime-watch.sh --session-id $OPENTRONS_SESSION_ID --robot-ip $ROBOT_IP

5. Start goal loop (MCP):
   runtime_watch_loop(run_id, notify_adapters=["cursor","piagent"], zero_llm_when_no_error=true)

Safety: default observe-only; needs_user/hard_stop always wake; never bypass simulation gate.
```

### 9.3 五分钟路径（操作员）

| 分钟 | 操作 |
|------|------|
| 0–1 | `bash install-labscriptai-ot.sh` + `node scripts/verify-setup.mjs` |
| 1–2 | 选一个宿主，执行对应 `install-outbox-wake.sh --cursor`（或 `--pi` / `--opencode`） |
| 2–3 | `export OPENTRONS_SESSION_ID=test`；`consume-runtime-outbox.mjs --dry-run` |
| 3–4 | MCP：`runtime_recovery_self_test`；可选模拟 deliver：`runtime_deliver_outbox(adapters=["cursor"])` |
| 4–5 | 文档化 `arm-runtime-watch.sh` 启动；确认 stop/idle 能打出 `followup_message` 或 `session.prompt` |

---

## 10. 风险与约束

1. **MCP 不能强制 UI 开新聊天**——五端均依赖 hook/plugin 合作；无人值守时须 **monitor 进程 + 至少一个宿主会话** 在跑。  
2. **Pi MCP** 需用户安装扩展并信任项目；文档必须写清 `pi-mcp-extension` 或 `mcp.json` 路径。  
3. **OpenCode plugin** 需 `@opencode-ai/plugin` 类型；应用项目内 vendoring 或 `npx` 加载说明。  
4. **Loop 上限**：Cursor `loop_limit`、Pi `stop_hook_active`、OpenCode continuation backoff。  
5. **安全**：continuation prompt 必须带 `no_robot_motion` 与 `recommended_next_tool`；禁止在 consume 里自动 `--execute` 机器人动作。

---

## 11. 下午 MVP 建议（若 piagent / opencode 来不及）

**最小可交付三端：Cursor + Claude Code + Codex**

理由：

1. 三端已有 `host-adapters` 投递与 GETTING_STARTED 文档基础。  
2. 均为 **shell hook + `consume-runtime-outbox.mjs`**，无需 TS 插件打包/编译。  
3. `webhook` 已通，可作 Pi/OpenCode 的 **临时第四通道**（CLI 打印 prompt，人工或脚本粘贴）。

**第二阶段（+2 端）**：Pi extension + OpenCode plugin（可并行）；或 Pi/OpenCode 仅 **webhook + arm-runtime-watch** 直到插件就绪。

**验收标准（MVP）**：

- [ ] `runtime_deliver_outbox(adapters=["cursor"])` 写入 JSONL  
- [ ] `consume-runtime-outbox.mjs --adapter cursor` 在合成 `wake:true` 事件时 exit 0 并输出 `followup_message`  
- [ ] Cursor `stop` hook 链式触发一次续跑（模拟 session）  
- [ ] `arm-runtime-watch.sh` 30s 内 deliver + consume 不重复 ack 同一 `outbox_id`  

---

## 12. 参考链接

- Pi extensions: https://pi.dev/docs/latest/extensions  
- Pi settings: https://pi.dev/docs/latest/settings  
- pi-hooks (Claude compatible): https://github.com/hsingjui/pi-hooks  
- OpenCode docs: https://dev.opencode.ai/docs/  
- OpenCode plugin events: https://ccpkg.dev/assistants/opencode/  
- 本仓库：`servers/opentrons-mcp/lib/runtime-outbox.js`、`docs/MCP_TOOLS.md`（wake/kind）、`skills/opentrons-experiment-goal/SKILL.md`

---

*Worker 3 交付 — 调研 + 统一方案，待 Worker 1/2 对齐 consume 实现与 Cursor/Claude/Codex hook 细节后合并 PR。*
