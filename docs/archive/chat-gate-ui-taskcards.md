# C 批次任务卡：聊天面板 + 闸门 UI

作者：Rea。状态：待 Coder 施工（先出卡，未写代码）。规格来源：`docs/archive/chat-to-workflow-feasibility.md`；依赖 O1（已合入 `0861122`）+ B 批次增量协议。
证据约定：行号对应当前分支；契约名以 B 批次实际落地为准，若命名变更需同步本节「共用契约」。

## 共用契约与约定

**已存在（O1，实测）**
- IPC：`plan:create` / `plan:authored` / `plan:authorStage` / `plan:advance` / `plan:patchStage` / `plan:replan`(占位) / `plan:list` / `plan:delete` / 事件 `plan:changed`（`src/main/index.ts`）
- preload 暴露名：`planCreate` / `planAuthored` / `planAdvance({planId, stageId, action, expectedRevision})`，动作：`confirm_plan` / `execution_done` / `confirm_result` / `retry`；冲突返回 `{ok:false, conflict:true}`
- 数据：`plans`/`stages` store（`src/renderer/src/canvas/db.ts` L86-95，`DB_VERSION=2`），类型源 `src/shared/plan-types.ts`，落盘 `canvas/plan-persistence.ts`
- 探针范式：`src/main/index.ts` L857 `SHOT_PLAN_O1 === '1'` → `executeJavaScript` 驱动渲染层 → `check()` 判定，`[shot]` 日志

**B 批次应提供（本批依赖，未落地则先按此实装）**
- `plan:chat({planId, message, requestId})` → 三档分类结果（patch / replan / new_plan）
- `plan:setAutoAdvance({planId, enabled, expectedRevision})`
- `plan:events({planId, limit})` 读审计流；字段集（已批准）：`event / actor(chat|ui|auto) / stage_id / before→after revision / request_id / source_message_id`
- 每个新通道都要同步改 `src/preload/index.ts` + `src/renderer/src/types.ts`（`env.d.ts` 不用改）

**订阅模型（与 P1-10 关联，务必遵守）**
不用全局 `useCanvasState()` 承载对话/计划刷新（会连累全画布重渲染，P1-10 已确认要改）。
对话与计划各自独立 store + 按 id 选择器订阅（`getPlanSnapshot(planId)` + `subscribePlan(planId, cb)`），画布只订阅"计划卡节点"自身。
**P1-10 与 C1 联合落地，不分两次动订阅层**；验收含「对话滚动时画布零重渲染」探针（见 C1），不靠口头约定。

**界面约束（Jeff 2026-10-14 批）**
- **不得新增画布节点类型**：`plan` 是唯一新增节点类型（O1 已定）；对话面板/闸门 UI 走**画布级 overlay**，不落成节点
- 需要在卡上展开阶段详情时，**仍在 `plan` 卡内部渲染**，不引入子节点
- 本批不碰打包：不涉及 `build:win` / 安装包相关改动

## C1 对话面板骨架

- **目标**：画布模式下的「计划对话」面板（消息列表 + 输入框 + 发送），消息持久化、重启仍在。
- **涉及文件**：新增 `src/renderer/src/canvas/ChatPanel.tsx`、`canvas/chat-store.ts`；改 `canvas/CanvasWorkbench.tsx`（挂右侧栏，AntD5 Sidebar/Drawer）；改 `canvas/db.ts`（`DB_VERSION`→3，新增 `messages` store，索引 `plan_id`、`created_at`）
- **交互细节**：消息类型 `user|agent|tool|system`；发送不阻塞（`plan:create` 立即返回 `drafting`，进度靠 `plan:changed`）；打字期间不受画布拖动影响；历史只渲染最近 50 条（不做虚拟化）
- **验收**：`SHOT_PLAN_CHAT=1`：① 打开面板输入需求 → 断言 `messages` store 有 user 行且 `plan:create` 返回 `status==='drafting'`；② 重开窗口 → 断言消息与计划仍在（`plan:list` + messages）；③ 发送后立即操作画布（拖一次节点）断言无阻塞；④ **`SHOT_PLAN_CHAT_RERENDER=1`**：在画布上注入重渲染计数器（CanvasNode render 打点），滚动对话 500px + 收发各 5 条消息，断言**画布节点渲染次数为 0 增量**（P1-10 联合验收）
- **风险**：DB 版本升级与既有 v2 数据兼容（必须走 `onupgradeneeded` 增量建 store，禁止删除重建）；面板与画布快捷键冲突（`InfiniteCanvas` 的 Space/Delete 已监听窗口，需在输入框聚焦时排除——现有 `isFormTarget` 逻辑可复用）
- **迁移硬约束（Jeff 2026-10-14 批，** v2→v3 必须按现有方式做**）**：
  - 只在 `onupgradeneeded` 里**追加** `messages`（沿用 `db.ts` L63-96 的 `if (!contains(...))` 风格），`DB_VERSION` 2→3、`SCHEMA_VERSION` 同步
  - **保留既有 v1→v2 迁移断言**：`db.ts` L98-115 的 `superseded_by` 回填 + `assertAssetsMigrated()`（`plan-persistence.ts` L23-28 调用）不得删除或短路；v3 升级后仍要跑并通过
  - 升级失败（断言不通过 / 创建 store 抛错）按 O1 做法**中止并保留旧版本库**，不自动降级、不删库；错误只记日志并提示
  - 验收补一条：`SHOT_PLAN_CHAT=1` 内断言 `meta.schema.version === 3` 且 `assetsChecked > 0`（证明旧断言仍在跑）

