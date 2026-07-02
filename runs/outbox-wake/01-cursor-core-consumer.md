# Worker 1：跨平台 Outbox 消费层 + Cursor 接线方案

> 调研日期：2026-07-01  
> 范围：`consume-runtime-outbox.mjs` 核心消费逻辑、Cursor 2026 hooks、`wake:true` 过滤、GOAL_STATUS 续跑协议、与 `/loop` 分工  
> 骨架实现：`scripts/consume-runtime-outbox.mjs`（本仓库已落盘，未接 plugin hooks）

---

## ① 结论（一句话）

**Cursor 最靠谱的接法是：插件根 `hooks/hooks.json` 用 `stop` 事件 + `${CURSOR_PLUGIN_ROOT}/scripts/consume-runtime-outbox.mjs --hook stop` 读取 `host-adapters/cursor/<session>.jsonl`（或 canonical outbox）里 `wake:true` 且未 ack 的最新 sentinel，通过 `followup_message` 自动提交 continuation prompt；`sessionStart` 仅作冷启动补漏；长时间无人对话时用 `/loop` 或外部 `runtime-recovery-monitor.mjs` 轮询投递，二者互补而非互斥。**

---

## ② 背景与数据流

### 已有 MCP 侧（无需改）

| 组件 | 路径 / 工具 | 作用 |
|------|-------------|------|
| Outbox 真相 | `${PLUGIN_DATA}/runtime-outbox/<session>/outbox.jsonl` | `runtime_get_outbox` / `runtime_ack_outbox` |
| Cursor 邮箱 | `${PLUGIN_DATA}/host-adapters/cursor/<session>.jsonl` | `runtime_deliver_outbox(notify_adapters=["cursor"])` append |
| Goal 状态 | `${PLUGIN_DATA}/runtime-watch/<run_id>/goal-state.json` | `runtime_watch_loop` 持久化 |
| Wake 语义 | `wake` + `kind` 字段 | 见 `docs/MCP_TOOLS.md` L413–429 |

`deliverToAdapter("cursor")` 每行 JSON 形如：

```json
{
  "delivered_at": "2026-07-01T12:00:00.000Z",
  "adapter": "cursor",
  "event": {
    "outbox_id": "uuid",
    "session_id": "self-recovery-liquid",
    "run_id": "abc",
    "type": "runtime_watch_loop_tick",
    "kind": "needs_user",
    "wake": true,
    "severity": "warn",
    "message": "...",
    "recommended_next_tool": "runtime_get_alerts",
    "no_robot_motion": true,
    "acked_at": null
  }
}
```

### `wake:true` 过滤规则（与 MCP 契约对齐）

| `kind` | `wake`（`zero_llm_when_no_error=true`） | 消费端行为 |
|--------|----------------------------------------|------------|
| `heartbeat` | `false` | **忽略**（可记 offset，不注入 prompt） |
| `blocked` / `needs_user` / `hard_stop` / `completed` | `true` | **消费并续跑** |
| 未设 `wake` 的 monitor 事件 | 视 `requires_attention` / `severity` | 保守：`requires_attention` 或 `hard_stop` → 当作 wake |

默认 `zero_llm_when_no_error=false` 时 legacy 模式每 tick `wake:true`；生产建议 arm loop 时开 `zero_llm_when_no_error=true` + `notify_adapters=["cursor"]`。

### 缺口（本 Worker 要补的）

MCP 只 **append 文件**，不能 push IDE 聊天。宿主必须跑 **薄消费层** → 注入 continuation prompt → agent 按 `opentrons-experiment-goal` 协议行动。

---

## ③ `consume-runtime-outbox.mjs` 完整代码草案

**已落盘：** [`scripts/consume-runtime-outbox.mjs`](../../scripts/consume-runtime-outbox.mjs)

设计要点：

