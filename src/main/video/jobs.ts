/**
 * video_jobs（硬约束①：幂等）—— job key = `planId|stageId|workItemId`，**纯逻辑，零 IO**。
 *
 * 五条硬规则（Jeff 批，设计稿 §2.4）：
 * 1. 三键拼接主键，put 覆盖语义：重复调用不产生第二条
 * 2. 付费提交前必查既有 job：done 直接复用产物；running 先对账（产物已落盘转 done，未落盘才允许重提）
 * 3. 付费提交带 request_id = hash(planId|stageId|workItemId|promptHash)：同 request_id 视为重放
 * 4. 续跑只碰 failed/running；done/skipped 一律跳过
 * 5. 同一 job 自动重试 ≤2 次，超限置 blocked
 *
 * 持久化落 IndexedDB 的 `video_jobs` store（渲染层按 M1 方式写）；主进程工作集由 VideoJobRegistry 承担。
 */

export type VideoJobKind = 'tts' | 'image' | 'video' | 'frame' | 'compose'
export type VideoJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'blocked'

export interface VideoJobRecord {
  /** = jobKey(planId, stageId, workItemId) */
  id: string
  plan_id: string
  stage_id: string
  work_item_id: string
  shot_index: number
  kind: VideoJobKind
  provider?: string
  model?: string
  status: VideoJobStatus
  attempts: number
  last_error?: string
  prompt_hash?: string
  /** 付费提交幂等键 */
  request_id?: string
  /** 是否花钱：付费 job 必须已通过成本闸门 */
  paid: boolean
  output_asset_id?: string
  started_at?: number
  finished_at?: number
  /** V4 降级帧标记（成片卡要显示「含 N 帧降级」） */
  degraded?: boolean
  /** 记账：本次实际/预估花费（元） */
  cost_cny?: number
  /** 作业创建时间（便于对账/调试；状态时间看 started_at/finished_at） */
  created_at?: number
}

/** 同一 job 自动重试上限（超过置 blocked 并提问） */
export const MAX_JOB_ATTEMPTS = 2

