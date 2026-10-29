/**
 * 编排注册表（O1 + B 批增量协议）—— 纯逻辑，不依赖 electron，可单测。
 *
 * 语义：
 * - plan 是真相源（渲染层落 IndexedDB，本注册表是主进程工作集）
 * - 一次只 author 一个阶段；状态迁移唯一入口 state.applyAction（带乐观锁）
 * - 增量三档（B 批）：stage_patch（改当前阶段）／replan（原子更新后缀 + 冻结已确认前缀）／
 *   换 workflow 才新建 plan（这里通过 create 表达）
 * - replan 幂等：同 planId + request_id + 同 payload 重放 → 直接回放已保存结果
 * - CAS 冲突：返回结构化 PLAN_REVISION_CONFLICT（current_state + allowed_actions）
 * - 原子性：一批 ops 全部校验通过才提交，任一失败不留半成品
 */
import type { PlanConflict, PlanEvent, PlanRecord, ReplanOp, RouteKind, RoutingCapsule, StageOutlineEntry, StageRecord, WorkflowStageSpec } from '../../shared/plan-types'

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

export type ActionResult<T> = { ok: true; value: T } | { ok: false; conflict?: false; error?: string } | { ok: false; conflict: true; current: StageRecord }

export interface ReplanRequest {
  planId: string
  /** 幂等键：同 id + 同 payload 重放返回既有结果 */
  requestId: string
  /** 冻结到哪个阶段（含）：该阶段及之前不可被本批改动 */
  preserveThroughStageId?: string
  ops: ReplanOp[]
  expectedRevision?: number
  actor?: 'chat' | 'ui' | 'auto'
  sourceMessageId?: string
}

export type ReplanResult =
  | { ok: true; tier: 'replan'; snapshot: PlanSnapshot; replayed?: boolean; revision: number; frozen_through: string | null }
  | { ok: false; tier: 'replan'; conflict: PlanConflict }
  | { ok: false; tier: 'replan'; error: string }

/** 幂等结果缓存（进程内；渲染层另有 plan_events 持久审计） */
interface CachedReplan {
  payloadHash: string
  result: ReplanResult
}

export class PlanRegistry {
  private plans = new Map<string, PlanRecord>()
  private stages = new Map<string, StageRecord[]>()
  private replays = new Map<string, CachedReplan>()
  private events: PlanEvent[] = []
  private driving = false
  private onChange?: (snapshot: PlanSnapshot) => void
  private onEvent?: (event: PlanEvent) => void

