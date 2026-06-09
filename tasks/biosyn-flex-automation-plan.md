# BioSyn Flex 自动化执行方案

> 目标：把 BioSyn 的实验假设转成可审稿、可复现、可直接落地的 Opentrons Flex `protocol.py`。
>
> 约束：AI 出方案 -> 人工审核 -> AI 出代码。  
> 校验不单列 `validate_protocol`，全部内置在 `generate_automation_script` 里。

## 0. 这份文档的范围

自动化在机器人层面只有两类本质不同的操作：

| 类型 | 核心能力 | 对应脚本 |
| --- | --- | --- |
| **酶学验证** | 低温源板取液 -> 反应板组装 -> 37°C 孵育 | `protocol_enzyme_assay.py` |
| **DNA 操作** | 移液组装 -> 热循环变温 -> 热激 -> 复苏 | `protocol_dna_operations.py` |

单酶矩阵、多酶 cascade、FadD 加样在自动化上没有本质区别，都是**条件矩阵移液 + 孵育**，因此合并进脚本 1。  
Gibson 组装与热激转化共享**温度程序控制**，合并进脚本 2。

**不做主展示**（可写 methods / supplement）：

- 菌株培养与诱导表达（半自动）
- 正丁醇 / 甲醇脂质提取（半自动）
- LC-MS 上机与有机相转移（人工）

---

## 1. 固定硬件

两台脚本共用同一台 Flex，但启用的模块不同：

| Slot | 硬件 | 脚本 1 酶学 | 脚本 2 DNA |
| --- | --- | --- | --- |
| `A1/B1` | Thermocycler | 不用 | Gibson + 热激 |
| `C1` | Temperature Module (4°C) | 酶 / 底物源板 | DNA / Gibson / 感受态 |
| `D1` | Heater-Shaker (37°C) | 反应板孵育 | 复苏培养板 |
| `C2` | 12-channel Reservoir | Buffer / quench | SOC（用水模拟） |
| `A2` | 1000 µL tiprack (1-ch) | ✓ | ✓ |
| `B2` | 1000 µL tiprack (8-ch) | ✓ | ✓ |
| `A3/B3` | backup tiprack | 可选 | 可选 |
| Gripper | 机械臂 | 不用 | 可选：TC 板 -> D1 |

移液器（两台脚本相同）：

- Left：`flex_1channel_1000`
- Right：`flex_8channel_1000`

### 通用 dry-run 体积

water-based dry run，体积偏大以便拍视频、保证 1000 µL 枪稳定：

| 液体类型 | 体积 |
| --- | --- |
| common buffer / master mix | 100–150 µL |
| substrate / DNA fragment | 20–50 µL |
| enzyme / Gibson mix / cells | 10–30 µL |
| 终体积 | 150–250 µL |

### 通用摆放原则

- **Reservoir (`C2`)**：大体积公共液（buffer、SOC、quench）
- **Source plate (`C1`, 4°C)**：多种小体积、条件各异的试剂
- **反应/操作板**：酶学放 `D1`；DNA 的 Gibson/热激放 `A1/B1` Thermocycler
- **8-channel**：整列 / 整板批量加公共液
- **1-channel**：按条件矩阵逐孔加变量组分
- **酶 / Gibson 产物最后加**，作为 reaction start
- knockout / 阴性对照用水或 buffer **补平体积**

---

## 2. 两个脚本总览

| 文件名 | BioSyn 故事 | 反应板布局 | 核心硬件 | 视频编号 |
| --- | --- | --- | --- | --- |
| `protocol_enzyme_assay.py` | PlsC 底物谱 + 四酶 cascade 验证 | 左半 PlsC 6×6 + 右半 cascade 8×2 | C1 + D1 | Video 1 |
| `protocol_dna_operations.py` | 底盘构建：Gibson 组装 + 热激转化 | TC 板 8–16 孔 + D1 复苏 | A1/B1 + C1 + D1 | Video 2 |

每个脚本都是**独立可运行的单个 `protocol.py`**。

---

## 3. 统一的 `protocol.py` 代码骨架

```python
def run(protocol):
    # 1. load modules
    # 2. load labware
    # 3. load pipettes
    # 4. define source / destination / condition maps
    # 5. prefill common buffer / master mix
    # 6. add variable liquids (substrate, DNA, etc.)
    # 7. add enzyme / cells / Gibson product last  -> reaction start
    # 8. temperature program OR incubate + mix
    # 9. pause for downstream steps
```

脚本内建议维护这些字典，供 `generate_automation_script` 填充：

- `deck_map`
- `source_map`
- `reaction_map`
- `condition_map`
- `volume_map`
- `temperature_program`（仅 DNA 脚本）

