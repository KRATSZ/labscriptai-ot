# 视觉流程接入验证

日期：2026-11-10（Asia/Shanghai）

## 实现范围

- `run_protocol` 在软件预检后、发送 `play` 前尝试已配置的 Flex 视觉检查；默认 `auto`，支持环境关闭和单次显式选择。
- 预期初始布局来自同一次成功仿真的分析命令，支持变量、循环和关键字参数；不使用分析文件中的最终耗材位置。
- 中途才加载且初始位置不明确的耗材、不支持的类别、运行参数覆盖等情况如实记录未检查。
- 缺少相机、标定或推理依赖时记录 `not_checked`；已发现的差异和未解决的视觉疑点阻止发送启动指令，并返回状态核对建议。
- 每次尝试保存照片路径、标注图路径、差异、时间和运行关联信息到独立 JSON 报告；视觉不修改已提交台面状态。
- 延迟启动或被视觉检查阻止的运行保存预期布局，稍后通过 `control_run` 启动时重新观察，不复用旧照片。
- 手动换板/补吸头后，通过 `control_run(deck_changed=true, expected_layout=当前预期布局)` 重新检查。正常运行、暂停和停止不触发拍照。
- 更新主技能、规范流程、视觉文档、工具参数文档和安装检查；修正旧文档中失效脚本名、旧分支说明和不能创建标定的 `--show` 示例。
- 测试辅助代码支持 Windows 上的 Python 假解释器，并隔离并发测试的运行产物，避免写入用户实验目录。

## 本地检查

- 视觉、布局、恢复路由、预检、就绪状态、工具分发等专项组合：65/65 通过。
- 显式选择当前 Windows Python 后，加入原有运行/历史/LogicPass 测试：共 73 项，72 通过，1 失败，0 跳过。
- 未通过项：`run_protocol blocks real execution when LogicPass verdict is fail (LP-L1 dry well)`。该测试期望液体检查返回 `fail`，当前环境返回 `unevaluable`；实际仍在液体检查处阻止运行，未联系机器人，尚未进入本次新增的视觉代码。此独立的液体检查结果差异未在本次修改中放宽或掩盖。
- 安装检查：25 项通过，1 项警告，0 项失败。警告为工作区默认相机标定文件缺失。
- JavaScript 语法检查与 `git diff --check` 通过。

测试中的机器人 HTTP、拍照、YOLO/VLM 结果均为替身；新流程测试使用实际本地 Opentrons 分析器验证循环和关键字加载产生的布局。没有连接或移动真实机器人，没有验证现场相机可用性、模型识别准确率或实际摆台。

## 使用前的本机配置

当前工作区存在训练权重，相关 Python 包可发现，但没有默认文件 `automation/photo/deck_calibration.json`。

1. 用 `capture_image(mode=preview)` 获取当前相机的照片。
2. 用 `.venv\Scripts\python.exe automation\click_deck_corners.py --image <照片绝对路径>` 创建标定，或通过 `OPENTRONS_DECK_CALIBRATION` 指向已经适用于该机器人和相机角度的标定。
3. 核对 `automation/deck_layout_policy.json` 中的固定硬件和检测槽位；相机角度或台面固定硬件变化后更新配置。
4. 重新加载使用本工作区服务器代码的 MCP 客户端。此后普通 `run_protocol` 会自动尝试视觉检查。尚未配置时显示“未检查”，不会伪装成通过。

## 项目引用

Gao, Yuan et al. "Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering." bioRxiv, 2025. DOI: [10.1101/2025.09.30.679666](https://doi.org/10.1101/2025.09.30.679666).
