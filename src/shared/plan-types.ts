/**
 * 编排（O1）共享类型 —— 主进程 orchestrator 与渲染层画布共用同一份定义。
 * 设计稿：docs/m4-workflow-orchestration-design.md（分期命名以 O1~O4 为准）
 *
 * 说明：放在 src/shared 是因为 tsconfig.node（src/main）与 tsconfig.web（src/renderer）
 * 各管各的 include；渲染层另有 canvas/plan-types.ts 做转出，保持设计稿路径可用。
 */

/** 阶段状态：待排 → 待用户确认 → 执行中 → 已完成；blocked 表示缺输入需用户处理 */
export type StageStatus = 'pending' | 'waiting_user' | 'doing' | 'done' | 'blocked'

/** 等待原因：计划确认（执行前闸门）／结果确认（执行后闸门） */
export type WaitingReason = 'plan_review' | 'result_review' | null

export type WorkItemModality = 'image' | 'video' | 'postprocess' | 'document'
export type WorkItemStatus = 'pending' | 'running' | 'done' | 'failed'

/** 稳定的逻辑产物槽位：重跑不换 id，只换产物 */
export interface WorkItem {
  /** 稳定逻辑产物 id */
  id: string
  /** 人类可读名（文件名种子） */
  name: string
  modality: WorkItemModality
  /** 有序引用：prompt 里按 image1/image2 顺序出现 */
  refs: string[]
  /** 可直接派发的成品提示词 */
  prompt: string
  render?: { duration_target_s?: number; size?: string; model?: string }
  status?: WorkItemStatus
  /** 完成证明：产物画布节点 id + 资产行 id */
  output_node_id?: string
  output_asset_id?: string
  /** 重跑后被替换的旧产物（保持留档） */
  superseded?: Array<{ output_node_id?: string; output_asset_id?: string; at: number }>
}

/** 面向用户的验收项（写短、可验证，不写框架状态名） */
export interface StageReview {
  before_execution: string[]
  after_execution: string[]
}

/** 阶段级执行锁：整阶段共享的画幅/分辨率/模型，防止一轮里漂移 */
export interface ExecutionLocks {
  aspect_ratio?: string
  resolution?: string
  model?: string
  production_mode?: string
}

export interface StageRecord {
  id: string
  plan_id: string
  order: number
  /** 面向用户的看板标签 */
  name: string
  goal: string
  status: StageStatus
  waiting_reason: WaitingReason
  depends_on: string[]
  execution_locks: ExecutionLocks
  review: StageReview
  work_items: WorkItem[]
  /** 乐观锁：每次成功变更 +1 */
  revision: number
  updated_at: number
}

export type PlanStatus = 'drafting' | 'running' | 'done' | 'blocked' | 'cancelled'
export type WorkflowId = 'single-image' | 'image-to-video' | 'doc-to-video' | 'custom'

export interface StageOutlineEntry {
  id: string
  order: number
  name: string
}

export interface PlanRecord {
  id: string
  title: string
  /** 用户原始需求（原句保留，不扩写） */
  prompt: string
  workflow_id: WorkflowId
  status: PlanStatus
  revision: number
  /** C4：自动推进（无需人工确认即可过闸门；遇 blocked/失败立即置回 false） */
  auto_advance?: boolean
  /** 全量骨架：未 author 的阶段只在这里留名字，禁止占位卡 */
  stage_outline: StageOutlineEntry[]
  created_at: number
  updated_at: number
}

/** 路由结果：直连 / 需要流程 / 需要先问用户 */
export type RouteKind = 'direct' | 'workflow' | 'ask'

export interface RoutingCapsule {
  route_kind: RouteKind
  workflow_id: WorkflowId | null
  /** 为什么这样路由（给用户看的一句话） */
  reason: string
  /** 缺失信息（route_kind=ask 时给用户的问题） */
  question?: string
  /** 直连时要做的动作（route_kind=direct） */
  direct_action?: 'generate_image' | 'edit_image'
}

// ── workflow 定义（内置 JSON，随包只读） ──

export interface WorkflowStageSpec {
  id: string
  name: string
  goal: string
  /** 该阶段要产出的逻辑产物槽位 */
  work_items?: Array<Pick<WorkItem, 'id' | 'name' | 'modality'> & { prompt_hint?: string }>
  review: StageReview
  /** 该阶段是否需要付费/耗时执行（这类阶段强制前置闸门） */
  paid?: boolean
  execution_locks?: ExecutionLocks
}

export interface WorkflowSpec {
  id: WorkflowId
  title: string
  match: { keywords: string[]; requires?: string[] }
  stages: WorkflowStageSpec[]
}

// ── 增量协议（B 批：对话改计划） ──

/** 增量三档：改当前阶段 / 原子更新后缀（冻结前缀）/ 换流程新建 plan */
export type ReplanTier = 'stage_patch' | 'replan' | 'new_plan'

/** replan 批次内的操作（一次批量提交，全部成功才生效） */
export type ReplanOp =
  | { kind: 'revise_stage'; stage_id: string; patch: Partial<Pick<StageRecord, 'name' | 'goal' | 'execution_locks' | 'review' | 'work_items'>> }
  | { kind: 'insert_stage'; after_stage_id?: string; spec: WorkflowStageSpec }
  | { kind: 'insert_stage_outline'; entry: StageOutlineEntry }
  | { kind: 'omit_stage'; stage_id: string }
  | { kind: 'remove_unexecuted_stage'; stage_id: string }

/** 结构化冲突（对齐 MiniMax 的 PLAN_REVISION_CONFLICT 形态） */
export interface PlanConflict {
  code: 'PLAN_REVISION_CONFLICT'
  message: string
  current_state: { expected_revision: number; actual_revision: number }
  allowed_actions: string[]
}

/** 审计事件（append-only；source_message_id 回溯源话） */
export interface PlanEvent {  id?: number
  plan_id: string
  /** 事件类型：create / author_stage / advance / patch_stage / replan / cancel */
  event: string
  actor: 'chat' | 'ui' | 'auto'
  stage_id: string | null
  before_revision: number
  after_revision: number
  request_id: string | null
  source_message_id: string | null
  detail?: string
  created_at: number
}

// ── 对话（C 批） ──

export type ChatRole = 'user' | 'agent' | 'tool' | 'system'

export interface ChatMessage {
  id: string
  /** 所属计划（首条消息建计划前为 null） */
  plan_id: string | null
  role: ChatRole
  content: string
  /** 镜像消息溯源：卡片动作生成的等价消息带源消息 id，用于去重 */
  source_message_id: string | null
  /** 幂等键（与 plan:replan 的 request_id 对齐） */
  request_id?: string | null
  created_at: number
}
