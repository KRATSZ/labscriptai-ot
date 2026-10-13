# 重构路线：以 Experiment 与 Run 为核心

> 状态：草案（2026-10 起执行）· 分支：`feature/experiment-run-core`
> 本文是后续开发的唯一路线图。阶段划分、验收标准以此为准，其他文档链接到这里，不另行复制。

## 一句话原则

以 Experiment 和 Run 为核心，用一条统一验证流程打通数字孪生，用一条受控执行流程连接真实机器人，再用自动生成的报告与模板完成闭环。

## 六条底线

1. **不重写**：沿用 `servers/opentrons-mcp/lib/` 现有模块化方向继续拆分，不另起炉灶。
2. **不堆功能**：围绕一条完整实验闭环整理现有代码，新能力必须挂到闭环上。
3. **渐进式**：先补齐测试与接口契约，再拆实现。不为重构而重构。
4. **不引入新基建**：不加数据库、消息队列、新服务层。状态持久化沿用 `PLUGIN_DATA` 下的文件方案（参考 `lib/state.js` 的 `SESSION_STATE_DIR` 模式）。
5. **中间产物最小化**：工具链的每次调用不得在仓库或用户工作区堆积文件。过程数据一律写 `PLUGIN_DATA`（gitignored、可清理），仓库树保持干净；测试只写 tmpdir。不产出用户没有要过的文件。
6. **最终产物浓缩、用户可读**：面向用户的输出（工具返回、报告）默认"结论先行 + 关键证据 + 下一步"，用用户的语言；长 JSON 与原始数据放可选字段或附件，不作为主输出。

## 核心数据对象（只有两个）

### Experiment — 实验定义

回答：我要做什么实验？使用什么方案？协议是什么？

| 字段组 | 内容 |
|---|---|
| `intent` | 实验意图与结构化参数 |
| `robot` | 设备型号 + 设备配置快照引用 |
| `resources` | Labware / 耗材引用、液体属性及其数据来源（trust level） |
| `protocol_versions[]` | 生成的协议文件 + 内容哈希，逐版本递增 |
| `validation_status` | 按 protocol version 记录的验证结论 |
| `is_template` | 保存为模板类型的 Experiment |

规则：**Experiment 可修改；每次修改产生新的 protocol version。**

### Run — 实验过程

回答：这次实验检查得怎么样？实际发生了什么？最后结果如何？

| 字段组 | 内容 |
|---|---|
| `binding` | experiment_id + experiment_version + protocol_hash（Run 创建时冻结） |
| `checks` | 统一结构的检查结果：virtual lab state / simulation / LogicPass / flex3d / 现场核对快照 |
| `authorization` | 用户授权记录（谁、何时、针对哪个 protocol_hash、范围） |
| `events` | 执行日志与事件流 |
| `recovery` | 异常与恢复记录（含"是否可安全续跑"的判定依据） |
| `report` | 最终报告引用（由 Experiment + Run 自动生成） |

规则：**Run 绑定确定的 Experiment 版本。协议一旦修改，旧验证结论作废，不得沿用。**

### 其余信息的归属

| 信息 | 放在哪里 |
|---|---|
| 设备型号、固定硬件配置 | 本地设备配置文件（Run 创建时快照存档） |
| Labware、液体类别和物理参数 | 可版本化的资源定义库 |
| Python 协议 | Experiment 关联的文件及版本 |
| 模拟、规则校验、3D 结果 | Run 的 checks |
| 现场状态、授权、事件日志 | Run 的执行记录 |
| 实验报告 | 根据 Experiment 与 Run 自动生成的文件 |
| 可复用模板 | `is_template=true` 的 Experiment |

不引入 `ProtocolArtifact`、`PreflightReport`、`ExperimentRecord`、`Template` 等独立业务实体——模板即 Experiment，验证报告存在 Run 里。

## 现状盘点（2026-10，代码核对过的事实）

已有、可直接复用的资产：