1. **双源读取（`--source auto`）**  
   - 先 tail `host-adapters/cursor/<session>.jsonl`（从 `*.consumer-state.json` 的 `adapter_offset` 起）  
   - 邮箱为空则 fallback `readRuntimeOutbox()`（与 `runtime_get_outbox` 同库）

2. **只处理可行动 sentinel**  
   - `--wake-only`（默认）：`event.wake === true`，或 `kind !== "heartbeat"`  
   - 跳过 `acked_at` 与 consumer 本地 `acked_outbox_ids`

3. **Continuation prompt（对齐 `opentrons-experiment-goal`）**  
   - 含 `outbox_id` / `run_id` / `kind` / `recommended_next_tool`  
   - 要求 agent 输出：
     ```text
     GOAL_STATUS: CONTINUE | COMPLETE | BLOCKED
     GOAL_REASON: <one line>
     ```

4. **Ack**  
   - `--ack` 时调用 `ackRuntimeOutboxEvent()`（与 `runtime_ack_outbox` 同实现，hook 内无需 MCP 会话）

5. **Hook 输出模式**  
   | `--hook` | stdout JSON |
   |----------|-------------|
   | `stop` | `{ "followup_message": "<continuation>" }` 或 `{}` |
   | `sessionStart` | `{ "additional_context": "<continuation>" }` 或 `{}` |
   | CLI / `--poll-once` | 纯文本 或 `NO_WAKE` |

### 核心伪代码（与实现等价）

```javascript
// --- paths ---
PLUGIN_ROOT = env(OPENTRONS_PLUGIN_ROOT | CURSOR_PLUGIN_ROOT | repo_root)
DATA_DIR    = env(PLUGIN_DATA | OPENTRONS_PLUGIN_DATA | .plugin-data)
ADAPTER     = DATA_DIR/host-adapters/cursor/<session_id>.jsonl
OUTBOX      = DATA_DIR/runtime-outbox/<session_id>/outbox.jsonl
STATE       = DATA_DIR/host-adapters/cursor/<session_id>.consumer-state.json

// --- consume ---
function consume({ session_id, wake_only=true, source="auto" }) {
  state = readJson(STATE) ?? { adapter_offset: 0, acked_outbox_ids: [] }
  events = []

  if (source in ["auto", "adapter"]) {
    lines = readLines(ADAPTER).slice(state.adapter_offset)
    events = lines.map(parse).map(row => row.event ?? row)
    state.adapter_offset = totalLines(ADAPTER)
  }
  if (events.length === 0 && source in ["auto", "outbox"]) {
    events = readRuntimeOutbox({ sessionId: session_id, includeAcked: false })
  }

  event = events
    .filter(e => !e.acked_at && !state.acked_outbox_ids.includes(e.outbox_id))
    .filter(e => wake_only ? isWake(e) : true)
    .sort(by created_at desc)[0]

  if (!event) return null

  prompt = formatGoalContinuation(event)  // GOAL_STATUS hint + skill steps
  return { event, prompt }
}

// --- hook main ---
stdin = readJson(stdin)  // Cursor 传入 conversation_id/session_id 等
result = consume({ session_id: env(OPENTRONS_SESSION_ID) ?? stdin.session_id ?? "default" })

if (hook === "stop") {
  if (result) writeJson({ followup_message: result.prompt })
  else writeJson({})
  if (--ack) ackRuntimeOutbox(result.event.outbox_id)
}
```

### CLI 示例

```bash
export OPENTRONS_PLUGIN_ROOT=/path/to/labscriptai-ot
export PLUGIN_DATA=$OPENTRONS_PLUGIN_ROOT/.plugin-data
export OPENTRONS_SESSION_ID=self-recovery-liquid

# 模拟 hook（无 stdin 时用 env session）
node scripts/consume-runtime-outbox.mjs --hook stop

# 单次轮询 + ack
node scripts/consume-runtime-outbox.mjs --poll-once --ack

# 直连 canonical outbox（跳过 adapter 邮箱）
node scripts/consume-runtime-outbox.mjs --source outbox --poll-once
```

