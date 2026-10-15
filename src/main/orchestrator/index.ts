/**
 * 编排 IPC（O1 + B 批）—— 通道 + 事件。
 * 事件：plan:changed（计划快照）、plan:event（append-only 审计，含 source_message_id）
 * plan:create 立即返回 drafting；plan:replan 为真实增量协议（幂等 + CAS + 原子后缀）。
 */
import type { IpcMainInvokeEvent } from 'electron'

import type { PlanEvent, PlanRecord, ReplanOp, StageRecord } from '../../shared/plan-types'

import { PlanRegistry, type PlanSnapshot, type ReplanRequest } from './registry.ts'
import type { StageAction } from './state.ts'

type HandleFn = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown) => void

export interface OrchestratorHandle {
  registry: PlanRegistry
}

export function registerOrchestratorHandlers(
  handle: HandleFn,
  send: (channel: string, payload: unknown) => void
): OrchestratorHandle {
  const registry = new PlanRegistry(
    (snapshot: PlanSnapshot) => send('plan:changed', snapshot),
    (event: PlanEvent) => send('plan:event', event)
  )

  /** 建计划：同步只做分类+骨架（立即返回 drafting），首阶段 author 走事件推进 */
  handle('plan:create', (_e, payload: { prompt: string; canvasContext?: { hasImage?: boolean; hasText?: boolean; pixelleReady?: boolean } }) => {
    const res = registry.create(payload?.prompt ?? '', payload?.canvasContext ?? {})
    if (res.kind !== 'plan') {
      return { kind: res.kind, direct: res.kind === 'direct', capsule: res.capsule }
    }
    queueMicrotask(() => {
      registry.authorFirstStage(res.snapshot.plan.id)
    })
    return {
      kind: 'plan',
      planId: res.snapshot.plan.id,
      status: res.snapshot.plan.status,
      workflow_id: res.snapshot.plan.workflow_id,
      stage_outline: res.snapshot.plan.stage_outline,
      capsule: res.capsule
    }
  })

  handle('plan:authored', (_e, payload: { planId: string }): PlanSnapshot | { error: string } => {
    return registry.get(payload?.planId) ?? { error: `计划不存在：${payload?.planId}` }
  })

  handle('plan:list', (): PlanRecord[] => registry.list())

  handle('plan:events', (_e, payload?: { planId?: string }): PlanEvent[] => registry.listEvents(payload?.planId))

  handle('plan:authorStage', (_e, payload: { planId: string; stageOrder?: number; expectedRevision?: number }) => {
    return registry.authorFirstStage(payload?.planId)
  })

  handle(
    'plan:patchStage',
    (_e, payload: { planId: string; stageId: string; patch: Partial<StageRecord>; expectedRevision: number }) => {
      const r = registry.patchStage(payload.planId, payload.stageId, payload.patch as Parameters<PlanRegistry['patchStage']>[2], payload.expectedRevision)
      if (r.ok) return { ok: true, revision: r.value.revision, stage: r.value }
      return r.conflict ? { ok: false, conflict: true, current: r.current } : { ok: false, conflict: false, error: r.error }
    }
  )

  handle('plan:advance', (_e, payload: { planId: string; stageId: string; action: StageAction; expectedRevision: number; actor?: 'chat' | 'ui' | 'auto' }) => {
    const r = registry.advance(payload.planId, payload.stageId, payload.action, payload.expectedRevision, Date.now(), payload.actor ?? 'ui')
    if (r.ok) return { ok: true, stage: r.value }
    return r.conflict ? { ok: false, conflict: true, current: r.current } : { ok: false, conflict: false, error: r.error }
  })

  /** 增量协议（B 批）：三档中的 replan —— 原子更新后缀 + 冻结已确认前缀 */
  handle(
    'plan:replan',
    (_e, payload: { planId: string; requestId: string; preserveThroughStageId?: string; ops?: ReplanOp[]; expectedRevision?: number; actor?: 'chat' | 'ui' | 'auto'; sourceMessageId?: string }) => {
      const req: ReplanRequest = {
        planId: payload?.planId,
        requestId: payload?.requestId,
        preserveThroughStageId: payload?.preserveThroughStageId,
        ops: payload?.ops ?? [],
        expectedRevision: payload?.expectedRevision,
        actor: payload?.actor,
        sourceMessageId: payload?.sourceMessageId
      }
      return registry.replan(req)
    }
  )

  handle('plan:cancel', (_e, payload: { planId: string }) => registry.cancel(payload?.planId))

  /** C4：自动推进开关（CAS；开启即驱动机器过闸门，blocked 自动转手动） */
  handle('plan:setAutoAdvance', (_e, payload: { planId: string; enabled: boolean; expectedRevision?: number }) =>
    registry.setAutoAdvance(payload?.planId, Boolean(payload?.enabled), payload?.expectedRevision)
  )

  handle('plan:delete', (_e, payload: { planId: string }) => {
    const removed = registry.remove(payload?.planId)
    return { ok: removed }
  })

  // 探针专用（C6）：仅截图模式下暴露，用来构造「规划中断」异常态
  if (process.env.TEST_MODE === 'screenshot') {
    handle('plan:debugInterrupt', (_e, payload: { planId: string; ageMs?: number }) =>
      registry.debugInterrupt(payload?.planId, payload?.ageMs ?? 120_000)
    )
  }

  return { registry }
}
