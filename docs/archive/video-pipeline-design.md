# miaodraw 自建视频管线设计（参考 Pixelle-Video）

作者：Rea。状态：待 Jeff 审（先不提交）。边界：Pixelle 只读参考，**不改造/不提交/不推送/不引入依赖**（其许可 Apache-2.0，见 `pixelle_video/pipelines/base.py` L1-11）。本稿零付费调用。
**干净房间声明（Jeff 2026-10-15 批）**：只学机制、不抄代码；本稿所有 Pixelle 内容均为行为描述与行号引用，**不含代码片段拷贝**。将来若确需引用其代码，必须按其 Apache-2.0 要求署名；**本期不引用**。
证据路径相对 `D:\project\Pixelle-Video\`，行号可核对；**未实现**=检索过无此机制。

---

## 一、Pixelle 的做法（逐项拆解）

### ① 管线分层与步骤编排

- **两层模板方法**：`BasePipeline`（`pixelle_video/pipelines/base.py` L28-117，抽象 `__call__` + `_report_progress`）→ `LinearVideoPipeline`（`pipelines/linear.py` L66-123）固定 8 个生命周期步骤：
  `setup_environment → generate_content → determine_title → plan_visuals → initialize_storyboard → produce_assets → post_production → finalize`
- **状态载体**：`PipelineContext` dataclass（`linear.py` L34-63），字段分四类：输入(input_text/params/progress_callback)、任务态(task_id/task_dir)、内容(narrations/image_prompts/config/storyboard)、产出(final_video_path/result)。步骤间只传 ctx，不互相调用。
- **变体**：`StandardPipeline`/`CustomPipeline`/`AssetBasedPipeline` 覆写步骤（`pipelines/standard.py` L55-78 起）。
- **失败处理**：`__call__` 里 `try/except → handle_exception(ctx, e) → raise`（`linear.py` L121-123、L159-161）；**无步骤级重试、无断点续跑**——全仓 `checkpoint`=0、`resume`=0。
- **重试只在厂商客户端**：`_with_network_retry`（`services/api_services/video_dashscope.py` L80-108）：`max_attempts=5`、`delay=min(3*attempt,20)`、仅重试可重试异常（L111-125），且注释明确 **不掩盖 provider 侧任务失败**。

### ② 文案与分镜生成（两段式）

- **第一段 narrations**：`generate_narrations_from_topic`（`utils/content_generators.py` L95-170）：LLM → JSON `{narrations}` → 校验 key（L137-138）→ **VO 黑名单命中则带"重写要求"重试一次**（L145-160）→ 数量多了截断、少了报错（L163-167）。
- **第二段 image_prompts**：`plan_visuals`（`pipelines/standard.py` L154-213）：先按模板类型判断是否需要媒体（`template_requires_media`），再 `generate_image_prompts(narrations, min_words=30, max_words=60)`（L200-206），最后拼 `prompt_prefix`（L208-213）。
- **结构化输出**：`_call_with_structured_output` 把 JSON schema 指令追加到 prompt 再解析（`services/llm_service.py` L210-259），换取兼容性（L223 注释）。

### ③ 素材生成与厂商适配（最值得学的一层）

- **模型清单**：`IMAGE_MODELS`（`services/api_media.py` L23-38）、`VIDEO_MODELS`（L40-63）按 provider 分组。
- **能力表** `VIDEO_MODEL_CAPABILITIES`（L65 起，示例 L66-119），每个 (provider, model) 一条，字段设计是核心：
  - `ability_type` / `ability_types`（产品宣称能力）**vs** `adapter_ability_types`（适配器实际实现的能力）
  - `input_modalities` vs `adapter_input_modalities`
  - `duration: {min, max, integer, verified}`、`resolutions`、`ratios`、`fps`、`format`
  - `api_contract_verified`、`contract_issues`（如 L82-84 "Quick Create 不生成首帧"）、`source_urls`
- **客户端分派**：`ImageClient`（`api_services/image_client.py` L19-93：dashscope/seedream/gpt 三个子客户端）与 `VideoClient`（`api_services/video_client.py` L25-95，`_generate_wan/_generate_kling/_generate_seedance` L231-307）。
- **按能力路由**：`supports_text_to_video = "text_to_video" in adapter_ability_types`（`api_media.py` L531-532）。

### ④ 配音与成片装配

- **TTS 三模式**：`local`（edge-tts）/`dashscope|api|qwen`/`comfyui`（`services/tts_service.py` L114-155），工作流与音色参数化。
- **帧处理四步**：`_step_generate_audio → image → render → segment`（`services/frame_processor.py` L49-137，音频步 L151-194）。
- **音频时长驱动视频时长**：文件头注释即写明 "Audio duration from TTS is passed to video generation workflows to ensure perfect sync (no padding, no trimming needed)"（`frame_processor.py` L19-20）；音频时长取不到时按文件大小估算兜底（L460-466）。
- **HTML 模板 → 图片**：`HTMLFrameGenerator` 用 **Playwright 无头 Chromium** 渲染模板（`services/frame_html.py` L16-46）。
- **拼接与 BGM**：ffmpeg-python 的 `concat_videos` / `add_bgm`（`services/video.py` L16-88、L99+）。
- **模板类型决定管线**：static 模板**跳过**媒体生成，注释直接写"更快 + 更省 + 不依赖 ComfyUI"（`standard.py` L167-169）。

### ⑤ 任务与状态管理

- **TaskManager 纯内存**：`Dict[task_id]→Task` + `Dict[task_id]→asyncio.Task`（`api/tasks/manager.py` L29-45）；状态机 `PENDING/RUNNING/COMPLETED/FAILED/CANCELLED`（L129-146、L209-236，终态不可取消 L224）；`update_progress(current,total,percentage,message)`（L181-207）；每 `cleanup_interval` 清理超过 `retention_time` 的终态任务（L238-265）。
- **路由**：`GET /tasks`、`GET /tasks/{id}`、`DELETE /tasks/{id}`（取消）（`api/routers/tasks.py` L28-79）。
- **落盘**：`PersistenceService`，目录 `output/{task_id}/{metadata.json, storyboard.json, final.mp4, frames/01_audio.mp3, 01_image.png…}` + `.index.json` 快速列表（`services/persistence.py` L28-72）。
- **注意**：任务态与磁盘 storyboard 是两套真相；**进程重启后内存任务全丢**（无恢复机制）。

### ⑥ 成本控制与降级路径

- **系统级成本控制：未实现**（全仓 `pricing`=0、`price`=0；`cost` 仅出现在注释，`budget` 仅 VO 预算）。
- 实际存在的省钱手段：VO 字数预算 `vo_budget` + 超预算提示"优先删修饰词，不提高语速"（`utils/vo_rules.py` L69-90）；便宜模型注释（`api_media.py` L25 `z-image-turbo` 约 ¥0.1/张）；static 模板跳过媒体生成（`standard.py` L167-169）；local TTS 免费。
- 即：**没有"预估 → 用户确认 → 硬上限 → 记账"这套闸门**，只有若干局部省钱默认值。

---

## 二、miaodraw 自建方案

### 2.1 模块划分（`src/main/video/`）

```
main/video/
├── index.ts        步骤编排（对标 linear.py 的模板方法，但每步可跳过/可重入）
├── script.ts       文案/分镜：LLM → narrations → image_prompts（含校验 + 黑名单重写）
├── tts.ts          配音：百炼 TTS（本地 edge-tts 作降级）
├── shots.ts        镜头素材：出图 / 出视频（复用现有 generate 链路，百炼直连）
├── frame.ts        帧渲染：用 Electron 离屏窗口渲染 HTML 模板（不引入 Playwright）
├── compose.ts      合成：ffmpeg 拼接 + 可选 BGM
├── cost.ts         成本护栏：预估 / 确认 / 上限 / 记账
└── jobs.ts         作业状态：以 work_item 为粒度持久化，支持重试与续跑
```

### 2.2 与 O1/B/C 的关系（不另起一套编排）

视频不算新体系，而是 **workflow `doc-to-video` 的 executor 实现**：`plans/stages` 管阶段与闸门（O1/B/C 已定），`main/video/*` 只是 executor 调用的一组步骤。落点：

| Stage（示例） | 执行者 | 产物 |
|---|---|---|
| brief/script | planner 物化文档节点 + `script.ts` | 文档卡（画布文本节点） |
| shots | `shots.ts` 逐 work_item | 每个镜头一个 image/video 节点 |
| tts | `tts.ts` | 音频资产（**不落画布**，见 2.3） |
| compose | `frame.ts` + `compose.ts` | 成片节点（`final`）+ `mix` 音频资产 |

### 2.3 节点与数据流（哪些上画布、哪些留主进程）

依 O1 裁定（画布只放文档与产物节点，不进中间态）：

- **上画布**：脚本/分镜文档卡、每个镜头的图/视频卡、成片卡
- **留主进程**：TTS 中间音频、每帧渲染的 PNG、ffmpeg 中间文件——只进 `assets` 表，成片完成后按需"提升"为节点
- 计划本体仍是文件/IndexedDB 记录，计划卡是视图

### 2.4 数据模型（复用 M1，新增一张作业表）

**复用**：`assets`（`id/path/quick_hash/full_hash/mime_type/duration_ms/superseded_by`）、`asset_dependencies`（`child_id/parent_id/role/input_index/operation`）。

**新增 `video_jobs` store**（IndexedDB，DB_VERSION+1，仅追加）：

```ts
interface VideoJobRecord {
  id: string              // = `${plan_id}:${stage_id}:${work_item_id}`（Jeff 批的 job key，天然幂等）
  plan_id: string; stage_id: string; work_item_id: string
  shot_index: number
  kind: 'tts' | 'image' | 'video' | 'frame' | 'compose'
  provider?: string; model?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  attempts: number; last_error?: string
  prompt_hash?: string    // 同 prompt 复用已成功产物
  request_id?: string     // 付费提交幂等键（见下）
  paid: boolean           // 是否花钱：付费 job 必须已通过闸门
  output_asset_id?: string
  started_at?: number; finished_at?: number
}
```

**幂等与"不重复付费"硬规则（Jeff 批，写死在 `jobs.ts`）**：

1. **job key 三键**：`planId / stageId / workItemId` 拼成主键；创建用 `put` 覆盖语义，重复调用不产生第二条
2. **提交前必查**：任何一次执行先查既有 job —— `status==='done'` 直接复用产物（不重复付费）；`status==='running'` 先对账产物是否已落盘，落盘则转 `done`，未落盘才允许重提
3. **付费提交带 request_id**：付费 job 的 `request_id = hash(planId|stageId|workItemId|promptHash)`，同一 request_id 的服务端提交视为重放（本地留 `request_id` 记录，冲突即视为已提交）
4. **续跑只重跑未完成 item**：`video:resume` 只处理 `failed` / `running`（后者先对账），`done` / `skipped` 一律跳过；不做整段重跑
5. **次数上限**：同一 job 自动重试 ≤2 次，超限置 `blocked` 并给最短提问（对齐 MiniMax `media-agent.md` L184）

血统边写法（对齐 M1 的 role/operation 约定）：镜头图 `child=shotImage, parent=refAsset, role='reference', operation='t2i|i2i'`；成片 `child=final, parent=shotImage(按 input_index 排序), role='derived', operation='compose'`。

### 2.5 IPC 契约（新增 6 个通道 + 1 事件，须同步 preload + `renderer/src/types.ts`）

| channel | 入参 | 返回 |
|---|---|---|
| `video:plan` | `{stageId, workItems}` | `{shots, estimatedCost, currency, modelMix}` ← **只预估不执行** |
| `video:run` | `{stageId, confirmToken}` | `{jobIds}`（`confirmToken` 由 plan 闸门签发） |
| `video:cancel` | `{stageId}` | `{ok}` |
| `video:resume` | `{stageId}` | `{retriedJobIds}` |
| `video:jobs` | `{stageId}` | `VideoJobRecord[]` |
| `video:cost` | `{planId}` | `{spent, remaining, byStage}` |
| 事件 `video:progress` | ← 主进程 | `{jobId, stageId, percent, message}` |

### 2.6 成本护栏（fail-closed；与 `docs/todo-cost-guard.md` 合并为同一份现状说明）

**现状（两份文档已对齐，以此为准）**：`docs/todo-cost-guard.md` 记录的待办即本节的 V2 内容——视频节点当前"点一下就跑"，用户事前看不到花费；`doc-to-video` workflow 的 `video` 阶段已标 `"paid": true`（`src/main/orchestrator/workflows/doc-to-video.json` L50）但 UI 未拦截。价目表见该文件第 3 节（z-image-turbo ¥0.1/张、wan2.7-image ¥0.2/张已核实；视频档位**待补**）。

1. **预估**：`video:plan` 按镜头数 × 单价表给出「最少/预计/最坏」三档；价格未收录时显示"按量计费，无法预估"并要求显式勾选
2. **确认（闸门签发凭证）**：进入 `plan_review` 闸门，用户确认后由 **主进程**签发一次性 `confirmToken`（绑定 `stageId + revision + 付费项哈希`，用后作废）
3. **硬上限**：`settings.videoBudget`；累计 `spent` 超限立即停并置 `blocked`，提示已花/剩余/继续需要多少
4. **记账**：每次付费调用写 `plan_events`（actor=auto，含金额与 request_id）+ 本地 `usage` 计数；`video:cost` 可查

**fail-closed 落点（不靠 UI 约定，Jeff 硬要求）**：
- 强制点在**主进程**：`video:run` 校验 `confirmToken` 的 stageId/revision/付费项哈希与当前 stage 一致，且 `spent + 本次预估上限 ≤ videoBudget`；任一不满足直接拒执行（返回 `COST_GATE_REQUIRED`），**不发起任何付费请求**
- `paid: true` 的 work_item 在 `plan_events` 中没有对应确认事件时，executor 一律拒绝执行（事件即凭证）
- 价格缺失（"无法预估"）时：默认**拒绝付费执行**，仅在用户显式勾选"接受按量计费"后签发 token

### 2.7 失败与续跑（对齐 Pixelle 的短板）

- 粒度：**work_item 级**重试，不重跑整段；已成功产物按 `prompt_hash`/`quick_hash` 复用（这正是 M1 指纹设计的用武之地）
- 幂等：见 §2.4 的 5 条硬规则——提交前查 job、付费提交带 `request_id`、续跑只碰未完成 item
- 状态：`video_jobs` 持久化 → 重启后 `video:resume` 只重试 `failed`/`running`（后者先对账产物是否已落盘）
- 上限：同一 job 自动重试 ≤2 次，超限置 `blocked` 并给最短提问
- 事件：每次重试写 `plan_events`（含 `attempts`、金额、`request_id`），可追溯

### 2.9 离屏渲染失败降级路径（Jeff 要求写清，别让成片环节变黑盒）

`frame.ts` 用 Electron 离屏 `BrowserWindow`（`webPreferences.offscreen` + `capturePage`）渲染 HTML 模板，替代 Playwright。**失败时不静默出黑帧**，按以下顺序降级：

| 级别 | 触发 | 处理 |
|---|---|---|
| R1 重试 | 首次渲染超时 / `capturePage` 抛错 | 同参数重试 1 次（间隔 500ms）；仍失败进 R2 |
| R2 简化模板 | 模板含外部资源（字体/图片 URL）导致超时 | 剥离外部资源（`webRequest` 拦截 http(s) 请求 → 回落到本地占位），重渲染 1 次 |
| R3 确定性兜底 | 简化后仍失败 | 用 ffmpeg 合成"纯色/底图 + 文字叠加"的降级帧，并在 job 上标 `degraded: true` |
| R4 fail-closed | 兜底也失败 | job 置 `failed`，stage 转 `waiting_user(result_review)`，审阅卡明示"第 N 帧渲染失败 + 原因 + 重试按钮"；**不产出无声黑帧，不静默继续** |

约束：**每一级都写 `plan_events`**（level + 原因），成片完成后若存在任何 `degraded` 帧，成片卡上显示"含 N 帧降级"标识（可追溯，不假装正常）。

### 2.8 里程碑

| 期 | 内容 | 明确不做 |
|---|---|---|
| **V1** | `script.ts` + `tts.ts` + `shots.ts`（只出图）+ `compose.ts`（图+音 → mp4）；跑通 `doc-to-video` 一个 workflow | 视频生成、BGM、字幕 |
| **V2** | 成本护栏（预估/确认/上限/记账）+ `video_jobs` 续跑 | 多厂商视频矩阵 |
| **V3** | 出视频镜头（百炼 i2v，逐个镜头显式确认成本、默认关） | 多厂商视频矩阵 |
| **V4** | HTML 模板帧渲染（Electron 离屏）+ 字幕烧录（显式 opt-in） | BGM 自动创作、转场风格 |

---

## 三、从 Pixelle 学到的 5 条关键设计

1. **产品能力与适配器能力显式分离**：`ability_types` vs `adapter_ability_types` + `contract_issues`（`api_media.py` L66-84）。直接治我们"文档说支持、代码没实现"的假功能问题——把这张表搬进我们的能力注册表。
2. **模板/产出形态决定管线分支**：static 模板跳过媒体生成（`standard.py` L167-169）。按产出裁剪步骤，不无脑全流程跑。
3. **音频时长驱动视频时长**：先出音再定帧长，不补不裁（`frame_processor.py` L19-20）。比"先定长再硬凑音频"可靠得多。
4. **数值合同进能力表**：`duration {min,max,integer,verified}` / `resolutions` / `ratios` / `fps`（`api_media.py` L72-76），调用前校验而不是失败后猜。
5. **网络重试与业务失败分离**：只重试可重试异常，不掩盖 provider 任务失败（`video_dashscope.py` L80-108、L111-125）。

## 四、我们刻意不学的部分

| 不学 | 理由 |
|---|---|
| TaskManager 纯内存、无断点（`manager.py` L29-45；checkpoint/resume 全仓 0） | 用户会重启应用；我们必须以 `video_jobs` + plans 持久化做续跑 |
| Playwright 无头渲染 HTML（`frame_html.py` L16-46） | Electron 自带渲染器，用离屏 BrowserWindow 即可，省一个 Chromium 依赖 |
| 无成本闸门（`pricing`/`price` 全仓 0） | 用户对价格敏感，预估+确认+上限是硬需求 |
| ComfyUI 工作流体系（`comfy_base_service.py`） | 本期只走百炼 REST；引入 ComfyUI 会带来第二套编排 |
| DashScope/OpenAI/Seedream/Kling/Seedance 全矩阵（`api_media.py` L23-63） | 先只接现有百炼；能力表用"结构"不用"全量模型清单"，避免维护真空 |
| `.index.json` 单文件索引（`persistence.py` L70-72） | 我们已有 IndexedDB assets + 血统边，无需第二套索引 |
| per-frame 全量重算 | 我们按 work_item 增量 + 指纹复用 |

---

## 五、差异说明（v1 → v2，落实 Jeff 四点批复 + 里程碑对齐）

| # | 批复 | 落点 | 变化 |
|---|---|---|---|
| ① | **video_jobs 幂等**：job key = `planId/stageId/workItemId`，付费提交前先查既有 job | §2.4 类型定义 + 新增「幂等与不重复付费硬规则」5 条 | 主键由 `work_item.id` 改为三键拼接；新增 `request_id`、`paid`、`work_item_id` 字段；明确「提交前必查既有 job，done 直接复用、running 先对账」；付费 `request_id = hash(planId\|stageId\|workItemId\|promptHash)` |
| ② | **成本护栏 fail-closed** | §2.6 重写 + 与 `docs/todo-cost-guard.md` 合并为同一份现状说明 | 四步（预估→确认→硬上限→记账）每步给落点；新增**主进程强制点**：`video:run` 校验一次性 `confirmToken`（绑定 stageId/revision/付费项哈希，用后作废）+ `spent+上限 ≤ videoBudget`，不满足返回 `COST_GATE_REQUIRED` 且**不发任何付费请求**；无确认事件即拒执行；价格缺失默认拒绝，需显式勾选 |
| ③ | **离屏渲染失败降级** | 新增 §2.9（R1 重试 → R2 剥离外部资源 → R3 ffmpeg 确定性兜底并标 `degraded` → R4 fail-closed 进 `result_review` 并给重试） | 每级写 `plan_events`；成片含降级帧时在成片卡显式标注，**不出黑帧、不静默继续** |
| ④ | **干净房间** | 文档头部「干净房间声明」 | 只学机制不抄代码；全稿仅行为描述 + 行号引用，无代码片段拷贝；将来若引用其 Apache-2.0 代码必须署名，**本期不引用** |

**里程碑对齐（避免与 Coder 在途工作重复定义）**：

- **V0 = Coder 第 0 期**（在途）：收口「直连百炼出片段 + 成本护栏」。本设计的 §2.6 就是 V0 成本护栏的规格；出片段实现即 §2.2 表格中 `shots` 阶段的 executor，**本设计不另定义接口**。
- **V1 起**：消费既有 workflow 定义 `src/main/orchestrator/workflows/doc-to-video.json`（stage `brief/shots/narration/video`；`video` 阶段已标 `"paid": true`，`execution_locks` 已有 `aspect_ratio=9:16`、`resolution=720P`）——V1 只补 `script.ts`/`tts.ts`/`compose.ts` 与 job 续跑，**不重写 stage 拓扑**。
- V1~V4 与原表一致；V0 完成前不启动 V1 的付费链路验证（沿用 `todo-cost-guard.md` §2 的内部测试纪律：最多 1 分镜、最低分辨率、静音，并写明实际花费）。

**变更说明（v2.1，2026-10-15，Chief 通知）**：用户**彻底否决 Pixelle**。据此：
- V3 行由「出视频镜头（百炼 i2v）+ Pixelle 作为可选出片后端（保留现有代理）」改为「出视频镜头（百炼 i2v，逐个镜头显式确认成本、默认关）」
- 全文清理「把 Pixelle 当运行依赖」的措辞：`shots.ts` 说明改「复用现有 generate 链路，百炼直连」；「刻意不学」表里 ComfyUI 行改「本期只走百炼 REST」、厂商矩阵行改「先只接现有百炼」
- **保留**部分（作为参考书的行为描述与行号引用，不构成依赖）：标题「参考 Pixelle-Video」、头部边界与干净房间声明、§一 全部拆解、§三 学到的 5 条、§2.7「对齐 Pixelle 的短板」