---

## ④ Cursor Hook 方案

### 推荐事件：`stop`（主）+ `sessionStart`（辅）

| 事件 | 适用场景 | 输出字段 | 可靠性（2026-07） |
|------|----------|----------|-------------------|
| **`stop`** | Agent 一轮结束后续跑 goal | `followup_message` | **高** — 官方 loop 机制，`loop_limit` 可配 |
| **`sessionStart`** | 新开会话时捞积压 sentinel | `additional_context` | **中** — 部分视图有注入 bug；仅冷启动 |
| `sessionEnd` | 审计 / ack 兜底 | （fire-and-forget） | 低（不续跑） |
| `workspaceOpen` | 加载插件 / 注册路径 | `pluginPaths` | 与 wake 无关 |
| `postToolUse` | 工具后注入 | `additional_context` | **低** — 2026 论坛确认多处未注入模型 |

**不选 `postToolUse` / `afterMCPExecution` 作主 wake 路径**：`additional_context` 在多数 hook 上仍不可靠；`stop.followup_message` 是 Cursor 文档明确的 auto-submit 下一条用户消息机制。

### `hooks.json` 完整示例（插件根）

放置路径：**`hooks/hooks.json`**（Cursor Plugins Reference 默认发现；**不是** `.cursor-plugin/hooks.json`）

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "node ${CURSOR_PLUGIN_ROOT}/scripts/consume-runtime-outbox.mjs --hook sessionStart",
        "timeout": 15
      }
    ],
    "stop": [
      {
        "command": "node ${CURSOR_PLUGIN_ROOT}/scripts/consume-runtime-outbox.mjs --hook stop --ack",
        "loop_limit": null,
        "timeout": 20
      }
    ]
  }
}
```

说明：

- **`${CURSOR_PLUGIN_ROOT}`**：插件安装目录（`~/.cursor/plugins/...` 或 marketplace cache）。**必须**用此 token；plugin hook 的 cwd 多为**项目根**，裸 `./scripts/...` 会找不到文件（论坛 #153236 / #157195）。
- **`$CURSOR_PROJECT_DIR`**：始终为工作区根，可用于读项目内 `runs/` artifact。
- **`loop_limit: null`**：去掉默认 5 次 stop 链上限（长 goal run 需要）；或设为 `50` 防失控。
- **`--ack`**：hook 消费后立即 `runtime_ack_outbox`，避免同一 sentinel 重复 wake。

### Hook stdin / stdout JSON

**`stop` 输入（节选）：**

```json
{
  "hook_event_name": "stop",
  "session_id": "<conversation uuid>",
  "conversation_id": "<same>",
  "status": "completed",
  "loop_count": 0,
  "workspace_roots": ["/path/to/project"],
  "cursor_version": "3.9.x"
}
```

**`stop` 输出（有 wake 时）：**

```json
{
  "followup_message": "[LabscriptAI OT — runtime wake]\n\nFollow the `opentrons-experiment-goal` skill...\n\nGOAL_STATUS: CONTINUE  (refine...)\nGOAL_REASON: <one line>"
}
```

**无 pending wake：**

```json
{}
```

**`sessionStart` 输出：**

```json
{
  "additional_context": "<同上 continuation 文本>"
}
```

消费脚本从 `stdin.session_id` **不能**直接当作 `OPENTRONS_SESSION_ID`（前者是 Cursor 会话 UUID，后者是实验 session，如 `self-recovery-liquid`）。**默认用环境变量 `OPENTRONS_SESSION_ID`**；多 session 工作区可在项目 `.env` 或 hook 外包一层 wrapper 传 `--session-id`。

### 薄 wrapper（可选，按项目绑定 session）

`hooks/cursor-outbox-stop.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
export OPENTRONS_SESSION_ID="${OPENTRONS_SESSION_ID:-self-recovery-liquid}"
export OPENTRONS_PLUGIN_ROOT="${CURSOR_PLUGIN_ROOT:?}"
export PLUGIN_DATA="${PLUGIN_DATA:-$OPENTRONS_PLUGIN_ROOT/.plugin-data}"
cat >/dev/null  # drain stdin (stop payload optional)
exec node "$OPENTRONS_PLUGIN_ROOT/scripts/consume-runtime-outbox.mjs" --hook stop --ack
```

`hooks.json` 中 command 改为：`"command": "bash ${CURSOR_PLUGIN_ROOT}/hooks/cursor-outbox-stop.sh"`

---

## ⑤ 与 `/loop` 的关系

| 机制 | 触发时机 | 优点 | 缺点 |
|------|----------|------|------|
| **`stop` hook 链** | Agent 每轮自然结束 | 无额外 shell；与对话深度集成 | 需要**已开启的 Agent 会话**；IDE 关/会话 idle 时不 fire |
| **`/loop 30s ...`** | 定时间隔或 sentinel | Agent idle 时仍能 wake；可 tail 文件变 sentinel | 绑定本地会话；长间隔 background shell 有已知 bug |
| **`runtime-recovery-monitor.mjs --cycles N`** | MCP/CLI 侧 tick | 不占用 Agent turn；可 `notify_adapters=cursor` | 需另起终端/cron；不是 IDE 内 hook |

### 推荐组合（下午试跑）

1. **Agent 已在盯 run（cursor-goal 主路径）**  
   - MCP：`runtime_watch_loop(..., notify_adapters=["cursor"], zero_llm_when_no_error=true, max_turns=1~3)` 每轮短预算返回  
   - Cursor：`stop` hook 链 → consume → `followup_message` → agent CONTINUE → `resume=true`

2. **Agent 可能长时间不说话，但 monitor 在跑**  
   - 另开：`/loop 30s` prompt 含「读 outbox，按 opentrons-experiment-goal 行动」  
   - 或：`node scripts/runtime-recovery-monitor.mjs --cycles 0 --interval-ms 30000 --notify-adapters cursor`（0=无限循环需终端）

3. **新开 Cursor 聊天补积压**  
   - `sessionStart` hook 注入 `additional_context`（有则处理）

4. **不要用 `/loop` 替代 `stop` 链** 在同一会话里双开相同 poll，会重复 wake；二选一为主，另一个作 idle 兜底。

---

## ⑥ 安装 / 启用步骤（下载插件后）

### A. 标准安装（marketplace / 本地插件）

```bash
cd /path/to/labscriptai-ot
bash install-labscriptai-ot.sh
node scripts/verify-setup.mjs
```

环境变量（Cursor MCP 通常已注入，手动时设置）：

```bash
export OPENTRONS_PLUGIN_ROOT=/path/to/labscriptai-ot
export PLUGIN_DATA=$OPENTRONS_PLUGIN_ROOT/.plugin-data
export OPENTRONS_SESSION_ID=self-recovery-liquid   # 与 arm loop 时 session_id 一致
```

### B. 启用 Cursor hooks（本 PR 合并后）

1. 确认插件根存在 `hooks/hooks.json`（见 §④ 示例）。
2. Cursor → **Settings → Hooks** 查看是否加载 `labscriptai-ot` 的 `stop` / `sessionStart`。
3. 若 marketplace 插件未加载 hooks：在项目创建 symlink  
   `ln -sf "$OPENTRONS_PLUGIN_ROOT/hooks/hooks.json" .cursor/hooks.json`  
   并把 command 改为 `.cursor/...` 或保留 `${CURSOR_PLUGIN_ROOT}`（本地插件路径）。

### C. 验证消费层（无需真机）

```bash
# 1. 写入一条 synthetic wake 到 adapter 邮箱
mkdir -p .plugin-data/host-adapters/cursor
cat >> .plugin-data/host-adapters/cursor/self-recovery-liquid.jsonl <<'EOF'
{"delivered_at":"2026-07-01T12:00:00Z","adapter":"cursor","event":{"outbox_id":"test-wake-1","session_id":"self-recovery-liquid","run_id":"run-test","kind":"needs_user","wake":true,"severity":"warn","message":"test wake","recommended_next_tool":"runtime_get_alerts","no_robot_motion":true}}
EOF

