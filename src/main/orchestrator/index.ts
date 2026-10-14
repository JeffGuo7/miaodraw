/**
 * 编排 IPC（O1）—— 7 个通道 + plan:changed 事件。
 * 与设计稿一致：plan:create **立即返回 drafting**，首阶段靠事件异步推进。
 */
import type { IpcMainInvokeEvent } from 'electron'

import type { PlanRecord, StageRecord } from '../../shared/plan-types'

import { PlanRegistry, type PlanSnapshot } from './registry.ts'
import type { StageAction } from './state.ts'

type HandleFn = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown) => void

/** 已处理的 replan 请求（幂等：同 requestId + 同 payload 直接回放结果） */
const replanSeen = new Map<string, { at: number; result: unknown }>()

export function registerOrchestratorHandlers(handle: HandleFn, send: (channel: string, payload: unknown) => void): PlanRegistry {
  const registry = new PlanRegistry((snapshot: PlanSnapshot) => {
    send('plan:changed', snapshot)
  })

  /** 建计划：同步只做分类+骨架（立即返回 drafting），首阶段 author 走事件推进 */
  handle('plan:create', (_e, payload: { prompt: string; canvasContext?: { hasImage?: boolean; hasText?: boolean; pixelleReady?: boolean } }) => {
    const res = registry.create(payload?.prompt ?? '', payload?.canvasContext ?? {})
    if (res.kind !== 'plan') {
      return { kind: res.kind, direct: res.kind === 'direct', capsule: res.capsule }
    }
    // 异步推进：先把 drafting 返回给渲染层，下一 tick 再物化首阶段并广播
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

  handle('plan:authorStage', (_e, payload: { planId: string; stageOrder?: number; expectedRevision?: number }) => {
    return registry.authorFirstStage(payload?.planId)
  })

  handle(
    'plan:patchStage',
    (_e, payload: { planId: string; stageId: string; patch: Partial<StageRecord>; expectedRevision: number }) => {
      const r = registry.patchStage(payload.planId, payload.stageId, payload.patch as Parameters<PlanRegistry['patchStage']>[2], payload.expectedRevision)
      return r.ok ? { ok: true, revision: r.value.revision, stage: r.value } : { ok: false, conflict: r.conflict ?? false, current: r.current, error: r.error }
    }
  )

  handle('plan:advance', (_e, payload: { planId: string; stageId: string; action: StageAction; expectedRevision: number }) => {
    const r = registry.advance(payload.planId, payload.stageId, payload.action, payload.expectedRevision)
    return r.ok ? { ok: true, stage: r.value } : { ok: false, conflict: r.conflict ?? false, current: r.current, error: r.error }
  })

  /** O4 才做增量 replan；O1 先按幂等契约占位（同 requestId 回放，不重复执行） */
  handle('plan:replan', (_e, payload: { planId: string; requestId: string; preserveThroughStageId?: string; ops?: unknown[] }) => {
    const key = `${payload?.planId}:${payload?.requestId}`
    const seen = replanSeen.get(key)
    if (seen) return seen.result
    const result = { ok: false, error: 'replan 在 O4 提供（O1 仅占位，幂等键已记录）' }
    replanSeen.set(key, { at: Date.now(), result })
    return result
  })

  handle('plan:delete', (_e, payload: { planId: string }) => {
    const removed = registry.remove(payload?.planId)
    return { ok: removed }
  })

  return registry
}