## C2 计划卡 ↔ 对话双向等价确认

- **目标**：同一 stage 的「确认/修改」在聊天与计划卡上等价，单一数据源刷新。
- **涉及文件**：新增 `canvas/PlanCard.tsx`（计划卡节点，`NODE_SPECS.plan` 已定 420×520）；改 `chat-store.ts`、`canvas/CanvasNode.tsx`（新增 `plan` 分支）、`canvas/CanvasWorkbench.tsx`（`plan` 节点的产物布局）
- **交互细节**：卡片按钮 → 生成等价消息并发送（如"确认第 2 阶段"），与用户手打同一路径；聊天里判定为确认 → B 批次的分类器决定走 `plan:advance`；两条路径均以 `plan:changed` 为唯一刷新源；镜像消息用 `source_message_id` 去重（避免"卡片点一次、聊天多一条"）
- **验收**：`SHOT_PLAN_CHAT_GATE=1`：同一计划的两个 stage 分别用「卡片按钮」和「聊天消息」确认，断言最终 stage 状态序列一致；断言 `plan:events` 中 actor 分别为 `ui` 与 `chat`；断言无重复镜像消息（同 `source_message_id` 仅一条）；**断言 `plan:events` 中不存在"无对应消息"的幽灵记录（去重必须先于写事件）**
- **风险**：双向镜像重复/回环（**`source_message_id` + `request_id` 双键去重，且去重判定必须在写入 `plan:events` 之前**，否则事件流出现幽灵记录——Jeff 硬约束）；自动推进与手动确认竞态（全部走 `expectedRevision` CAS，冲突按 C3 处理）

## C3 闸门审阅卡（prompt/refs/锁项 + 行内编辑）

- **目标**：`waiting_user(plan_review | result_review)` 时，在**聊天消息流内**渲染锚定到消息的审阅卡；`plan_review` 可编辑 work_items 的 prompt。
- **涉及文件**：新增 `canvas/StageReviewCard.tsx`；改 `ChatPanel.tsx`（按 `plan_id + stage_id` 注入卡片）、`chat-store.ts`（锚点：`findStageReviewAnchor` 等价物）、`plan-persistence.ts`（读 stage 快照）
- **交互细节**：默认折叠显示"阶段名 + 检查项摘要 + 产物数"；展开显示每条 work_item 的 prompt、有序 refs、`execution_locks`（画幅/模型）；编辑走 `plan:patchStage({expectedRevision})`；冲突时提示"计划已更新"并保留草稿（不静默丢弃）；`result_review` 卡片只展示产物缩略图/路径 + 通过/打回
- **验收**：`SHOT_PLAN_CHAT_REVIEW=1`：① 断言卡片渲染出 prompt 文本与 review 文案；② 行内编辑 prompt → 断言 `patchStage` 成功且 revision+1、卡片更新；③ 用过期 revision 触发冲突 → 断言 UI 进入"需刷新"态（给卡片加 `data-conflict="true"` 便于断言）且草稿仍在
- **风险**：prompt 过长（默认折叠 + 前 300 字 + 展开按钮）；编辑期间主进程自动推进导致 revision 漂移（编辑前重读一次、提交用最新 revision）

## C4 自动推进开关（信任后自动）