- **`lib/` 已有 40 个模块**（logicpass、flex3d、simulation、run-control、runtime-outbox、continuation、recovery-playbooks、live-readiness 等），模块化方向已经在走。
- **`policy/workflows.md` 已定义完整 phase machine**（intent → virtual lab gate → simulate → 3a 现场核对 → 3b 视觉 → 3c 探针 → 单次 go-live 确认 → run → watch loop），即文档层的"统一验证流程"已经存在，缺的是数据层把它串起来。
- **`policy/output-contract.md` + `lib/error-taxonomy.js`**：统一状态 JSON 与错误分类已有基础。
- **`lib/state.js` 的液体信任级别**（declared / simulated / observed / reconciled）就是"物理属性及数据来源"的现成实现。
- **工具已按 L0–L4 分层**（共 77 个，见 `docs/MCP_TOOLS.md`），skills 已按任务路由（`opentrons-experiment-run` 为编排入口）。
- **安全门禁已实装**：`OPENTRONS_ENABLE_PROBE_WELLS=1` 硬门禁、HumanConfirmBudget 单次确认、simulation + LogicPass 双门槛。
- **测试基础比预期好**：`servers/opentrons-mcp/test/` 下已有 58 个测试文件（367 用例全绿）。
- **LogicPass 的 fail-closed 语义已成立**：对模拟即失败的协议返回 `unevaluable` 并拒绝放行——P2 的验收标准之一在现状代码里已部分达成。
- **真实 LLM 验收基线已建立**（2026-10）：`scripts/deepseek-agent-harness.mjs` 用真实大模型驱动 19+ 个用户视角场景（中文）打满 MCP 工具面，验证安全边界与工具路由。首轮结果：绕过模拟门禁、仅验证不越界、修复闭环等场景全部零违规。

已知痛点（本路线要解决的）：

- `servers/opentrons-mcp/index.js` **8,470 行**，工具注册与业务逻辑混杂，继续膨胀。
- 状态分散在 session state、result-log、runtime-outbox 等多处，**没有 Experiment/Run 这个把"定义"与"过程"钉住的对象**，跨阶段追溯靠约定而非结构。
- 安装链路割裂：安装器主要配 Node/MCP，Python（`uv sync`，opentrons>=9,<10）与 MuJoCo 需用户自行补装。
- 3D 预检仅支持 Flex（OT-2 被拒绝），但支持矩阵没有集中、显式的声明。
- 报告生成与模板复用完全缺失。
- **中间产物曾经直接写进仓库树**：8 个根目录 CLI 脚本默认把每次调用的 JSON 摘要写到 `runs/self-recovery/artifacts/`（曾有多达 10 个此类文件被提交进 git）。已改为默认写 `PLUGIN_DATA`（2026-10），但"每次调用落一个 UUID 文件"的产物模型仍需收敛为 Run 内的记录。
- **面向用户的输出偏底层**：工具返回大段原始 JSON，结论埋在字段里；修复类场景缺少读文件能力时，agent 倾向整份重写协议而非最小修改（真实 LLM 测试观察到的行为）。

命名注意：仓库根目录的 `runs/` 是 QA 演练笔记（markdown），与 Run 对象的运行时存储（`PLUGIN_DATA` 下）无关。引入 Run 对象时避免在这两个概念间复用路径或术语。

## 阶段路线图

### P0 — 明确边界

锁定范围，建立端到端基准。

- 确定首个完整支持的机器人型号与实验场景。
- 建立固定的示例协议集 + 测试耗材 + **期望检查结果的 golden 文件**（可放 `examples/` 与 `test/fixtures/`）。
- 集中声明**支持矩阵**：robot 型号 × 能力（simulate / LogicPass / flex3d / live / probe / vision），并标注 stable / experimental。现状是分散在 README、MCP_TOOLS、skills 的只言片语。

**验收**：至少一个目标场景能持续复现预期的验证结果（CI 或脚本可重复执行）。

### P1 — 安装与架构

先让核心环境一次安装成功。