---

## 4. 脚本 1：`protocol_enzyme_assay.py`

### 4.1 目标

一块 96 孔反应板上同时完成两类 BioSyn 体外验证：

1. **左半板（cols 1–6）**：PlsC enzyme × substrate 交叉矩阵 —— 主发现验证
2. **右半板（cols 7–8）**：FadD-GGGPS-PlsC-CarS 四酶 cascade 小矩阵 —— 通路级验证

自动化逻辑完全相同：C1 取液 -> D1 组装 -> 37°C 孵育。区别只在 `condition_map` 内容。

### 4.2 Deck 布局

```
A1/B1  [空闲]
C1     Temperature Module + 96-well source plate (4°C)
D1     Heater-Shaker + 96-well reaction plate (37°C)
C2     12-channel reservoir
A2     tiprack (1-ch)    B2  tiprack (8-ch)
```

### 4.3 液体摆放

#### `C1` source plate（slot C1，4°C）

**PlsC 相关（row A–B）**

| Well | 内容 |
| --- | --- |
| `A1–A6` | MethPlsC, Ther1PlsC1, TherPlsC2, TherPlsC3, EcPlsC, no enzyme |
| `B1–B3` | GGGP, C18:1-CoA, iso-C15:0-CoA |

**Cascade 相关（row C–D）**

| Well | 内容 |
| --- | --- |
| `C1` | FadD |
| `C2` | GGGPS |
| `C3` | PlsC |
| `C4` | CarS |
| `D1` | G3P substrate mix |
| `D2` | G1P substrate mix |
| `D3` | cofactor mix（ATP/CoA/CTP 模拟液，可选） |
| `D4` | diluent / no-enzyme control |

**共用**

| Well | 内容 |
| --- | --- |
| `well H12` | quench / stop mock（正式实验用；dry run 可跳过） |

#### `C2` reservoir

| Lane | 内容 |
| --- | --- |
| 1 | common reaction buffer |
| 2 | optional master mix（cascade 公共底物预混，dry run 可用 lane 1 代替） |

#### `D1` reaction plate（slot D1，Heater-Shaker）

**左半：PlsC matrix — `rows A–F × cols 1–6`（36 孔）**

| Row | 底物 |
| --- | --- |
| `A/B` | GGGP，replicate 1 / 2 |
| `C/D` | C18:1-CoA，replicate 1 / 2 |
| `E/F` | iso-C15:0-CoA，replicate 1 / 2 |

| Col | 酶 |
| --- | --- |
| `1` | MethPlsC |
| `2` | Ther1PlsC1 |
| `3` | TherPlsC2 |
| `4` | TherPlsC3 |
| `5` | EcPlsC |
| `6` | no enzyme |

**右半：Cascade matrix — `rows A–H × cols 7–8`（16 孔）**

| Row | 条件 | Col 7 | Col 8 |
| --- | --- | --- | --- |
| `A` | full cascade | rep 1 | rep 2 |
| `B` | no FadD | rep 1 | rep 2 |
| `C` | no GGGPS | rep 1 | rep 2 |
| `D` | no PlsC | rep 1 | rep 2 |
| `E` | no CarS | rep 1 | rep 2 |
| `F` | G1P condition | rep 1 | rep 2 |
| `G` | G3P condition | rep 1 | rep 2 |
| `H` | no enzyme | rep 1 | rep 2 |

`cols 9–12` 预留，本次不用。

### 4.4 执行流程

```
Phase A — 公共 buffer
  8-ch: C2 lane1 -> D1 全部目标孔 (A-F×1-6 + A-H×7-8)

Phase B — PlsC 区 (cols 1-6)
  1-ch: 按 row group 从 C1 B1-B3 加 substrate
  1-ch: 按 column 从 C1 A1-A6 加 enzyme（最后加，reaction start）

Phase C — Cascade 区 (cols 7-8)
  1-ch: 按 row 从 C1 D1/D2 加 substrate mix（G3P 或 G1P）
  1-ch: 按 condition_map 从 C1 C1-C4 加酶；knockout 孔补 diluent
  1-ch: enzyme 最后加

Phase D — 孵育
  D1: close latch -> 37°C -> shake 500 rpm
  dry run: delay 60-120 s
  real run: delay 30-60 min
  deactivate shaker -> open latch -> protocol.pause("Ready for quench / LC-MS")
```

### 4.5 `condition_map` 示例（Cascade 区，代码用）