# 2. 消费
OPENTRONS_SESSION_ID=self-recovery-liquid \
  node scripts/consume-runtime-outbox.mjs --hook stop

# 期望 stdout 含 followup_message 与 GOAL_STATUS
```

### D. 真跑 goal loop

1. Agent 调用 `runtime_watch_loop(run_id=..., session_id=$OPENTRONS_SESSION_ID, notify_adapters=["cursor"], zero_llm_when_no_error=true, max_turns=5, ...)`
2. 开 Agent 对话，说「盯到跑完，按 opentrons-experiment-goal」
3. 观察 `stop` hook 是否自动提交下一条 wake prompt（Hooks output channel）
4. Agent 处理后应 `runtime_ack_outbox`（hook `--ack` 已代做）

---

## ⑦ 风险与限制

| 风险 | 影响 | 缓解 |
|------|------|------|
| Cursor `sessionStart` `additional_context` 部分版本/视图不注入 | 冷启动漏 wake | 以 `stop` 为主；手动开聊时 agent 调 `runtime_get_outbox` |
| `postToolUse` `additional_context` 不可靠 | 不能用 MCP 工具后 hook 续跑 | 不用作主路径 |
| Plugin hook cwd 与路径解析不一致 | 脚本找不到 | **强制** `${CURSOR_PLUGIN_ROOT}`；`stop` 用 `$CURSOR_PROJECT_DIR` 读项目文件 |
| `loop_limit` 默认 5 | 长 run 链断 | `stop` 设 `loop_limit: null` 或足够大 |
| Cursor 会话 UUID ≠ `OPENTRONS_SESSION_ID` | 读错邮箱 | 用 env / wrapper 显式传 `--session-id` |
| MCP 不能真「弹窗」 | 无人开 Agent 则不 wake | `/loop` 或 `runtime-recovery-monitor` + `notify_adapters` |
| `runtime_watch_loop` 长阻塞 MCP | 单 turn 内 agent 等待 | 短 `max_turns` + resume 模式配合 stop 链 |
| 重复 wake / 重复 ack | 吵或丢事件 | consumer-state offset + `--ack` + outbox dedupe |
| Cloud Agent | `stop`/`sessionStart` 未接线 | 本地 IDE 路径；云端用 webhook + Automations |
| Claude Code 下午也要跑 | Hook schema 不同 | 同 consume 脚本，另写 `hooks/claude/hooks.json`（Worker 2） |

---

## ⑧ 文件清单（建议后续 PR）

| 文件 | 状态 |
|------|------|
| `scripts/consume-runtime-outbox.mjs` | ✅ 骨架已写 |
| `hooks/hooks.json` | ⬜ 待 PR（§④ 示例） |
| `hooks/cursor-outbox-stop.sh` | ⬜ 可选 wrapper |
| `.cursor-plugin/plugin.json` | ⬜ 无需改；hooks 自动发现 |
| `install-labscriptai-ot.sh` | ⬜ 可选：提示设置 `OPENTRONS_SESSION_ID` |
| `docs/GETTING_STARTED.md` | ⬜ 增「Unattended wake (Cursor)」小节 |

---

## ⑨ 参考

- 本仓：`servers/opentrons-mcp/lib/runtime-outbox.js`、`skills/opentrons-experiment-goal/SKILL.md`、`runs/qa-2026-07-01/04-hooks-proactive-reminder.md`
- Cursor：[Hooks](https://cursor.com/docs/hooks)、[Plugins Reference](https://cursor.com/docs/reference/plugins)
- MCP 契约：`docs/MCP_TOOLS.md` § Outbox wake / kind semantics

---

*产出：`runs/outbox-wake/01-cursor-core-consumer.md`*
