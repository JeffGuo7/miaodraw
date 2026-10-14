/**
 * 计划持久化（O1）：plan 是真相源，画布节点只是视图。
 * 主进程每次 plan:changed 推全量快照，这里落 IndexedDB（plans/stages），支持重启续跑。
 */
import type { PlanRecord, StageRecord } from './plan-types'

import { assertAssetsMigrated, getPlan, listPlans, listStagesByPlan, putPlan, putStageBatch, SCHEMA_VERSION, setMeta } from './db'

interface PlanChangedPayload {
  plan: PlanRecord
  stages: StageRecord[]
}

let attached = false
let unsubscribe: (() => void) | null = null

/** 订阅 plan:changed 并落盘；重复调用安全 */
export function attachPlanPersistence(): () => void {
  if (attached && unsubscribe) return unsubscribe
  attached = true

  // 迁移断言：v2 后所有资产必须有 superseded_by（失败只记日志，不阻塞画布）
  void assertAssetsMigrated()
    .then((r) => {
      void setMeta('schema', { version: SCHEMA_VERSION, assetsChecked: r.total, at: Date.now() })
      console.info(`[canvas-db] 迁移断言通过：assets=${r.total}，schema=v${SCHEMA_VERSION}`)
    })
    .catch((e) => console.warn('[canvas-db] 迁移断言未通过：', e instanceof Error ? e.message : e))

  const off = window.api.onPlanChanged((raw) => {
    const payload = raw as PlanChangedPayload | undefined
    if (!payload?.plan?.id) return
    void putPlan(payload.plan)
      .then(() => putStageBatch(payload.stages ?? []))
      .catch((e) => console.warn('[plan] 落盘失败：', e instanceof Error ? e.message : e))
  })
  unsubscribe = () => {
    off()
    attached = false
    unsubscribe = null
  }
  return unsubscribe
}

/** 读回计划与阶段（重启续跑用） */
export async function loadPlan(planId: string): Promise<{ plan: PlanRecord | undefined; stages: StageRecord[] }> {
  const [plan, stages] = await Promise.all([getPlan(planId), listStagesByPlan(planId)])
  return { plan, stages }
}

export async function loadAllPlans(): Promise<PlanRecord[]> {
  return listPlans()
}
