/**
 * 阶段状态机（O1）—— 编排的唯一真相源，纯函数、零依赖、可单测。
 *
 * 状态流转（设计稿 §5）：
 *   pending ──author_stage──▶ waiting_user(plan_review)
 *   waiting_user(plan_review) ──confirm_plan──▶ doing
 *   doing ──execution_done──▶ waiting_user(result_review)
 *   waiting_user(result_review) ──confirm_result──▶ done
 *   任意（非 pending）──retry──▶ doing（work_items.id 不变，旧产物进 superseded）
 *   任意（非 done）──block──▶ blocked(缺输入)；blocked ──unblock──▶ doing
 *
 * 硬规则：禁止跳过 review（doing 不能直达 done）；每次成功变更 revision+1（乐观锁）。
 *
 * 本文件刻意不引入任何运行时依赖（只有 import type），以便 `node --test` 直接跑：
 * 见同目录 state.test.mjs。
 */
import type { PlanRecord, PlanStatus, StageRecord, StageStatus, WaitingReason, WorkItem } from '../../shared/plan-types'

export type StageAction =
  | 'author_stage'
  | 'confirm_plan'
  | 'execution_done'
  | 'confirm_result'
  | 'retry'
  | 'block'
  | 'unblock'

export type TransitionResult =
  | { ok: true; stage: StageRecord }
  | { ok: false; conflict: true; current: StageRecord }
  | { ok: false; conflict?: false; error: string }

/** 每个状态下允许的动作 */
const ALLOWED: Record<StageStatus, StageAction[]> = {
  pending: ['author_stage', 'block'],
  waiting_user: ['confirm_plan', 'confirm_result', 'retry', 'block'],
  doing: ['execution_done', 'retry', 'block'],
  done: ['retry'],
  blocked: ['unblock', 'retry']
}

export function allowedActions(status: StageStatus): StageAction[] {
  return [...ALLOWED[status]]
}

export function isActionAllowed(status: StageStatus, action: StageAction): boolean {
  return ALLOWED[status].includes(action)
}

/** 动作 → 目标状态；waiting_user 需要看 waiting_reason 区分两个闸门 */
function nextState(stage: StageRecord, action: StageAction): { status: StageStatus; waiting_reason: WaitingReason } | { error: string } {
  switch (action) {
    case 'author_stage':
      return { status: 'waiting_user', waiting_reason: 'plan_review' }
    case 'confirm_plan':
      if (stage.waiting_reason !== 'plan_review') return { error: '当前不是计划确认闸门（waiting_reason=' + String(stage.waiting_reason) + '）' }
      return { status: 'doing', waiting_reason: null }
    case 'execution_done':
      return { status: 'waiting_user', waiting_reason: 'result_review' }
    case 'confirm_result':
      if (stage.waiting_reason !== 'result_review') return { error: '当前不是结果确认闸门（waiting_reason=' + String(stage.waiting_reason) + '）' }
      return { status: 'done', waiting_reason: null }
    case 'retry':
      // 重跑：回到 doing，产物槽位 id 不变（旧产物由 setWorkItemOutput 归档）
      return { status: 'doing', waiting_reason: null }
    case 'block':
      return { status: 'blocked', waiting_reason: null }
    case 'unblock':
      return { status: 'doing', waiting_reason: null }
    default:
      return { error: '未知动作：' + String(action) }
  }
}

/**
 * 唯一状态迁移入口：带乐观锁。
 * @param expectedRevision 调用方最后看到的 revision，不匹配即 conflict（返回当前值供前端刷新）
 */
export function applyAction(stage: StageRecord, action: StageAction, expectedRevision: number, now: number = Date.now()): TransitionResult {
  if (expectedRevision !== stage.revision) {
    return { ok: false, conflict: true, current: stage }
  }
  if (!isActionAllowed(stage.status, action)) {
    return { ok: false, error: `状态 ${stage.status} 不允许动作 ${action}（允许：${ALLOWED[stage.status].join('/')}）` }
  }
  const next = nextState(stage, action)
  if ('error' in next) return { ok: false, error: next.error }
  return {
    ok: true,
    stage: { ...stage, status: next.status, waiting_reason: next.waiting_reason, revision: stage.revision + 1, updated_at: now }
  }
}

/**
 * 完成证明：写入产物（节点 id + 资产行 id）。
 * 重跑时旧产物进 superseded 留档，work_items[].id 保持不变。
 */
export function setWorkItemOutput(
  stage: StageRecord,
  itemId: string,
  output: { nodeId?: string; assetId?: string },
  now: number = Date.now()
): TransitionResult {
  const idx = stage.work_items.findIndex((w) => w.id === itemId)
  if (idx < 0) return { ok: false, error: `work_item 不存在：${itemId}` }
  const items = stage.work_items.slice()
  const cur = items[idx]
  const hadOutput = Boolean(cur.output_node_id || cur.output_asset_id)
  items[idx] = {
    ...cur,
    status: 'done',
    output_node_id: output.nodeId ?? cur.output_node_id,
    output_asset_id: output.assetId ?? cur.output_asset_id,
    superseded: hadOutput
      ? [...(cur.superseded ?? []), { output_node_id: cur.output_node_id, output_asset_id: cur.output_asset_id, at: now }]
      : cur.superseded
  }
  return { ok: true, stage: { ...stage, work_items: items, revision: stage.revision + 1, updated_at: now } }
}

/** 执行失败/重跑中的产物状态回写（不改 revision 语义：仍算一次变更） */
export function setWorkItemStatus(stage: StageRecord, itemId: string, status: WorkItem['status'], now: number = Date.now()): TransitionResult {
  const idx = stage.work_items.findIndex((w) => w.id === itemId)
  if (idx < 0) return { ok: false, error: `work_item 不存在：${itemId}` }
  const items = stage.work_items.slice()
  items[idx] = { ...items[idx], status }
  return { ok: true, stage: { ...stage, work_items: items, revision: stage.revision + 1, updated_at: now } }
}

/** 计划级状态推导：blocked > done > running > drafting */
export function derivePlanStatus(stages: StageRecord[], outlineCount: number): PlanStatus {
  if (stages.some((s) => s.status === 'blocked')) return 'blocked'
  if (outlineCount > 0 && stages.length >= outlineCount && stages.every((s) => s.status === 'done')) return 'done'
  if (stages.some((s) => s.status === 'doing' || s.status === 'waiting_user' || s.status === 'done')) return 'running'
  return 'drafting'
}

/** 只 author 当前阶段：下一个待 actor 的阶段（不许预铺后面的阶段） */
export function nextStageToAuthor(plan: PlanRecord, stages: StageRecord[]): number | null {
  const authored = new Set(stages.map((s) => s.order))
  for (const o of [...plan.stage_outline].sort((a, b) => a.order - b.order)) {
    if (!authored.has(o.order)) return o.order
  }
  return null
}

/** 不变式：未 author 的阶段只存在于 outline（禁止 placeholder 卡） */
export function assertNoPlaceholders(plan: PlanRecord, stages: StageRecord[]): void {
  for (const s of stages) {
    const inOutline = plan.stage_outline.some((o) => o.order === s.order)
    if (!inOutline) throw new Error(`阶段 ${s.order} 不在 stage_outline 中（workflow 绑定不可变）`)
    if (s.status === 'pending' && s.work_items.length === 0) {
      throw new Error(`阶段 ${s.order} 处于 pending 但已被物化（禁止占位卡）`)
    }
  }
}