  constructor(onChange?: (snapshot: PlanSnapshot) => void, onEvent?: (event: PlanEvent) => void) {
    this.onChange = onChange
    this.onEvent = onEvent
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
    this.record({ plan_id: plan.id, event: 'create', actor: 'auto', stage_id: null, before_revision: 0, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
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

  /**
   * 重启恢复：把渲染层从 IndexedDB 读回的计划快照重新装进主进程工作集。
   * 规则：内存里已有的计划一律跳过（内存状态永远更新）；只接受自洽快照
   * （阶段 order 唯一且都在 stage_outline 内，禁止占位卡），不改 revision、不推进状态。
   */
  restore(snapshots: PlanSnapshot[], now: number = Date.now()): { restored: number; skipped: number } {
    let restored = 0
    let skipped = 0
    for (const input of snapshots ?? []) {
      const plan = input?.plan
      const stages = input?.stages
      if (!plan?.id || !Array.isArray(stages)) {
        skipped++
        continue
      }
      if (this.plans.has(plan.id)) {
        skipped++
        continue
      }
      const orders = new Set(stages.map((s) => s.order))
      const outlineOrders = new Set(plan.stage_outline.map((o) => o.order))
      const selfConsistent = orders.size === stages.length && stages.every((s) => outlineOrders.has(s.order))
      if (!selfConsistent) {
        skipped++
        continue
      }
      const copy = stages.map((s) => ({ ...s }))
      this.plans.set(plan.id, plan)
      this.stages.set(plan.id, copy)
      this.record({ plan_id: plan.id, event: 'restore', actor: 'auto', stage_id: null, before_revision: plan.revision, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
      this.emit({ plan, stages: copy })
      restored++
    }
    return { restored, skipped }
  }

  listEvents(planId?: string): PlanEvent[] {
    return planId ? this.events.filter((e) => e.plan_id === planId) : [...this.events]
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
      const before = snap.plan.revision
      const plan = this.touch(planId, stages, now)
      this.record({ plan_id: planId, event: 'author_stage', actor: 'auto', stage_id: stage.id, before_revision: before, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
      this.emit({ plan, stages })
      return { ok: true, value: { plan, stages } }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  patchStage(planId: string, stageId: string, patch: Parameters<typeof patchStageContent>[1], expectedRevision: number, now: number = Date.now()): ActionResult<StageRecord> {
    const snap = this.get(planId)
    if (!snap) return { ok: false, error: `计划不存在：${planId}` }
    const idx = snap.stages.findIndex((s) => s.id === stageId)
    if (idx < 0) return { ok: false, error: `阶段不存在：${stageId}` }
    // C5 冻结前缀：已完成的阶段不可再 patch（要改只能 replan 从其后重排）
    if (snap.stages[idx].status === 'done') {
      return { ok: false, error: `阶段「${snap.stages[idx].name}」已冻结（已完成），只能通过 replan 从其后重排` }
    }
    const r = patchStageContent(snap.stages[idx], patch, expectedRevision, now)
    if (!r.ok) return { ok: false, conflict: true, current: r.current }
    const stages = snap.stages.slice()
    stages[idx] = r.stage
    const before = snap.plan.revision
    const plan = this.touch(planId, stages, now)
    this.record({ plan_id: planId, event: 'patch_stage', actor: 'ui', stage_id: stageId, before_revision: before, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
    return { ok: true, value: r.stage }
  }

  /** 状态机唯一入口 */
  advance(planId: string, stageId: string, action: StageAction, expectedRevision: number, now: number = Date.now(), actor: 'chat' | 'ui' | 'auto' = 'ui'): ActionResult<StageRecord> {
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
    const before = snap.plan.revision
    const plan = this.touch(planId, stages, now)
    this.record({ plan_id: planId, event: `advance:${action}`, actor, stage_id: stageId, before_revision: before, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
    this.emit({ plan, stages })
    // 阶段接力：某阶段确认完成（done）后，必须 author 出下一个阶段，
    // 否则多阶段流程（如 doc-to-video 四阶段）会永远停在第 1 阶段——大纲里剩下的阶段永远不会物化。
    // 注意：authorFirstStage 在「全部已 author」时安全返回，不会重复物化。
    if (r.stage.status === 'done') this.authorFirstStage(planId, now)
    // C4：计划开了自动推进时，执行器交付后自动接力过闸门
    if (plan.auto_advance) this.driveAuto(planId, now)
    return { ok: true, value: r.stage }
  }

  /**
   * 外部执行器（视频管线）写审计事件（V1）：记账/降级/重试都要留痕，可追溯到 plan。
   */
  recordAudit(input: {
    plan_id: string
    event: string
    actor?: 'chat' | 'ui' | 'auto'
    stage_id?: string | null
    request_id?: string | null
    source_message_id?: string | null
    detail?: string
  }): PlanEvent {
    const snap = this.get(input.plan_id)
    const revision = snap?.plan.revision ?? 0
    this.record({
      plan_id: input.plan_id,
      event: input.event,
      actor: input.actor ?? 'auto',
      stage_id: input.stage_id ?? null,
      before_revision: revision,
      after_revision: revision,
      request_id: input.request_id ?? null,
      source_message_id: input.source_message_id ?? null,
      detail: input.detail,
      created_at: Date.now()
    })
    return this.events[this.events.length - 1]
  }

  /**
   * 探针专用（仅 TEST_MODE=screenshot 时经 IPC 暴露）：模拟「规划中断」。
   * 把计划退回 drafting + 未物化任何阶段，并把 updated_at 往回拨 ageMs，
   * 使渲染层能真实走到 C6 的 stale 分支（重试按钮 → authorFirstStage 重新推进）。
   */
  debugInterrupt(planId: string, ageMs = 120_000, now: number = Date.now()): ActionResult<PlanSnapshot> {
    const snap = this.get(planId)
    if (!snap) return { ok: false, error: `计划不存在：${planId}` }
    const plan: PlanRecord = {
      ...snap.plan,
      status: 'drafting',
      revision: snap.plan.revision + 1,
      updated_at: now - Math.max(0, ageMs)
    }
    const stages: StageRecord[] = []
    this.plans.set(planId, plan)
    this.stages.set(planId, stages)
    this.record({ plan_id: planId, event: 'debug_interrupt', actor: 'auto', stage_id: null, before_revision: snap.plan.revision, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
    this.emit({ plan, stages })
    return { ok: true, value: { plan, stages } }
  }

  /**
   * 增量更新（B 批核心）：原子更新后缀，冻结已确认前缀。
   * - 幂等：同 requestId + 同 payload → 回放既有结果
   * - CAS：expectedRevision 与 plan.revision 不符 → 结构化冲突
   * - 原子：全部 ops 校验通过后才提交
   */
  replan(req: ReplanRequest, now: number = Date.now()): ReplanResult {
    const snap = this.get(req.planId)
    if (!snap) return { ok: false, tier: 'replan', error: `计划不存在：${req.planId}` }

    const payloadHash = hashPayload(req)
    const cacheKey = `${req.planId}:${req.requestId}`
    const cached = this.replays.get(cacheKey)
    if (cached && cached.payloadHash === payloadHash) {
      return { ...cached.result, replayed: true } as ReplanResult
    }

    if (req.expectedRevision !== undefined && req.expectedRevision !== snap.plan.revision) {
      return {
        ok: false,
        tier: 'replan',
        conflict: {
          code: 'PLAN_REVISION_CONFLICT',
          message: `计划修订冲突：期望 ${req.expectedRevision}，实际 ${snap.plan.revision}。请重新读取计划后重试。`,
          current_state: { expected_revision: req.expectedRevision, actual_revision: snap.plan.revision },
          allowed_actions: ['reread_plan']
        }
      }
    }

    // ── 在局部副本上执行，全部成功才提交（原子性） ──
    const stages = snap.stages.map((s) => ({ ...s }))
    let outline: StageOutlineEntry[] = snap.plan.stage_outline.map((o) => ({ ...o }))
    const frozenThroughOrder = this.orderOf(stages, outline, req.preserveThroughStageId)
    const frozenIds = new Set(stages.filter((s) => s.order <= frozenThroughOrder).map((s) => s.id))

    try {
      for (const op of req.ops ?? []) {
        switch (op.kind) {
          case 'revise_stage': {
            const idx = stages.findIndex((s) => s.id === op.stage_id)
            if (idx < 0) throw new Error(`阶段不存在：${op.stage_id}`)
            if (frozenIds.has(op.stage_id)) throw new Error(`阶段 ${op.stage_id} 在冻结前缀内，不能被增量改动`)
            stages[idx] = { ...stages[idx], ...op.patch, revision: stages[idx].revision + 1, updated_at: now }
            break
          }
          case 'insert_stage_outline': {
            if (outline.some((o) => o.order === op.entry.order)) throw new Error(`outline 已存在 order=${op.entry.order}`)
            outline = [...outline, op.entry].sort((a, b) => a.order - b.order)
            break
          }
          case 'omit_stage': {
            const idx = stages.findIndex((s) => s.id === op.stage_id)
            if (idx >= 0) {
              if (frozenIds.has(op.stage_id)) throw new Error(`阶段 ${op.stage_id} 在冻结前缀内，不能被 omit`)
              if (stages[idx].status !== 'pending' && stages[idx].status !== 'blocked') throw new Error(`只有未执行的阶段可 omit（${op.stage_id} 当前 ${stages[idx].status}）`)
              stages.splice(idx, 1)
            }
            outline = outline.filter((o) => o.id !== op.stage_id && !op.stage_id.startsWith(`${o.id}_`))
            break
          }
          case 'remove_unexecuted_stage': {
            const idx = stages.findIndex((s) => s.id === op.stage_id)
            if (idx < 0) throw new Error(`阶段不存在：${op.stage_id}`)
            if (frozenIds.has(op.stage_id)) throw new Error(`阶段 ${op.stage_id} 在冻结前缀内，不能删除`)
            if (stages[idx].status === 'doing' || stages[idx].status === 'done') throw new Error(`已开始/已完成的阶段不可删除（${op.stage_id} 当前 ${stages[idx].status}）`)
            stages.splice(idx, 1)
            break
          }
          case 'insert_stage': {
            const spec: WorkflowStageSpec = op.spec
            const order = this.nextFreeOrder(stages, outline)
            const stage: StageRecord = {
              id: `${req.planId}_s${order}`,
              plan_id: req.planId,
              order,
              name: spec.name,
              goal: spec.goal,
              status: 'pending',
              waiting_reason: null,
              depends_on: [],
              execution_locks: spec.execution_locks ?? {},
              review: spec.review,
              work_items: (spec.work_items ?? []).map((d) => ({ id: `${req.planId}_s${order}_${d.id}`, name: d.name, modality: d.modality, refs: [], prompt: d.prompt_hint ?? '', status: 'pending' as const })),
              revision: 1,
              updated_at: now
            }
            const authored = applyAction(stage, 'author_stage', stage.revision, now)
            if (!authored.ok) throw new Error('insert_stage 迁移失败')
            stages.push(authored.stage)
            outline = [...outline, { id: `${req.planId}_s${order}`, order, name: spec.name }].sort((a, b) => a.order - b.order)
            break
          }
          default:
            throw new Error(`未知 op：${String((op as { kind?: string }).kind)}`)
        }
      }
    } catch (e) {
      // 原子性：不改动任何状态
      return { ok: false, tier: 'replan', error: e instanceof Error ? e.message : String(e) }
    }

    const beforeRev = snap.plan.revision
    const nextPlan: PlanRecord = {
      ...snap.plan,
      stage_outline: outline,
      status: derivePlanStatus(stages, outline.length),
      revision: beforeRev + 1,
      updated_at: now
    }
    this.plans.set(req.planId, nextPlan)
    this.stages.set(req.planId, stages)

    const frozenThrough = req.preserveThroughStageId ?? (frozenThroughOrder > 0 ? stages.find((s) => s.order === frozenThroughOrder)?.id ?? null : null)
    const result: ReplanResult = { ok: true, tier: 'replan', snapshot: { plan: nextPlan, stages }, revision: nextPlan.revision, frozen_through: frozenThrough }
    this.replays.set(cacheKey, { payloadHash, result })
    this.record({
      plan_id: req.planId,
      event: 'replan',
      actor: req.actor ?? 'chat',
      stage_id: null,
      before_revision: beforeRev,
      after_revision: nextPlan.revision,
      request_id: req.requestId,
      source_message_id: req.sourceMessageId ?? null,
      detail: `${req.ops?.length ?? 0} ops，冻结至 ${frozenThrough ?? '（无）'}`,
      created_at: now
    })
    this.emit({ plan: nextPlan, stages })
    return result
  }

  /**
   * C4 自动推进开关：CAS 写 plan.auto_advance；开启后立即驱动机器过闸门（actor=auto）。
   * 规则（任务卡）：review 为空或已有同类阶段确认过才允许自动；任何 blocked 立即置回 false。
   */
  setAutoAdvance(planId: string, enabled: boolean, expectedRevision?: number, now: number = Date.now()): { ok: boolean; error?: string; plan?: PlanRecord; conflict?: boolean } {
    const snap = this.get(planId)
    if (!snap) return { ok: false, error: `计划不存在：${planId}` }
    if (expectedRevision !== undefined && expectedRevision !== snap.plan.revision) {
      return { ok: false, conflict: true, error: `计划修订冲突：期望 ${expectedRevision}，实际 ${snap.plan.revision}` }
    }
    const before = snap.plan.revision
    const plan: PlanRecord = { ...snap.plan, auto_advance: enabled, revision: before + 1, updated_at: now }
    this.plans.set(planId, plan)
    this.record({ plan_id: planId, event: enabled ? 'auto_advance_on' : 'auto_advance_off', actor: 'ui', stage_id: null, before_revision: before, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
    this.emit({ plan, stages: snap.stages })
    if (enabled) this.driveAuto(planId, now)
    return { ok: true, plan: this.plans.get(planId) }
  }

  /** 自动推进驱动：最多 8 步防跑飞；blocked → 关闭自动并广播；重入保护避免递归叠加 */
  private driveAuto(planId: string, now: number): void {
    if (this.driving) return
    this.driving = true
    try {
      for (let step = 0; step < 8; step++) {
      const snap = this.get(planId)
      if (!snap?.plan.auto_advance) return
      const stages = snap.stages
      if (stages.some((s) => s.status === 'blocked')) {
        const before = snap.plan.revision
        const plan: PlanRecord = { ...snap.plan, auto_advance: false, revision: before + 1, updated_at: now }
        this.plans.set(planId, plan)
        this.record({ plan_id: planId, event: 'auto_advance_off_blocked', actor: 'auto', stage_id: stages.find((s) => s.status === 'blocked')?.id ?? null, before_revision: before, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
        this.emit({ plan, stages })
        return
      }
      const gate = stages.find((s) => s.status === 'waiting_user')
      if (!gate) return // 没有闸门可过（等执行器跑 / 等 author）
      // 用户显式开启自动推进即视为授权过闸门；唯一硬刹车是 blocked（下面提前返回并关自动）
      const action: StageAction = gate.waiting_reason === 'plan_review' ? 'confirm_plan' : 'confirm_result'
      const r = this.advance(planId, gate.id, action, gate.revision, now, 'auto')
      if (!r.ok) return
      }
    } finally {
      this.driving = false
    }
  }

  /** 取消计划（终态）：不动已完成阶段，未完成的保持原状态供用户重开 */
  cancel(planId: string, now: number = Date.now()): { ok: boolean; error?: string } {    const snap = this.get(planId)
    if (!snap) return { ok: false, error: `计划不存在：${planId}` }
    const before = snap.plan.revision
    const plan: PlanRecord = { ...snap.plan, status: 'cancelled', revision: before + 1, updated_at: now }
    this.plans.set(planId, plan)
    this.record({ plan_id: planId, event: 'cancel', actor: 'ui', stage_id: null, before_revision: before, after_revision: plan.revision, request_id: null, source_message_id: null, created_at: now })
    this.emit({ plan, stages: snap.stages })
    return { ok: true }
  }

  remove(planId: string): boolean {
    const had = this.plans.delete(planId)
    this.stages.delete(planId)
    for (const key of this.replays.keys()) if (key.startsWith(`${planId}:`)) this.replays.delete(key)
    return had
  }

  // ── 内部 ──

  private emit(snapshot: PlanSnapshot): void {
    this.onChange?.(snapshot)
  }

  private record(event: PlanEvent): void {
    const withId: PlanEvent = { ...event, id: this.events.length + 1 }
    this.events.push(withId)
    this.onEvent?.(withId)
  }

  private orderOf(stages: StageRecord[], outline: StageOutlineEntry[], stageId?: string): number {
    if (!stageId) return 0
    const fromStage = stages.find((s) => s.id === stageId)?.order
    const fromOutline = outline.find((o) => o.id === stageId)?.order
    return fromStage ?? fromOutline ?? 0
  }

  private nextFreeOrder(stages: StageRecord[], outline: StageOutlineEntry[]): number {
    const used = new Set([...stages.map((s) => s.order), ...outline.map((o) => o.order)])
    let n = 1
    while (used.has(n)) n++
    return n
  }

  /** 写回计划并重算 plan 状态（blocked > done > running > drafting） */
  private touch(planId: string, stages: StageRecord[], now: number): PlanRecord {
    const plan = this.plans.get(planId) as PlanRecord
    const next: PlanRecord = {
      ...plan,
      status: plan.status === 'cancelled' ? 'cancelled' : derivePlanStatus(stages, plan.stage_outline.length),
      revision: plan.revision + 1,
      updated_at: now
    }
    this.plans.set(planId, next)
    this.stages.set(planId, stages)
    return next
  }
}

/** 幂等 payload 指纹（只关心影响结果的字段） */
function hashPayload(req: ReplanRequest): string {
  return JSON.stringify({ p: req.planId, f: req.preserveThroughStageId ?? null, ops: req.ops ?? [] })
}

export { derivePlanStatus }
export type { RouteKind }