- **目标**：计划卡标题栏 ⚡ 开关 + 徽章；开启后无需人工确认即可推进，遇 `blocked` 立即退回手动并提示。
- **涉及文件**：`PlanCard.tsx`、`chat-store.ts`；IPC `plan:setAutoAdvance`（B 批次；未落地则由本卡补 main+preload+types 三处）
- **交互细节**：开关状态来自 `PlanRecord.auto_advance`；开启时卡片与聊天各显示一次"自动推进中"（只在状态切换时插入一条 system 消息，不逐阶段刷屏）；blocked/失败 → 自动置 false 并入一条 system 消息说明原因
- **验收**：`SHOT_PLAN_CHAT_AUTO=1`：① 开启后走完一阶段，断言无需 `confirm_plan` 即到 `done`，且 `plan:events` 中该阶段 actor 为 `auto`；② 构造 blocked（缺 refs）→ 断言 `auto_advance` 被置 false 且有提示消息
- **风险**：自动跑飞（仅在 review 为空或同类阶段已确认过时允许自动；任何 blocked/失败立即转手动）；与 C2 手动确认竞态（同一 CAS 通道）

## C5 冻结前缀与修改边界提示

- **目标**：已确认/已完成阶段标「已冻结」；用户要求改冻结区时先提示影响范围与处理方式（新建计划 / 从当前阶段重排），再决定是否提交。
- **涉及文件**：`PlanCard.tsx`、`StageReviewCard.tsx`、`chat-store.ts`
- **交互细节**：冻结阶段在卡片加 `data-frozen="true"` 且不可编辑；聊天里命中冻结区的修改请求 → 插入确认卡（展示"将新建计划 / 从第 N 阶段重排"两选项），用户选定后才调 `plan:chat`/`plan:replan`
- **验收**：`SHOT_PLAN_CHAT_FREEZE=1`：走完一阶段后 ① 断言前置阶段 `data-frozen="true"`、patching 该阶段被拒；② 发"把第一步改成横屏" → 断言出现范围确认卡且**未**直接落库（`plan:events` 无对应变更）
- **风险**：提示过度打扰（只在触及冻结区时出现）；分类误判（最终由 B 批次三档分类决定，UI 只做确认，不自己判断）

## C6 空态 / 异常态 / 断线恢复（收尾）

- **目标**：`drafting` 骨架卡、`stale`（>60s 无进展）"规划中断，重试"、事件丢失后的全量重拉。
- **涉及文件**：`ChatPanel.tsx`、`PlanCard.tsx`、`plan-persistence.ts`
- **交互细节**：`plan:changed` 仅推增量时，若检测到 revision 跳变/缺口 → 调 `plan:authored` 全量重拉；`stale` 卡片提供重试按钮（走 `plan:chat` 重发或 B 批次提供的重试入口）
- **验收**：`SHOT_PLAN_CHAT_RECOVER=1`：① 造 stale 计划 → 断言出现重试入口且点击后能重新推进；② 手动丢一次事件后 → 断言全量重拉使卡片与 IndexedDB 一致
- **风险**：重拉风暴（限一次 + 200ms 防抖）；stale 误判（后台任务仍在跑时不得标 stale，需 B 批次暴露活跃标志）

## 实施顺序与探针清单

```
C1 面板骨架 ──▶ C2 双向等价确认 ──▶ C3 审阅卡 ──▶ C4 自动推进 ──▶ C5 冻结边界 ──▶ C6 异常态
                     （C3/C4/C5 可在 C2 后并行，均改同一批文件，建议串行避免冲突）
```

| 探针 | 覆盖 |
|---|---|
| `SHOT_PLAN_CHAT=1` | C1 |
| `SHOT_PLAN_CHAT_GATE=1` | C2（含 plan_events actor 断言） |
| `SHOT_PLAN_CHAT_REVIEW=1` | C3 |
| `SHOT_PLAN_CHAT_AUTO=1` | C4 |
| `SHOT_PLAN_CHAT_FREEZE=1` | C5 |
| `SHOT_PLAN_CHAT_RECOVER=1` | C6 |

估时：C1 3-4d、C2 2-3d、C3 3-4d、C4 2d、C5 1-2d、C6 1-2d，合计约 **8-10 个工作日**（串行；并行可压到 6-7d，但文件重叠需协调）。

## 本批不做

- 不做多会话/多计划并排（单计划单面板，`plan:list` 只用于恢复）
- 不做流式 token 渲染（先整段返回；B 批次有流式再加）
- 不做消息搜索/导出
- 不做移动端/窄屏布局
- 不改 P1-10 的视口重渲染范围（本批只保证对话/计划不触发全画布重渲染）