```python
CASCADE_CONDITIONS = {
    "A": {"enzymes": ["C1", "C2", "C3", "C4"], "substrate": "D1"},  # full, G3P
    "B": {"enzymes": ["C2", "C3", "C4"],           "substrate": "D1"},  # no FadD
    "C": {"enzymes": ["C1", "C3", "C4"],           "substrate": "D1"},  # no GGGPS
    "D": {"enzymes": ["C1", "C2", "C4"],           "substrate": "D1"},  # no PlsC
    "E": {"enzymes": ["C1", "C2", "C3"],           "substrate": "D1"},  # no CarS
    "F": {"enzymes": ["C1", "C2", "C3", "C4"],     "substrate": "D2"},  # G1P
    "G": {"enzymes": ["C1", "C2", "C3", "C4"],     "substrate": "D1"},  # G3P explicit
    "H": {"enzymes": [],                            "substrate": "D1"},  # no enzyme
}
# keys = source plate wells on C1; values reference well names
```

### 4.6 视频（Video 1）

| 镜头 | 内容 | 时长 |
| --- | --- | --- |
| 屏幕 | BioSyn hypothesis -> `generate_protocol` -> `protocol_enzyme_assay.py` | 5–8 s |
| 俯拍 | 8-ch 批量加 buffer 到整块反应板 | 10 s |
| 近景 | 1-ch 按列加 PlsC 酶（cols 1–6） | 10 s |
| 近景 | 1-ch 按行加 cascade 酶（cols 7–8，突出 full vs no-PlsC） | 10 s |
| 结尾 | D1 37°C 孵育启动 + protocol complete | 5 s |

主信息：**BioSyn 预测的酶学假设被转成一块板、一次运行的标准化验证 workflow。**

### 4.7 注意点

- 不把有机溶剂提取写进脚本；quench / LC-MS 在 `pause` 后人工处理
- knockout 缺酶孔必须用 `D4` diluent 补平，保持终体积一致
- 真实实验可把体积缩小；dry run 保持 1000 µL 枪可见体积

---

## 5. 脚本 2：`protocol_dna_operations.py`

### 5.1 目标

展示 BioSyn 通路验证之后的**底盘构建**能力：

1. **Gibson 组装**：多 fragment + Gibson master mix，50°C 孵育
2. **热激转化**：感受态细胞 + 组装产物，4°C -> 42°C -> 4°C
3. **复苏**：加 SOC，37°C 震荡培养

这是 Flex 上最具视觉冲击力的流程（Thermocycler 开合盖、变温、Gripper 搬板）。

### 5.2 Deck 布局

```
A1/B1  Thermocycler + 96-well PCR plate
C1     Temperature Module + 96-well source plate (4°C)
D1     Heater-Shaker + 96-well deepwell / flat plate (37°C recovery)
C2     12-channel reservoir (SOC)
A2     tiprack (1-ch)    B2  tiprack (8-ch)
```

### 5.3 液体摆放

#### `C1` source plate（4°C）

| Well | 内容 | 体积参考 |
| --- | --- | --- |
| `A1` | DNA fragment 1（用水模拟） | 5 µL |
| `A2` | DNA fragment 2 | 5 µL |
| `A3` | DNA fragment 3（可选） | 5 µL |
| `B1` | Gibson Assembly Master Mix | 10 µL |
| `C1–C4` | Competent cells（感受态，用水模拟） | 50 µL/孔 |
| `well H12` | diluent / TE buffer | 备用 |

#### `C2` reservoir

| Lane | 内容 |
| --- | --- |
| 1 | SOC medium（dry run 用水，~10 mL） |

#### `A1/B1` Thermocycler — PCR plate

| Well | 用途 |
| --- | --- |
| `A1–A4` | Gibson 组装反应（4 个 construct，dry run 可只做 2 个） |
| `B1–B4` | 热激转化反应（与 A 行一一对应） |

布局逻辑：Gibson 在 `row A` 完成 -> 同一板 `row B` 做热激，避免搬板。

#### `D1` recovery plate

| Well | 用途 |
| --- | --- |
| `A1–A4` | 复苏培养（对应 4 个 transformant） |

### 5.4 执行流程

