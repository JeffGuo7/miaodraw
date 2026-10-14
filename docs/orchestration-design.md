# 编排设计：「说需求 → 自动搭工作流」落到 miaodraw 真实栈

状态：**二审稿**（v2，已按 Jeff 一轮意见修订）。作者：Rea。
编号口径：本设计用 **O1 / O2 / O3 / O4** 阶段名。**不再使用 M 编号**——`M4` 已被「打磨打包」占用，M5 为设置页。

设计原则：能复用的一行不新写，不引入新依赖，不做多 agent 幻想。

---

## 0. 现状锚点（全部核实过，非推测）

| 事实 | 出处 |
|---|---|
| DOM 画布（infinite-canvas 移植），节点类型 7 种：text/image/video/audio/config/group/**generate** | `src/renderer/src/canvas/types.ts` |
| 自写 store：`useSyncExternalStore` + `moveNodeSilent`/`commit` 节流 | `canvas/store.ts` |
| IndexedDB `miaodraw-canvas` v1：assets / asset_dependencies / meta | `canvas/db.ts` |
| 出图链路：`window.api.generate`（百炼）→ outputs/ + assets 行 + 血统边 | `canvas/generation.ts` |
| 视频链路：`window.api.pixelleProxy` → `POST /api/video/generate/async` → 轮询 `/api/tasks/{id}` | `canvas/videoGeneration.ts` |
| Pixelle 主进程托管：uv 拉起、`pixelle:proxy`、`pixelle:videoInfo`、退出杀进程树 | `src/main/pixelle.ts` |
| **preload 模式**：扁平 `api` 对象，`ipcRenderer.invoke`；事件订阅返回 unsubscribe 闭包（如 `onGenProgress`/`onUpdateProgress`） | `src/preload/index.ts` L12-136 |
| **渲染层类型**：`Api` 接口手写在 `types.ts` 末尾；`env.d.ts` 只做 `Window.api: Api` 挂载（**无需改动**） | `src/renderer/src/types.ts`、`env.d.ts` |
| 验收截图框架：`npm run shot` = `TEST_MODE=screenshot`，主进程用**独立 userData** `shot-session` 避免抢单实例锁 | `package.json` scripts、`src/main/index.ts` L48-50 |

**缺口**：无 plan/stage 概念、无 review 闸门、无分层路由；生成是"点一下跑一张"的节点级即时执行。

---

## 1. 目标与边界

**做**：用户写一句需求 → 系统判定生产流程 → 画布上出现一张「**计划卡**」列出阶段 → 用户确认阶段内容 → 逐阶段执行、产物自动落画布 → 每阶段产出确认后才推进下一阶段。

**不做**（本期）：
- 不做多 agent 进程/子会话拆分（单进程编排器 + 2 次 LLM 调用足够）
- 不让 LLM 决定画布布局（坐标由布局函数算）
- 不做任意 DAG 生成（workflow 从 3 个内置模板选，绑定后不可变）

**命名一致性（已定）**：节点类型（代码层）固定为 `plan`；**UI 文案统一叫「计划卡」**。
理由：MiniMax 自己的主 agent 规范里明确警告不要用泛化的 "workflow" 指代项目流程——
`minimax-skills/v2/config/agents/media-agent.md` L45：
> "Do not route a generic use of the word 'workflow' when it means a project process,
> automation, or media production plan."
「工作流」还容易和 ComfyUI 那种节点图混淆；「计划卡」指向明确。

---

## 2. 数据层（IndexedDB v1 → v2，加 3 个 store + 1 列）

`canvas/db.ts` 的 `openCanvasDB()` 已有 `onupgradeneeded` 钩子，追加即可。

```ts
// canvas/plan-types.ts（新文件）
export type StageStatus = 'pending' | 'waiting_user' | 'doing' | 'done' | 'blocked'
export type WaitingReason = 'plan_review' | 'result_review' | null

export interface WorkItem {
  id: string                    // 稳定逻辑产物 id，重跑不变
  name: string
  modality: 'image' | 'video' | 'postprocess' | 'document'
  refs: string[]
  prompt: string
  render?: { duration_target_s?: number; size?: string; model?: string }
  status?: 'pending' | 'running' | 'done' | 'failed'
  output_node_id?: string       // 完成证明
  output_asset_id?: string
  superseded_by?: string | null // 重跑后指向新产物（见 §6）
}

export interface StageRecord {
  id: string; plan_id: string; order: number
  name: string; goal: string
  status: StageStatus; waiting_reason: WaitingReason
  depends_on: string[]
  execution_locks: { aspect_ratio?: string; resolution?: string; model?: string }
  review: { before_execution: string[]; after_execution: string[] }
  work_items: WorkItem[]
  revision: number
  updated_at: number
}

export interface PlanRecord {
  id: string; title: string; prompt: string
  workflow_id: 'single-image' | 'image-to-video' | 'doc-to-video'
  status: 'drafting' | 'routing' | 'running' | 'done' | 'blocked' | 'stale'
  auto_advance: boolean          // 见 §5「信任后自动推进」
  revision: number
  stage_outline: Array<{ id: string; order: number; name: string }>
  created_at: number; updated_at: number
}
```

**迁移（v2）要求**：
1. 新增 store：`plans`（索引 `updated_at`）、`stages`（索引 `plan_id`、复合 `plan_id_order`、`status`）；`work_items` 内嵌 stage
2. `assets` 新增列 `superseded_by: string | null`
3. **迁移断言（必须写进升级逻辑，别漏）**：老数据 `superseded_by` 一律回填 `null`；断言"所有既有 assets 行的 `superseded_by` 字段存在且为 null"，断言失败则中止升级并保留 v1 库
4. 迁移可重入：按 `meta.schema` 记录版本，重复打开不重跑

---

## 3. 画布节点层（不碰现有 7 种类型，新增 1 种）

```ts
CanvasNodeType |= 'plan'
NODE_SPECS.plan = { width: 420, height: 520, title: '计划卡', metadata: { planId: '' } }
```

阶段**不做独立节点**，在计划卡内部纵向渲染（DOM 画布节点越多越卡；阶段是计划从属数据）；
某阶段的产物仍用现有 image/video 节点 + `group` 归拢。

```
┌─ 计划卡 ─────────────────┐
│ 标题 + 状态徽章 + ⚡自动   │   ← ⚡= 自动推进开关（§5）
│ ● 1 需求整理        ✅ 已确认│
│ ◐ 2 分镜出图        ⏸ 待确认│   ← 主按钮：确认 / 重试
│ ○ 3 视频合成        ⏳ 未展开│   ← 只显示名字（尚未 author）
│ [改需求]  [查看产物]       │
└──────────────────────────┘
```

连线：`CanvasConnection` 加可选 `kind?: 'input' | 'lineage' | 'stage-order'`（旧数据缺失 = 'input'，向后兼容）。

---

## 4. 编排层（主进程单进程三职责，不是三个 agent）

```
src/main/orchestrator/
├── router.ts     classify(prompt, canvasContext) → RoutingCapsule
├── planner.ts    authorFirstStage / authorNextStage / replan
├── layout.ts     计划卡与产物节点坐标（纯函数，无 LLM）
└── workflows/    single-image.json / image-to-video.json / doc-to-video.json
```

LLM 调用只有两处，复用现有百炼通道 `src/main/http.ts`：路由分类一次、当前 stage 编译一次。

**执行层可注入（为验收钩子留口）**：把现有 `generation.ts` / `videoGeneration.ts` 的
"参数收集→调用→落卡→入库"抽成 `executeWorkItem(item, adapter)`；生产用 `realAdapter`
（现有两条链路），验收用 `fakeAdapter`（本地生成 1x1 图/空文件，不打网络）。**没有这个口子，
O2/O3 就只能手点回归。**

---

## 5. Review 闸门 + 「信任后自动推进」

**默认：闸门全开**（每个 stage 都等用户确认）。**另加开关**，同一 plan 内可随时切换：

- `plan.auto_advance: boolean`，默认 `false`
- 打开后：stage 进入 `waiting_user(plan_review)` 时，若 `review.before_execution` 为空则自动确认；
  进入 `waiting_user(result_review)` 且执行成功则自动确认，并记审计字段
  `auto_advanced_at` / `auto_reason: 'auto_advance'`（进 `stage_fields`，不是 runtime 保留字段）
- **自动推进不得跳过 `blocked`**：缺素材/缺参数仍停下并提示
- UI：计划卡标题栏一个 ⚡ 开关 + 徽章显示"自动推进中"，**一键切回手动**（切换点写入审计）
- 切换语义：只影响之后发生的确认，不改写已确认的历史

这正是 MiniMax 双闸门（`plan_review` / `result_review`，见 `agents/planner.md` L37-38）
的本地化变体：默认安全，进阶省事。

---

## 6. IPC 契约（主进程；preload 与渲染层类型同步改）

### 6.1 渲染层可用接口（**必须同步这两处，M0~M3 每个里程碑都动过**）

1. **`src/preload/index.ts`**：在扁平 `api` 对象里按现有风格加方法
   （`ipcRenderer.invoke('plan:xxx', ...)`），事件订阅按 `onGenProgress` 的闭包风格写：
   ```ts
   planChanged: (cb: (e: { planId: string; stages: unknown[] }) => void): (() => void) => {
     const h = (_e: unknown, data: unknown): void => cb(data as { planId: string; stages: unknown[] })
     ipcRenderer.on('plan:changed', h)
     return () => ipcRenderer.removeListener('plan:changed', h)
   }
   ```
2. **`src/renderer/src/types.ts`**：在末尾 `Api` 接口里补同名方法签名（含 `PlanRecord`/
   `StageRecord` 类型导入）。
3. `src/renderer/src/env.d.ts` **无需改动**（已 `declare global { interface Window { api: Api } }`）。

### 6.2 通道表

| channel | 入参 | 返回 | 说明 |
|---|---|---|---|
| `plan:create` | `{ prompt, canvasContext }` | `{ planId, status:'drafting' }` **立即返回** | **不阻塞 UI**：router 在后台跑，结果走 `plan:changed` |
| `plan:get` | `{ planId }` | `{ plan, stages }` | 计划卡渲染用 |
| `plan:list` | `{}` | `PlanRecord[]` | 恢复画布时重建 |
| `plan:authorStage` | `{ planId, stageOrder, expectedRevision }` | `StageRecord` | 一次只 author 一个 |
| `plan:patchStage` | `{ planId, stageId, patch, expectedRevision }` | `{ok:true,revision}` \| `{ok:false,conflict:true,current}` | 乐观锁 |
| `plan:advance` | `{ planId, stageId, action:'confirm_plan'\|'confirm_result'\|'retry', expectedRevision }` | `StageRecord` | 状态机唯一入口 |
| `plan:setAutoAdvance` | `{ planId, enabled, expectedRevision }` | `PlanRecord` | §5 开关 |
| `plan:replan` | `{ planId, requestId, preserveThroughStageId, ops[] }` | `{ok:true,plan}` | 幂等 |
| `plan:cancel` | `{ planId }` | `{ok:true}` | 取消后台 router/planner |
| `plan:delete` | `{ planId }` | `{ok:true}` | 不删产物资产 |
| 事件 `plan:changed` | 主进程 → 渲染层 | `{ planId, stage?, stages?, phase }` | 画布订阅刷新计划卡 |
| 事件 `plan:direct` | 主进程 → 渲染层 | `{ planId, params }` | router 判定"直接任务"：不建计划，回落现有节点流程 |

### 6.3 `plan:create` 的异步语义（必须改）

- 立即返回 `{ planId, status:'drafting' }`，UI 先画一张"规划中"的计划卡骨架
- 后台阶段推进：`drafting` →（router）→ `routing` →（planner 首次 author）→ `waiting_user`
  每步发 `plan:changed`
- **崩溃/退出兜底**：`drafting`/`routing` 超过 60s 无进展，重开画布时按对账标记 `stale`，
  计划卡显示"规划中断，重试"，绝不静默卡死
- `plan:cancel` 与 `plan:delete` 均可在 `drafting` 阶段生效（取消后台任务 + 删记录）

### 6.4 状态机（唯一真相源，写死在 orchestrator）

```
drafting ──planner author──▶ waiting_user(plan_review) ──confirm_plan──▶ doing
doing ──executor 完成──▶ waiting_user(result_review) ──confirm_result──▶ done
done ──authorNextStage──▶（下一阶段）…  全部 done ──▶ plan.done
任意 ──retry──▶ doing（work_items.id 不变，旧产物 superseded_by 指向新产物）
任意 ──blocked──▶ 等用户输入（缺素材/缺参数）
```

硬规则：
1. **一次只 author 一个 stage**，未确认的后续只留 outline 名字，禁止 placeholder
2. **doing → done 必须经过 result_review**（自动推进开关打开时也走该状态并记审计）
3. **完成证明** = 产物节点 id + assets 行都存在
4. workflow 绑定不可变：换流程 = 建新 plan

---

## 7. 与执行层/资产层接线（复用，不重写）

| 环节 | 复用 | 改动 |
|---|---|---|
| 出图 | `generation.ts` `window.api.generate` | 抽 `executeWorkItem(item, adapter)` |
| 出视频 | `videoGeneration.ts` `pixelleProxy` + 轮询 | 同上，进度写回 `work_item.status` |
| 资产 | `db.ts` `putAssetBatch`/`putDependencyBatch` | 写 `superseded_by`（重跑留档） |
| 输入素材 | `canvasStore.upstreamOf()` + refs 留档（sha1） | stage `refs[]` 解析成上游节点/资产 |
| 设置 | `settings.activeModel` | `execution_locks.model` 优先，否则沿用 |

---

## 8. 验收钩子 `SHOT_PLAN`（复用现有截图框架）

**目标**：编排以后能自动回归，不靠手点。

- 触发：`TEST_MODE=screenshot` **且** `SHOT_PLAN=orchestration`（沿用 `npm run shot` 链路，
  自动获得 `main/index.ts` L48-50 的独立 userData，不污染真实数据）
- 实现：`src/main/acceptance/shot-plan.ts`，由 `main/index.ts` 在 TEST_MODE 分支调用
- 场景（fake adapter，不打网络）：
  1. `plan:create({ prompt: '做一张海报' })` → 断言**立即返回** `drafting`（验证 §6.3 非阻塞）
  2. 等 `plan:changed` 到 `waiting_user(plan_review)` → `plan:advance(confirm_plan)`
  3. 等结果 → 断言 stage `result_review`；再 `confirm_result` → 断言 `done`
  4. 断言：`assets` 有对应行、`superseded_by === null`、产物 `plan`/`image` 节点存在
  5. 断言：重跑同一 work item 后，旧 assets 行 `superseded_by` 指向新行
  6. 开 `auto_advance=true` 重复 2-3 步，断言无人工确认也能到 `done` 且审计字段存在
  7. 截图落盘 + 结果 JSON 写 `outputs/.acceptance/orchestration.json`
- 失败即非零退出码（保持现有截图脚本的可判定性）

---

## 9. 分期（O1~O4）

| 期 | 内容 | 验收 |
|---|---|---|
| **O1** | plan-types + db v2（含 `superseded_by` 断言）+ orchestrator 骨架 + IPC/preload/types 全套 + 单测 | 命令行可造 plan 并推进状态机；`SHOT_PLAN` 钩子跑通 fake adapter 全链路 |
| **O2** | 计划卡节点（AntD5）+ ⚡自动推进开关 + `plan:changed` 订阅 + `plan:direct` 回落 | 画布上走完 single-image 全流程；`SHOT_PLAN` 覆盖 UI 路径 |
| **O3** | 3 个 workflow JSON + router/planner 真 LLM + 提示词调优 + 异步 create 全链路 | 一句需求 → 自动选流程 → 首阶段上屏；中断可恢复（`stale` 对账） |
| **O4** | replan + 断点续跑 + retry/superseded + 对账 | 改需求只重排当前及之后；重启不丢计划 |

---

## 10. 风险与取舍

1. **别做多 agent**：MiniMax 是五 agent + MCP 网关规模，本地阶段单进程编排足够。
2. **别让 LLM 排版**：坐标由 `layout.ts` 决定，否则每次生成画布都乱。
3. **上下文成本**：计划是结构化数据，不进 prompt；planner 每次只带当前 stage 定义 + 前序摘要（≤500 字）。
4. **Pixelle 未就绪降级**：`pixelle:checkEnv` 探到 uv/后端缺失时，router 只选 `single-image`，
   计划卡明示"视频流程不可用 + 修复指引"。
5. **自动推进的风险**：只允许在 review 列表为空或已确认过同类 stage 时自动确认；
   一旦出现 `blocked`/失败即自动退回手动模式并提示（避免"自动跑飞"）。
6. **草稿文件状态**：本文件与 `canvas-interaction-tuning.md` 目前均为仓库未跟踪文件，
   等 Jeff 二审通过后随实现一起提交，避免半成品进库。
