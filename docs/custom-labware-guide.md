# 用 Agent 新建自定义耗材

第三方耗材（非 Opentrons 官方 labware）需要 Agent 帮你生成 JSON 定义。你只需**提供信息 + 确认上机**，其余交给 Agent。

已有示例：PE 50 µL / 200 µL 枪头盒（`automation/labware/`）。

---

## 你怎么说（复制改一下即可）

在 Cursor 里直接发类似这样的话：

> 我要添加新的自定义耗材：
> - 型号/货号：___
> - 类型：枪头盒 / 孔板 / 储液槽 / …
> - 最接近的官方 Flex 耗材：___（不知道可写「和官方 50 µL 枪头盒类似」）
> - 盒高（mm，卡尺量）：___
> - 计划放在 deck 哪个 slot：___
> - 机器人 IP（要上机时）：___
>
> 请参照 PE 枪头的方式新建 labware，本地模拟通过后，生成验证协议并上传运行。

信息越全，Agent 越少来回问。

---

## Agent 会做什么

1. 在 `automation/labware/` 写配置并生成 `.json`（命名空间 `custom_beta`）
2. 本地 `opentrons.simulate` 验证
3. 必要时写/改取头验证协议（参考 `automation/verify_pe_tip_pickup.py`）
4. 你说「上传并运行」时：把 **`.py` + 相关 JSON** 一起传到 Flex，并创建 run

---

## 你需要亲手做的（Agent 替不了）

| 步骤 | 说明 |
|------|------|
| 量尺寸 | 至少量**盒高**（mm）；取头不准时再配合 Agent 微调 |
| Flex 校准 | 触摸屏上对新材料做一次 **Labware 校准**（只需做一次，换盒/改高度后重做） |
| 上机确认 | 验证协议暂停时，眼看枪头是否密封、落位是否正确，点 **Resume** |

---

## 以后在新实验里用

告诉 Agent：

> 协议里用 PE 50 µL（A2）和 PE 200 µL（B2）枪头盒，写/改协议并上传。

Agent 会在 `.py` 里写 `load_labware(..., namespace="custom_beta")`，上传时自动带上对应 JSON。
**位置校准已在机器上**，一般不用重做。

---

## 相关文件（不用自己改，给 Agent 看即可）

- `automation/labware/pe_tiprack_config.json` — 尺寸配置示例
- `automation/labware/build_pe_tipracks.py` — 生成 JSON 的脚本示例
- `automation/verify_pe_tip_pickup.py` — 上机验证示例
