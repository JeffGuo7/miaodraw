/**
 * 编排注册表（O1）—— 纯逻辑，不依赖 electron，可单测。
 * 语义：plan 是真相源（渲染层落 IndexedDB，本注册表是主进程工作集）；
 *       一次只 author 一个阶段；状态迁移唯一入口是 state.applyAction（带乐观锁）。
 */
import type { PlanRecord, RoutingCapsule, StageRecord } from '../../shared/plan-types'

import { authorStage as authorStageContent, buildPlan, patchStage as patchStageContent } from './planner.ts'
import { classify, getWorkflow, type RouteContext } from './router.ts'
import { applyAction, derivePlanStatus, nextStageToAuthor, type StageAction } from './state.ts'

export interface PlanSnapshot {
  plan: PlanRecord
  stages: StageRecord[]
}

export type CreateResult =
  | { kind: 'direct'; capsule: RoutingCapsule }
  | { kind: 'ask'; capsule: RoutingCapsule }
  | { kind: 'plan'; snapshot: PlanSnapshot; capsule: RoutingCapsule }

export type ActionResult<T> = { ok: true; value: T } | { ok: false; conflict?: true; error?: string; current?: StageRecord }

export class PlanRegistry {
  private plans = new Map<string, PlanRecord>()
  private stages = new Map<string, StageRecord[]>()

  /** 变更回调：由 IPC 层接成 plan:changed 事件 */
  private onChange?: (snapshot: PlanSnapshot) => void

  constructor(onChange?: (snapshot: PlanSnapshot) => void) {
    this.onChange = onChange
  }

  /** 建计划：**只写骨架并立即返回 drafting**，首阶段由 authorFirstStage 异步推进（设计稿 §5） */
  create(prompt: string, ctx: RouteContext = {}, now: number = Date.now()): CreateResult {
    const capsule = classify(prompt, ctx)
    if (capsule.route_kind === 'direct') return { kind: 'direct', capsule }
    if (capsule.route_kind === 'ask') return { kind: 'ask', capsule }

    const workflow = getWorkflow(capsule.workflow_id ?? '')
    if (!workflow) return { kind: 'ask', capsule: { ...capsule, route_kind: 'ask', reason: '未找到匹配的流程定义' } }

    const plan = buildPlan(prompt, workflow, now)
    this.plans.set(plan.id, plan)
    this.stages.set(plan.id, [])
    return { kind: 'plan', snapshot: this.get(plan.id) as PlanSnapshot, capsule }
  }

  get(planId: string): PlanSnapshot | null {
    const plan = this.plans.get(planId)
    if (!plan) return null
    return { plan, stages: this.stages.get(planId) ?? [] }
  }

  list(): PlanRecord[] {
    return [...this.plans.values()].sort((a, b) => b.updated_at - a.updated_at)
  }

  /** 物化当前阶段（一次一个）→ 进入 waiting_user(plan_review)；成功后广播 */
  authorFirstStage(planId: string, now: number = Date.now()): ActionResult<PlanSnapshot> {
    const snap = this.get(planId)
    if (!snap) return { ok: false, error: `计划不存在：${planId}` }
    const workflow = getWorkflow(snap.plan.workflow_id)
    if (!workflow) return { ok: false, error: `流程定义缺失：${snap.plan.workflow_id}` }

    const order = nextStageToAuthor(snap.plan, snap.stages)
    if (order === null) return { ok: true, value: snap }

    try {
      const stage = authorStageContent(snap.plan, workflow, snap.stages, order, now)
      const stages = [...snap.stages, stage]
      const plan = this.touch(planId, stages, now)
      const out = { plan, stages }
      this.onChange?.(out)
      return { ok: true, value: out }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  patchStage(planId: string, stageId: string, patch: Parameters<typeof patchStageContent>[1], expectedRevision: number, now: number = Date.now()): ActionResult<StageRecord> {
    const snap = this.get(planId)
    if (!snap) return { ok: false, error: `计划不存在：${planId}` }
    const idx = snap.stages.findIndex((s) => s.id === stageId)
    if (idx < 0) return { ok: false, error: `阶段不存在：${stageId}` }
    const r = patchStageContent(snap.stages[idx], patch, expectedRevision, now)
    if (!r.ok) return { ok: false, conflict: true, current: r.current }
    const stages = snap.stages.slice()
    stages[idx] = r.stage
    this.touch(planId, stages, now)
    return { ok: true, value: r.stage }
  }

  /** 状态机唯一入口 */
  advance(planId: string, stageId: string, action: StageAction, expectedRevision: number, now: number = Date.now()): ActionResult<StageRecord> {
    const snap = this.get(planId)
    if (!snap) return { ok: false, error: `计划不存在：${planId}` }
    const idx = snap.stages.findIndex((s) => s.id === stageId)
    if (idx < 0) return { ok: false, error: `阶段不存在：${stageId}` }
    const r = applyAction(snap.stages[idx], action, expectedRevision, now)
    if (!r.ok) {
      if ('conflict' in r && r.conflict) return { ok: false, conflict: true, current: r.current }
      return { ok: false, error: 'error' in r ? r.error : '状态迁移失败' }
    }
    const stages = snap.stages.slice()
    stages[idx] = r.stage
    this.touch(planId, stages, now)
    return { ok: true, value: r.stage }
  }

  remove(planId: string): boolean {
    const had = this.plans.delete(planId)
    this.stages.delete(planId)
    return had
  }

  /** 写回计划并重算 plan 状态（blocked > done > running > drafting） */
  private touch(planId: string, stages: StageRecord[], now: number): PlanRecord {
    const plan = this.plans.get(planId) as PlanRecord
    const next: PlanRecord = {
      ...plan,
      status: derivePlanStatus(stages, plan.stage_outline.length),
      revision: plan.revision + 1,
      updated_at: now
    }
    this.plans.set(planId, next)
    this.stages.set(planId, stages)
    return next
  }
}