/** 稳定 hash（djb2 变体）：不用于安全，只用于幂等键与指纹 */
export function hashText(text: string): string {
  let h = 5381
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

export function jobKey(planId: string, stageId: string, workItemId: string): string {
  return `${String(planId ?? '')}|${String(stageId ?? '')}|${String(workItemId ?? '')}`
}

/** 付费提交幂等键：同 plan/stage/item/prompt → 同 request_id（服务端视为重放） */
export function requestIdFor(planId: string, stageId: string, workItemId: string, promptHash: string): string {
  return `vjob_${hashText(`${planId}|${stageId}|${workItemId}|${promptHash}`)}`
}

export interface CreateJobInput {
  planId: string
  stageId: string
  workItemId: string
  shotIndex?: number
  kind: VideoJobKind
  provider?: string
  model?: string
  paid: boolean
  promptHash?: string
}

export function createJob(input: CreateJobInput, now = Date.now()): VideoJobRecord {
  const promptHash = input.promptHash ?? hashText(input.workItemId)
  return {
    id: jobKey(input.planId, input.stageId, input.workItemId),
    plan_id: input.planId,
    stage_id: input.stageId,
    work_item_id: input.workItemId,
    shot_index: Math.max(0, Math.round(Number(input.shotIndex) || 0)),
    kind: input.kind,
    provider: input.provider,
    model: input.model,
    status: 'pending',
    attempts: 0,
    prompt_hash: promptHash,
    request_id: input.paid ? requestIdFor(input.planId, input.stageId, input.workItemId, promptHash) : undefined,
    paid: input.paid,
    created_at: now
  }
}

export type SubmitAction = 'submit' | 'reuse' | 'reconcile' | 'skip' | 'blocked'

export interface SubmitDecision {
  action: SubmitAction
  reason: string
  /** reuse 时回传的既有产物 */
  output_asset_id?: string
  request_id?: string
}

/**
 * 付费/非付费共用的一次「能不能提交」判定（硬规则 2/4/5）。
 * 调用方负责：reconcile → 查产物是否落盘，落盘则 markDone，否则按 submit 处理。
 */
export function decideSubmit(existing: VideoJobRecord | undefined | null): SubmitDecision {
  if (!existing) return { action: 'submit', reason: '首次执行' }
  if (existing.status === 'done') return { action: 'reuse', reason: '已有成功产物，复用不重复付费', output_asset_id: existing.output_asset_id }
  if (existing.status === 'skipped') return { action: 'skip', reason: '已显式跳过' }
  if (existing.status === 'blocked') return { action: 'blocked', reason: existing.last_error ?? '已超出自动重试上限，需人工处理' }
  if (existing.status === 'running') return { action: 'reconcile', reason: '上次执行中断：先对账产物是否已落盘，未落盘才允许重提', request_id: existing.request_id }
  if (existing.attempts >= MAX_JOB_ATTEMPTS) {
    return { action: 'blocked', reason: `已连续失败 ${existing.attempts} 次（上限 ${MAX_JOB_ATTEMPTS}），需人工确认后再跑` }
  }
  return { action: 'submit', reason: existing.status === 'failed' ? '上次失败，允许重试' : '继续未开始的作业', request_id: existing.request_id }
}

// ── 状态迁移（不可变，返回新记录） ──

export function markRunning(job: VideoJobRecord, now = Date.now()): VideoJobRecord {
  return { ...job, status: 'running', attempts: job.attempts + 1, started_at: now, last_error: undefined }
}

export function markDone(job: VideoJobRecord, outputAssetId: string | undefined, now = Date.now(), degraded?: boolean): VideoJobRecord {
  return { ...job, status: 'done', output_asset_id: outputAssetId, finished_at: now, last_error: undefined, degraded: degraded ?? job.degraded }
}

export function markFailed(job: VideoJobRecord, error: string, now = Date.now()): VideoJobRecord {
  const next: VideoJobRecord = { ...job, status: 'failed', last_error: String(error ?? '').slice(0, 500), finished_at: now }
  // 超限直接置 blocked（硬规则 5），不留给调用方「再试一次」的模糊状态
  return next.attempts >= MAX_JOB_ATTEMPTS ? { ...next, status: 'blocked', last_error: `${next.last_error}（已连续失败 ${next.attempts} 次，需人工确认）` } : next
}

export function markSkipped(job: VideoJobRecord, reason: string, now = Date.now()): VideoJobRecord {
  return { ...job, status: 'skipped', last_error: String(reason ?? '').slice(0, 500), finished_at: now }
}

export function markDegraded(job: VideoJobRecord): VideoJobRecord {
  return { ...job, degraded: true }
}

/** 续跑集合：只碰 failed / running（硬规则 4） */
export function resumableJobs(jobs: VideoJobRecord[]): VideoJobRecord[] {
  return jobs.filter((j) => j.status === 'failed' || j.status === 'running')
}

/** 主进程工作集（幂等：按 id put 覆盖） */
export class VideoJobRegistry {
  private jobs = new Map<string, VideoJobRecord>()

  put(job: VideoJobRecord): VideoJobRecord {
    this.jobs.set(job.id, job)
    return job
  }

  get(planId: string, stageId: string, workItemId: string): VideoJobRecord | undefined {
    return this.jobs.get(jobKey(planId, stageId, workItemId))
  }

  listByStage(planId: string, stageId?: string): VideoJobRecord[] {
    return [...this.jobs.values()]
      .filter((j) => j.plan_id === planId && (stageId === undefined || j.stage_id === stageId))
      .sort((a, b) => a.shot_index - b.shot_index || a.work_item_id.localeCompare(b.work_item_id))
  }

  listByPlan(planId: string): VideoJobRecord[] {
    return this.listByStage(planId)
  }

  /** 幂等创建：已存在则原样返回既有记录（不覆盖进度） */
  ensure(input: CreateJobInput, now = Date.now()): VideoJobRecord {
    const existing = this.get(input.planId, input.stageId, input.workItemId)
    return existing ?? this.put(createJob(input, now))
  }

  clear(): void {
    this.jobs.clear()
  }
}