- Node、Python、Opentrons、MuJoCo、3D 查看器的安装与检查收敛进 `install-labscriptai-ot.sh` + `scripts/verify-setup.mjs` 统一流程；核心 3D 不再要求用户查文档补装依赖。
- 定义 Experiment / Run 的**最小数据结构**（JSON Schema + `lib/` 读写模块），存储为 `PLUGIN_DATA` 下 JSON 文件。
- 对齐统一错误格式（扩展 `error-taxonomy.js`）与检查结果格式（扩展 `output-contract.md` 的 status JSON），使每种检查的结论只有 passed / failed / not_applicable / unknown 四态，**unknown 不得默认按通过处理**。
- 产物卫生：所有中间产物统一落 `PLUGIN_DATA`；清理历史遗留；审计测试与 CLI，保证仓库树在任意操作后保持干净。
- 为 Experiment / Run 补契约测试（扩展现有测试，不是从零开始建测试）。

**验收**：安装后可完成无实体动作的环境自检 + 示例协议完整验证。

### P2 — 数字孪生

打通意图、协议、模拟与 3D。

- 将 virtual lab state 校验、Opentrons 模拟、LogicPass、flex3d 预检包装成**一条统一验证流程**（单一编排模块 / 少量面向任务的 MCP 入口），输出统一验证报告写入 Run.checks。
- 统一命令索引与错误定位：flex3d 的 `command_index` 已与 LogicPass `step_index` 对齐，把这个对齐上升为契约。
- 维护液体已知物理属性及数据来源（复用 trust level 体系）。
- 检查不可用（如 mujoco 缺失）时报告为 not_applicable / unknown 并显式呈现，不得静默降级为通过。

**验收**：一个 Experiment 能得到同版本协议的统一验证报告；失败或无法评估的检查不会被默认当作通过。

### P3 — 真实执行

让 Run 成为唯一的运行记录入口。

- 现场核对（live_readiness / preflight_run_setup / reconcile_state）、授权、运行状态、事件日志、恢复判断全部绑定到同一个 Run。
- 恢复不得盲目重放可能已执行的液体操作（`continuation.js` 已有基础，需以 Run 的事件记录为准绳）；状态不明时阻塞并要求进一步确认。

现状提示：P3 是五个阶段里现状最强的——硬门禁、单次确认、outbox、recovery playbooks 都已存在。本阶段的实质工作是**收拢到 Run**，不是新建流程。

**验收**：运行前能核对实际设备；授权绑定确切协议版本（protocol_hash）；中断后能判断是否可继续，无法确认时不擅自恢复。

### P4 — 闭环归档

让实验可复用，并收尾清理架构。

- 根据 Experiment + Run 自动生成实验报告（文件产物，挂到 Run.report），报告格式遵循"结论先行 + 关键证据 + 下一步"，面向用户而非面向调试。
- 实验定义保存为模板（`is_template=true` 的 Experiment）供派生：复制 → 改参数 → 重新生成协议 → 重新验证。
- 输出浓缩：把工具返回统一为简明结论层 + 可选详情层，长 JSON 不再是主输出。
- 继续拆分 `index.js`（8,470 行）：工具注册薄化，业务逻辑下沉 `lib/`，每拆一块先锁契约测试。
- 整理文档、收紧工具暴露面；视觉识别、外部多模态模型、复杂恢复、通知系统保持为可选扩展，不阻塞核心安装与主流程。

**验收**：同一实验能改参数后再次生成并验证协议；历史实验可追溯；核心功能不依赖视觉云服务等非必要扩展。

## 工具入口收敛

不是把 76 个工具删到很少，而是让用户和 AI 默认只面对少量面向任务的入口；底层工具保留，逐步被流程封装。

| 面向用户的任务 | 内部执行的动作 |
|---|---|
| 检查环境 | 依赖检测、MCP 健康检查、自检 |
| 设计与验证协议 | 参数整理、协议生成、模拟、LogicPass、3D |
| 准备运行 | 设备与台面核对、运行许可判断 |
| 执行与恢复 | 启动、状态监控、异常诊断、受控恢复 |
| 查看与复用实验 | 查询 Run、生成报告、保存模板 |

优先治理的依赖耦合：Python 环境、可选 3D 依赖、不同客户端配置（Claude Code / Codex / Cursor 的 mcp.json 差异）。
