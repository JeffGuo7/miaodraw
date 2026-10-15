/**
 * C6：空态 / 异常态 / 断线恢复（纯函数，零依赖 → Node 可直接单测）。
 *
 * 两类异常：
 * 1. 规划中断（stale）：计划停在 `drafting`、一个阶段都没物化、且超过 STALE_MS 没有进展。
 *    —— 有阶段物化就说明有过进展；主进程明确报「仍在跑」时一律不判 stale（宁可晚判，不可误判）。
 * 2. 事件缺口：`plan:changed` 只推增量时，revision 跳变或快照缺 stages 说明中间事件丢了，
 *    必须走 `plan:authored` 全量重拉把卡片拉回真相源。
 */

/** 规划中断阈值（任务卡：>60s 无进展） */
export const STALE_MS = 60_000

export interface RecoverPlanLike {
  status: string
  updated_at: number
}

export interface RecoverStageLike {
  status: string
}

export interface StaleOptions {
  /** 便于单测注入；默认 Date.now() */
  now?: number
  /** 覆盖阈值 */
  staleMs?: number
  /** 主进程仍在跑（活跃标志）→ 不得判 stale */
  inflight?: boolean
}

/**
 * 是否「规划中断」。
 * 只有 drafting + 零物化阶段 + 超过阈值才成立；任何一项不满足都返回 false。
 */
export function isPlanStale(
  plan: RecoverPlanLike | null | undefined,
  stages: RecoverStageLike[] | null | undefined,
  opts: StaleOptions = {}
): boolean {
  if (!plan || plan.status !== 'drafting') return false
  if (opts.inflight) return false
  const list = stages ?? []
  if (list.length > 0) return false
  // 阶段里还有在执行的东西也说明没断（防御：正常情况下列表为空，这条不会命中）
  if (list.some((s) => s.status === 'doing')) return false
  const at = Number(plan.updated_at)
  if (!Number.isFinite(at) || at <= 0) return false
  const now = opts.now ?? Date.now()
  return now - at > (opts.staleMs ?? STALE_MS)
}

export interface IncomingSnapshotLike {
  /** 真实形态：plan:changed 推的是 { plan, stages } */
  plan?: { revision?: number }
  /** 兼容扁平形态（{ revision, stages }） */
  revision?: number
  stages?: unknown
}

/** 从两种形态里取 revision（快照形态优先） */
function revisionOf(incoming: IncomingSnapshotLike): number {
  const raw = incoming.plan?.revision ?? incoming.revision
  return Number(raw)
}

/**
 * 是否需要全量重拉（`plan:authored`）。
 * - 事件没带 stages → 是增量事件，本地补不齐 → 重拉
 * - revision 跳变（> prev+1）→ 中间事件丢了 → 重拉
 * - 首次事件（prev 为 null）不重拉：卡片挂载时本来就会主动拉一次
 */
export function needsFullRefresh(prevRevision: number | null, incoming: IncomingSnapshotLike | null | undefined): boolean {
  if (!incoming) return true
  if (!Array.isArray(incoming.stages)) return true
  const rev = revisionOf(incoming)
  if (!Number.isFinite(rev)) return true
  if (prevRevision === null) return false
  return rev > prevRevision + 1
}
