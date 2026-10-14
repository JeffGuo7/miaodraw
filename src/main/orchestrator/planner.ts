/**
 * 计划器（O1 骨架）—— 纯函数：把"选中的 workflow + 用户原句"实例化成 plan/stage。
 *
 * 本期（O1）不接 LLM：work_items 的 prompt 先用 workflow 定义里的 prompt_hint 占位说明，
 * O3 再换成一次 LLM 编译（把 stage 定义 + 用户原句 + 前序产物摘要 → 成品 prompt）。
 * 硬规则：一次只 author 一个阶段；未 author 的阶段只留在 stage_outline（禁止占位卡）。
 */
import type { PlanRecord, StageRecord, WorkflowSpec, WorkflowStageSpec, WorkItem } from '../../shared/plan-types'

import { applyAction, nextStageToAuthor } from './state.ts'

let seq = 0
function newId(prefix: string): string {
  seq += 1
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`
}

/** 建计划（drafting）：只写骨架，不物化任何阶段 */
export function buildPlan(prompt: string, workflow: WorkflowSpec, now: number = Date.now()): PlanRecord {
  return {
    id: newId('p'),
    title: workflow.title,
    prompt,
    workflow_id: workflow.id,
    status: 'drafting',
    revision: 1,
    stage_outline: workflow.stages.map((s, i) => ({ id: s.id, order: i + 1, name: s.name })),
    created_at: now,
    updated_at: now
  }
}

function itemsFromSpec(spec: WorkflowStageSpec, stageId: string): WorkItem[] {
  const defs = spec.work_items ?? []
  return defs.map((d) => ({
    id: `${stageId}_${d.id}`,
    name: d.name,
    modality: d.modality,
    refs: [],
    prompt: d.prompt_hint ?? '',
    status: 'pending' as const
  }))
}

/**
 * author 一个阶段（只有当前待 author 的阶段能被物化）→ 直接进入 waiting_user(plan_review)。
 * 违反滚动细化（跳号 author）时抛错。
 */
export function authorStage(
  plan: PlanRecord,
  workflow: WorkflowSpec,
  stages: StageRecord[],
  order: number,
  now: number = Date.now()
): StageRecord {
  const expectedOrder = nextStageToAuthor(plan, stages)
  if (expectedOrder === null) throw new Error('所有阶段都已 author')
  if (order !== expectedOrder) throw new Error(`一次只能 author 当前阶段（应为 ${expectedOrder}，收到 ${order}）`)

  const spec = workflow.stages.find((_, i) => i + 1 === order)
  if (!spec) throw new Error(`workflow ${workflow.id} 没有第 ${order} 阶段`)

  const stage: StageRecord = {
    id: `${plan.id}_s${order}`,
    plan_id: plan.id,
    order,
    name: spec.name,
    goal: spec.goal,
    status: 'pending',
    waiting_reason: null,
    depends_on: order > 1 ? [`${plan.id}_s${order - 1}`] : [],
    execution_locks: spec.execution_locks ?? {},
    review: spec.review,
    work_items: itemsFromSpec(spec, `${plan.id}_s${order}`),
    revision: 1,
    updated_at: now
  }
  // 内容就绪 → 立刻进入计划确认闸门（付费阶段默认就是前置闸门）
  const r = applyAction(stage, 'author_stage', stage.revision, now)
  if (!r.ok) throw new Error('author_stage 迁移失败')
  return r.stage
}

/**
 * 乐观锁式内容编辑（改 prompt/尺寸等）：revision 不匹配返回 conflict。
 */
export function patchStage(stage: StageRecord, patch: Partial<Pick<StageRecord, 'name' | 'goal' | 'execution_locks' | 'review' | 'work_items'>>, expectedRevision: number, now: number = Date.now()):
  | { ok: true; stage: StageRecord }
  | { ok: false; conflict: true; current: StageRecord } {
  if (expectedRevision !== stage.revision) return { ok: false, conflict: true, current: stage }
  return { ok: true, stage: { ...stage, ...patch, revision: stage.revision + 1, updated_at: now } }
}