```
Phase A — Gibson 组装
  TC: open lid, block temp 4°C
  1-ch: C1 A1-A3 (fragments) + B1 (Gibson mix) -> TC wells A1-A4
  1-ch: 轻混（pick up + dispense 3x）
  TC: close lid
  TC program (dry run):
    50°C  10 s   (real: 50°C 15-60 min)
    4°C   hold
  TC: open lid

Phase B — 热激转化
  TC: hold 4°C (模拟冰浴)
  1-ch: C1 C1-C4 (competent cells) -> TC wells B1-B4
  1-ch: TC A1-A4 (Gibson product) -> TC B1-B4, mix gently
  TC: close lid
  TC program (dry run):
    4°C   10 s   (real: 30 min on ice)
    42°C  45 s   (real: 45-90 s heat shock)
    4°C   10 s   (real: 2-5 min on ice)
  TC: open lid

Phase C — 复苏
  8-ch: C2 lane1 (SOC) -> TC B1-B4, ~150 µL each
  [Gripper] move PCR plate row B / whole plate -> D1 recovery plate
    若无 Gripper: protocol.pause("Manually transfer to D1")
  D1: close latch -> 37°C -> shake 300-500 rpm
  dry run: delay 60 s
  real run: delay 60 min
  D1: deactivate -> open latch
  protocol.pause("Transformation complete. Plate for selection.")
```

### 5.5 Thermocycler 温度程序（代码参考）

```python
# dry run
GIBSON_PROFILE = [
    {"temperature": 50, "hold_time_seconds": 10},
    {"temperature": 4,  "hold_time_seconds": 5},
]
HEAT_SHOCK_PROFILE = [
    {"temperature": 4,  "hold_time_seconds": 10},
    {"temperature": 42, "hold_time_seconds": 45},
    {"temperature": 4,  "hold_time_seconds": 10},
]

# real run — 替换 hold_time_minutes
GIBSON_PROFILE_REAL = [
    {"temperature": 50, "hold_time_minutes": 30},
    {"temperature": 4,  "hold_time_minutes": 10},
]
```

### 5.6 视频（Video 2）

| 镜头 | 内容 | 时长 |
| --- | --- | --- |
| 屏幕 | BioSyn construct design -> `generate_protocol` -> `protocol_dna_operations.py` | 5–8 s |
| 近景 | 1-ch 加 DNA fragments + Gibson mix 到 TC 板 | 10 s |
| 特写 | Thermocycler 关盖 -> 50°C（屏幕显示温度曲线） | 8 s |
| 近景 | 1-ch 加感受态 + Gibson 产物混合 | 10 s |
| 特写 | Thermocycler 42°C 热激 | 8 s |
| 俯拍 | 8-ch 加 SOC；Gripper 搬板到 D1（如有） | 10 s |
| 结尾 | D1 37°C 复苏启动 | 5 s |

主信息：**BioSyn 设计的遗传构建可被转成带温度程序的 Flex 可执行 workflow。**

### 5.7 注意点

- 感受态细胞真实操作时极易失活；dry run 全程用水，正式运行前单独验证细胞活性
- Gibson 与热激在同一块 PCR 板上分区（row A / row B），减少搬板次数
- 若未配置 Gripper，在 `pause` 处人工转移并注明于 methods
- 抗生素涂板、克隆挑选不在机器人流程内

---

## 6. Agent 工具链

### `generate_protocol`

输入：BioSyn 实验目标 + `assay_type`（`enzyme_assay` | `dna_operations`）+ deck 约束 + `dry_run`

输出：

- `experiment_spec`
- `condition_map`
- `reaction_map`
- `deck_map`
- `volume_map`
- `temperature_program`（DNA 脚本）

只产出方案，不直接生成 `protocol.py`。

### `generate_automation_script`

输入：人工审核后的 `experiment_spec`

输出：**仅 `protocol.py`**

内置检查：labware / deck / volume / pipette range / module compatibility / simulation sanity。

### 人工审核

审核点：

- 孔位映射是否与 wet lab 预装一致
- dry run vs real run 体积/时间参数
- DNA 脚本是否确认感受态细胞位置
- 是否需要在 `pause` 处增加人工 checkpoint

---

## 7. 文件组织

```text
automation/
  protocol_enzyme_assay.py      # Video 1: PlsC matrix + cascade
  protocol_dna_operations.py  # Video 2: Gibson + heat shock + recovery
```

---

## 8. 半自动补充（不进主脚本）

| 实验 | 自动化范围 | 人工步骤 |
| --- | --- | --- |
| 菌株诱导表达 | Flex 分装培养基 / 菌液 + 加 IPTG | 摇床培养、取样 |
| 脂质提取 | Flex 分装有机溶剂 / 归一化样品 | 相分离、离心、有机相转移 |
| LC-MS | — | 上机、数据分析 |

论文表述建议：

> Organic extraction and LC-MS readout were performed manually after robot-assisted reaction setup.

---

## 9. 一句话总结

**BioSyn 输出假设 -> `generate_protocol` 生成方案 -> 人工审核 -> `generate_automation_script` 产出两个 Flex `protocol.py`：一个覆盖所有酶学验证（PlsC 矩阵 + 四酶 cascade），一个覆盖 DNA 构建（Gibson + 热激 + 复苏）。**
