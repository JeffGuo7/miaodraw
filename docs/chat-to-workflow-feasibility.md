# 聊天式构建/修改工作流：可行性与实现路径

作者：Rea。状态：待 Jeff 审（先不提交）。
证据来源：`D:\project\minimax-skills\`（明文 md）、`mcp-tools/dist/main.js`、`D:\project\minimax-design-src\app\out\renderer\assets\index-BBp4hclA.js`、gateway `dist/main.js`；我方代码 `src/main/agent.ts`、`src/main/tools.ts`、`docs/orchestration-design.md`（O1）。
读法约定：带行号=md 明文；带「bundle」=编译产物字面量（已核对的原文片段）；**未找到**=检索过但无证据，不做推测。

---

## 一、MiniMax 是怎么做的（逐问回答）

### ① 有没有真的聊天界面？—— 有，且聊天是主交互面

- 主 agent 是「面向用户的编排器」，有交付回复、有"先说一句再继续"的回合语义：
  `minimax-skills/v2/config/agents/media-agent.md` L1、L16-17（L17：客户端把回复里的文件名渲染成**可点击的画布锚点**）
- 确认动作发生在**聊天或看板**两处，且被明确视为等价：
  `media-agent.md` L101「Treat an explicit confirmation in ordinary chat and a Production Board confirmation identically」；
  bundle `plan_get_stage_status` 描述：「next_action=wait_for_user means **send a short normal chat message and end the turn** so the user can confirm or revise **in chat or Production Board**; do not call the question tool」
- 运行时确有聊天会话层：`v2/config/plugins/session-header.ts` L112-116 挂 `chat.message` / `chat.headers`（OpenCode 会话/计费 scope），L121-127 处理 `sessionID` 空值
- 客户端确有聊天 UI 与计划卡：renderer bundle `index-BBp4hclA.js` 有 `chat.toolLabel.planGetStageStatus` 等工具标签映射、`chat-case-DWvxAA_H.js` L175 含 `waiting_reason:"plan_review"` 夹具
- **未找到**：任何"仅表单式输入、无聊天"的证据；也没有"聊天输入 → 先落表单再确认"的流程。

### ② 增量改计划还是整篇重建？—— **增量**，且有明确的三档分类

- 用户提修改时先**分类**，再决定走哪条：
  `media-agent.md` L118：当前 Stage 合同的小修正 = `stage_patch`；当前或之后 Stage 骨架变化（仍在同一 workflow 绑定内）= `replan`；换 `workflow.path/variant` = 回 router 建**新 plan**
- 增量执行方式：planner 只收**delta + plan_id**，读最新 revision 后提交**一次原子 suffix 更新**；当前 Stage 之前的一切作为固定输入前推：
  `media-agent.md` L130-131；`planner.md` L67「do not ... rebuild the plan from scratch. Patch one local Stage correction with stable ids」、L86-88
- 幂等与重放：bundle `plan_replan` 描述「keep the same plan_id and workflow binding ... Replan is atomic; `request_id` safely identifies duplicate submissions ... Reusing it replays the saved result while the plan remains at the applied revision」
- 单 Stage 本地改动走 `plan_patch_stage`（upsert/remove/omit，带 `expected_revision`）——bundle 工具描述
- **整篇替换存在但被限定**：bundle `plan_write` 描述「Create or **fully replace** the JSON Stage Execution Plan ... Use expected_revision for a guarded replacement」，且 `plan_replan` 描述明确「Do not use plan_write to replace the whole plan」

### ③ 版本 / 修订机制 —— 有，且是 CAS + 幂等键 + 冻结前缀

| 机制 | 证据 |
|---|---|
| 计划级 revision + CAS | bundle `plan_update_stage_state`：「`expected_revision`: Optional plan revision CAS guard. Re-read and retry on conflict.」 |
| 冲突结构化报错 | gateway `dist/main.js`：`` `Stage plan revision conflict: expected ${expected}, found ${plan.revision}. Re-read the plan and retry.` ``，`code: PLAN_REVISION_CONFLICT`，`current_state:{expected_revision, actual_revision}`，`allowed_actions:["reread_plan"]` |
| 请求幂等 | `stage-execution-plan.md` L144「Pass the latest `expected_revision` and a fresh `request_id`. The same id and payload are idempotent; on revision conflict, re-read the plan and rebuild the request.」 |
| Stage 状态 CAS | `media-agent.md` L114（`status=doing` + `expected_status=waiting_user`）、L117（`blocked→doing` 须 CAS 成功后再派发） |
| 冻结前缀 | planner 入参/`planner.md` L88 `preserve_through_stage_id`；bundle `plan_replan`「derives the preserved prefix from the persisted Plan」 |
| workflow 绑定不可变 | `stage-execution-plan.md` L24；`plan_replan`「keep the same plan_id and workflow binding」 |
| 产物级版本 | `stage-execution-plan.md` L42：重跑后新结果进 `runtime_refs`，旧结果移入 `superseded_runtime_refs`；`mv/workflow.md` L168「该修改后的完整字符串成为该 work item 的新**冻结版本**」 |
| 资产级版本模型（v3） | `v3/config/agents/media-agent.md` L15-17：同一内容沿用 Resource、修订建新 Version |
| **未找到** | 计划的**变更历史/审计表**。gateway 建表语句里只检索到 `session_touched`、`session_watermark`（任务侧另有 `tasks.revision/state_json` + `outbox`）；没有 plan 版本的 changelog 存储证据 |

### ④ 对话 ↔ 画布/看板如何同步（哪些字段驱动渲染）

- **计划本体不是画布节点**：存文件 `.hilo/plan/<id>.json`（bundle `plan_write`/`plan_get_stage_status` 描述；`plan_get_stage_status`「never return the file body」）。画布上只有 planner 物化的**文档节点**（`document_node_id`）与产物节点
- 渲染驱动字段（renderer bundle 实证）：
  - `productionPlan.model.stages[]`、`stage.id`、`stage.status`、`stage.waiting_reason`
  - `stage.work_items[].prompt` + `stage.review.before_execution[]` → 决定"是否显示 Prompt 审阅卡"（`hasPromptContent` / `isActivePromptReview`）
  - `productionPlan.planId`、`productionPlan.revision`、`productionPlan.editable`、`isRevisionCurrent(planId, revision)` → 决定卡片可编辑性与是否需刷新
  - 审阅卡**锚定到聊天消息**：`findStageReviewAnchorMessageId(messages, planId, stage.id)`
  - 看板闸门：`showCurrentProductionGate`（`!agentRunning && currentProductionStage && waitingStageKey && ...`），`currentProductionStage` 来自 runtime stage 摘要
- 确认是**一条聊天消息**：`handleProductionPlanMessage(content)` → `sendMessage(content)`（bundle 实证）
- 给主 agent 的 stage 摘要极简：`plan_id / stage_count / stages[]`（order,id,name,goal,status,waiting_reason）+ `pending_stages`（`planner.md` L29-40）

### ⑤ 「等用户输入 / 卡住」的交互形态

- 正常等待：`status=waiting_user` + `waiting_reason: plan_review | result_review`（`planner.md` L37-38）；`next_action=wait_for_user` → **发一条简短普通聊天消息后结束回合**，不要用 question 工具（bundle）
- blocked：`blocked_reason` + 必须用 `question` 工具给出具体建议（`plan_update_stage_state`、`plan_get_stage_status` 描述）；`media-agent.md` L117 规定 blocked 下不得派发 executor
- planner 自身中途卡住：用 `question` 直接问而不是中止（`planner.md` L1）；兜底 `plan_blocked + suggested_questions`（L53-60）
- 纪律：`question` 不等于审批凭证（`AUTHORING.md` L48、L62）；不复用旧 Stage 的确认、不跨 Stage 批量确认（`media-agent.md` L121）

---

## 二、我方现状（O1 落地后）差距

| 维度 | 现状（含文件） | 差距 |
|---|---|---|
| 对话面 | 无聊天视图。`src/main/agent.ts` L120-154 是**单轮**：goal → 一次 planner LLM → JSON steps → 顺序执行；`tools.ts` L44-91 规划提示词已融入失败卡+厂商上限 | 无消息历史、无多轮、无 conversation 存储；无 `messages` store |
| 计划持久化 | O1 已定：plans/stages 入 IndexedDB + revision CAS + `plan:changed` | O1 是否已合入需 Coder 确认；`plan:replan` 目前是**占位** |
| 增量修改 | 无。改需求=重说一遍，从零重规划（`agent.ts` L129-154 每次新建 plan） | 缺 stage_patch / replan / 新 plan 三档分类与原子 suffix 更新 |
| 版本与幂等 | O1 有 revision 乐观锁；无 request_id 幂等、无冻结前缀、无 superseded 概念 | 缺 `request_id` 重放、`preserve_through_stage_id`、`superseded_by`（O1 已含字段但未接执行） |
| 审查闸门 | 无。`agent.ts` L161-264 直接跑完所有 step | 缺 waiting_user/blocked 状态机与聊天内审阅卡 |
| 聊天确认 | 无 | 缺"确认=一条聊天消息"的通道 |

---

## 三、可行性判断

**结论：可行，且比 MiniMax 方案更容易落地**——他们的复杂度来自多 agent + MCP 网关 + 多业务线；我们只需在 O1 上补"对话层 + 增量协议 + 闸门 UI"三块。

### ① 还缺什么

- **数据**：`messages` store（会话/消息/锚点：`plan_id`、`stage_id`、`revision` 快照）；`plan_events` append-only 变更记录（MiniMax 未找到此项，我们反而该加，避免"改了什么不知道"）
- **协议**：`plan:chat`（收消息 → 分类 → 产出 ops）；ops 三档：`patch_stage` / `replan`(batch，含 `preserve_through_stage_id` + `request_id`) / `new_plan`；全部带 `expected_revision` CAS；冲突返回 `PLAN_REVISION_CONFLICT` 同形结构（`current_state` + `allowed_actions`）
- **UI**：聊天面板；审阅卡锚定到消息（预览 prompt + 参考图 + 锁项）；"确认"按钮发一条消息；`auto_advance` 开关（O1 已定）状态在卡片与聊天中一致
- **成本**：planner 上下文只带当前 stage + outline + delta（不塞计划正文、不带全量历史），沿用 MiniMax `planner.md` L67/L86 的做法

### ② MVP 与工作量区间（单人）

| 批次 | 内容 | 估时 |
|---|---|---|
| A | `messages` store + 聊天面板（复用现有 `onAgentProgress` 事件风格）+ 单轮问答不改计划 | 3-4 天 |
| B | `plan:chat` + 三档分类 + `plan:replan` 实装（替占位）+ CAS/幂等/冲突回读 | 4-5 天 |
| C | 聊天内审阅卡 + 确认即消息 + 冻结前缀可视化（已确认 stage 标"已冻结"） | 3-4 天 |
| D | 提示词调优 + 误改防护测试（接 `SHOT_PLAN` 钩子：改需求只动 suffix、已 done 阶段字节不变） | 2-3 天 |

**MVP ≈ 2 周（B+C 为核心）；A+D 可后置。**

### ③ 风险点

1. **三档分类误判**（最大风险）：把 patch 误判成 replan 会重置运行时。防护：分类规则写成明确判据（照 `media-agent.md` L118）；执行前把"影响范围"回显给用户；CAS 失败强制 `reread_plan` 重建请求；不可逆操作（remove_stage）二次确认。
2. **上下文成本**：计划正文不进 prompt；只带当前 stage 合同 + outline 名单 + 用户 delta；历史仅带最近 N 轮 + 计划事件摘要。若按 MiniMax 的做法（L67 不重读来源、不重建计划）成本可控。
3. **误改已确认阶段**：冻结前缀 + `preserve_through_stage_id`；已确认 stage 的文档/产物只作为固定输入；UI 明确标注冻结边界；改动只能落在当前 frontier 及之后。
4. **并发写**（用户手改卡片 + 聊天同时改）：全走 revision CAS；冲突时提示"计划已更新，已为你刷新"并保留用户输入，不静默丢弃。
5. **无审计**：MiniMax 未找到变更历史 → 我们显式加 `plan_events`（谁改的/改了什么/旧新 revision），否则出问题无法复盘。
6. **与 O1 的耦合**：O2 的计划卡 UI 与聊天卡片是同一数据的两种视图，必须共用订阅模型（P1-10 视口重渲染那条也在这个联合设计里），不建议两套订阅。

---

## 四、给下一步的建议（供 Jeff 判断）

1. 先确认 O1 合入状态与 `plan:replan` 占位形态——MVP 的 B 批次直接建在它上面
2. 若要做，从 **B** 开始而不是 A：没有增量协议，聊天面板只是"换个地方说需求"
3. 建议同时把 `plan_events` 列入 O1/O2 范围（成本低、事后无法补救）
