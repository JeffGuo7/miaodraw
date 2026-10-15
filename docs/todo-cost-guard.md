# 成本闸门（V1 已实现）

状态：**已实现**（V1 直连百炼出片段；原「待办」条目在 2026-10-15 落地）
来源：用户反馈「视频悠着点、很贵；图片用便宜点的」，团队定为省钱档。

## 1. 视频节点执行前显示预估成本 + 二次确认（已实现）

- 实现位置：`src/renderer/src/canvas/CanvasNode.tsx`（档位与预估价）、`src/renderer/src/canvas/videoGeneration.ts`（确认卡 + 流程）。
- 计算真源：`src/main/video-protocol.ts` 的 `estimateVideoCost()`（主/渲染同源，可单测）。
- 规则：
  1. **红线默认档**：`wan2.7-t2v` + **2 秒** + **720P** + **关 `prompt_extend`**（`DEFAULT_VIDEO_SPEC`）。
  2. 时长只能选 2/3/5/10 秒；非法值向上取最近合法档，**绝不放大参数**。
  3. 点「生成成片」必先弹确认卡（模型/画幅/分辨率/时长/预估金额 + 「以账单为准」），取消即不提交。
  4. **硬上限 ¥6/次**（`VIDEO_HARD_CAP_CNY`）：预估价超限直接拒绝；UI 与主进程 `video:generate` **双重拦截**（fail-closed，零付费）。
  5. **连续失败 2 次停止自动重试**（`MAX_AUTO_RETRY`），再点需经「成本护栏」确认；成功后计数归零。
  6. **记账**：产物 `assets.metadata` 与 `videos/<file>.json` sidecar 都记 `model/resolution/ratio/duration/estimated_cny/task_id`，便于对账。
- 验收：`SHOT_VIDEO_GUARD=1`（零付费：预估价显示 ¥1.20 + 不确认不提交 + 硬上限被拒）；`SHOT_CANVAS_VIDEO=1`（付费真实出片，预算 ≤¥2）。

## 2. 内部测试纪律（立即生效，无需代码）

- 团队内部**不主动跑视频生成测试**；确需验证时：最多 1 个分镜、最低分辨率、静音，并在汇报里写明实际花费。
- 图片测试默认走 `z-image-turbo`（¥0.1/张）；`wan2.7-image` 只在需要质量对比时用。

## 3. 价目（用于预估价）

| 模型 | 档位 | 参考价 | 来源 |
|---|---|---|---|
| z-image-turbo | 图片 | ¥0.1/张 | 工作区实测（Chief 核实） |
| wan2.7-image | 图片 | ¥0.2/张 | 现有内置价目 |
| qwen3-tts-flash | TTS | 极低（按字符） | 现有使用 |
| **wan2.7-t2v** | **720P** | **¥0.6/秒**（2 秒 ≈ ¥1.2） | Chief 实测基准，**账单为准** |
| **wan2.7-t2v** | **1080P** | **¥1.2/秒** | 按 720P 线性外推，**待账单核实** |

> `estimateVideoCost().verified === false`：价目未与账单核对，UI 必须显示「以百炼账单为准」。
