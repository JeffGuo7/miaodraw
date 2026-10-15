/**
 * 视频管线（V1~V4）主进程入口：作业注册表 + 成本账本 + IPC。
 *
 * 本期（V1 地基）先落硬约束①（video_jobs 幂等）与②（成本护栏 fail-closed）的**可执行内核**：
 * - `video:jobs` 查作业、`video:cost` 查花费
 * - `video:job` 事件 → 渲染层落 IndexedDB（沿用 M1 方式：主进程算，渲染层持久化）
 * - 付费执行唯一入口 `authorizePaidSubmit`（预算 + 一次性凭证），任何不满足一律拒且不发请求
 * - 探针专用通道（仅 TEST_MODE=screenshot）用于零成本端到端断言幂等/闸门
 *
 * script/tts/shots/frame/compose 的步骤实现接在同一注册表上（每步先 ensure job → decideSubmit → 执行 → 记账）。
 */
import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'

import { VideoJobRegistry, decideSubmit, markDone, markFailed, markRunning, markSkipped, type CreateJobInput, type VideoJobRecord } from './jobs.ts'
import { CostLedger, authorizePaidSubmit, estimateCost, issueConfirmToken, paidItemsHash, type ConfirmToken, type CostItem, type PaidSubmitAuth } from './cost.ts'

type HandleFn = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown) => void

export interface VideoHandle {
  jobs: VideoJobRegistry
  ledger: CostLedger
  /** 作业变更对外广播（渲染层落盘 + UI 进度） */
  emitJob: (job: VideoJobRecord) => void
  /**
   * 付费执行唯一入口（fail-closed）：预算 + 一次性凭证。
   * 一次性语义由主进程的 usedTokens 兜底 —— 调用方即使握着原始凭证对象也无法重放。
   */
  authorizePaid: (args: {
    planId: string
    stageId: string
    revision: number
    items: CostItem[]
    acceptUnpriced?: boolean
    token?: ConfirmToken | null
  }) => PaidSubmitAuth
}

export interface VideoOptions {
  /** 预算（元）：settings.videoBudget，默认 ¥20 */
  budgetCny: () => number
  /** 审计/记账落库（写 plan_events；由 orchestrator 提供） */
  audit?: (event: { plan_id: string; stage_id: string; job_id: string; kind: string; cny: number; request_id?: string; at: number; detail?: string }) => void
}

/** 一次性凭证暂存（按 planId:stageId 存最新一张；用后作废） */
const tokens = new Map<string, ConfirmToken>()
const tokenKey = (planId: string, stageId: string): string => `${planId}|${stageId}`

export function registerVideoHandlers(
  handle: HandleFn,
  send: (channel: string, payload: unknown) => void,
  opts: VideoOptions
): VideoHandle {
  const jobs = new VideoJobRegistry()
  const ledger = new CostLedger()
  const emitJob = (job: VideoJobRecord): void => send('video:job', job)

  /** 已消费凭证（主进程权威记录）：同一凭证字符串永不复用 */
  const usedTokens = new Set<string>()

  /**
   * 付费执行唯一入口：预算 → 一次性凭证；成功后把凭证记为已消费（重放一律拒）。
   */
  const authorizePaid: VideoHandle['authorizePaid'] = (args) => {
    const items = args.items ?? []
    if (args.token && usedTokens.has(args.token.token)) {
      return { ok: false, code: 'TOKEN_USED', reason: '该确认凭证已使用过，请重新确认', estimate: estimateCost(items) }
    }
    const auth = authorizePaidSubmit({
      stageId: args.stageId,
      revision: Number(args.revision) || 0,
      items,
      token: args.token ?? null,
      spentCny: ledger.spentOf(args.planId),
      budgetCny: opts.budgetCny(),
      acceptUnpriced: args.acceptUnpriced
    })
    if (auth.ok && auth.token) usedTokens.add(auth.token.token)
    return auth
  }

  const put = (job: VideoJobRecord): VideoJobRecord => {
    jobs.put(job)
    emitJob(job)
    return job
  }

  handle('video:jobs', (_e, payload: { planId: string; stageId?: string }): VideoJobRecord[] =>
    jobs.listByStage(payload?.planId, payload?.stageId)
  )

  handle('video:cost', (_e, payload: { planId: string }) => {
    const budget = Math.max(0, Number(opts.budgetCny()) || 0)
    const spent = ledger.spentOf(payload?.planId)
    return { planId: payload?.planId, budget, spent, remaining: Math.max(0, Math.round((budget - spent) * 100) / 100), byStage: ledger.byStage(payload?.planId), currency: 'CNY' }
  })

  // ── 探针/调试通道（仅截图模式注册）：零成本验证幂等与成本闸门 ──
  if (process.env.TEST_MODE === 'screenshot') {
    handle('video:debugEnsure', (_e, payload: CreateJobInput) => jobs.ensure(payload))

    handle('video:debugDecide', (_e, payload: { planId: string; stageId: string; workItemId: string }) => {
      const job = jobs.get(payload?.planId, payload?.stageId, payload?.workItemId)
      return decideSubmit(job)
    })

    handle('video:debugAdvance', (_e, payload: { planId: string; stageId: string; workItemId: string; action: 'running' | 'done' | 'failed' | 'skipped'; assetId?: string; error?: string; costCny?: number }) => {
      const job = jobs.get(payload?.planId, payload?.stageId, payload?.workItemId)
      if (!job) throw new Error('作业不存在')
      const now = Date.now()
      let next: VideoJobRecord
      if (payload.action === 'running') next = markRunning(job, now)
      else if (payload.action === 'done') next = markDone(job, payload.assetId, now)
      else if (payload.action === 'skipped') next = markSkipped(job, payload.error ?? '跳过', now)
      else next = markFailed(job, payload.error ?? '失败', now)
      if (typeof payload.costCny === 'number' && payload.costCny > 0) {
        next = { ...next, cost_cny: payload.costCny }
        const entry = ledger.record({ plan_id: next.plan_id, stage_id: next.stage_id, job_id: next.id, kind: next.kind, cny: payload.costCny, request_id: next.request_id, at: now })
        opts.audit?.({ plan_id: entry.plan_id, stage_id: entry.stage_id, job_id: entry.job_id, kind: entry.kind, cny: entry.cny, request_id: entry.request_id, at: entry.at, detail: `video job 记账（${next.kind}）` })
      }
      return put(next)
    })

    /** 模拟「用户在审阅卡上确认」：签发一次性凭证（真实 UI 走闸门后由主进程签发） */
    handle('video:debugIssueToken', (_e, payload: { planId: string; stageId: string; revision: number; items: CostItem[]; acceptUnpriced?: boolean }) => {
      const token = issueConfirmToken({
        stageId: payload?.stageId,
        revision: Number(payload?.revision) || 0,
        paidHash: paidItemsHash(payload?.items ?? []),
        nonce: randomUUID(),
        acceptUnpriced: payload?.acceptUnpriced
      })
      tokens.set(tokenKey(payload?.planId, payload?.stageId), token)
      return token
    })

    /** 付费执行总闸门（不真的调用付费接口，只返回判定结果） */
    handle('video:debugAuthorize', (_e, payload: { planId: string; stageId: string; revision: number; items: CostItem[]; acceptUnpriced?: boolean; tokenOverride?: ConfirmToken }) => {
      const token = payload?.tokenOverride ?? tokens.get(tokenKey(payload?.planId, payload?.stageId)) ?? null
      const auth = authorizePaid({
        planId: payload?.planId,
        stageId: payload?.stageId,
        revision: Number(payload?.revision) || 0,
        items: payload?.items ?? [],
        acceptUnpriced: payload?.acceptUnpriced,
        token
      })
      return { ok: auth.ok, code: auth.code, reason: auth.reason, estimate: auth.estimate, tokenUsed: auth.token?.used === true, token: auth.token }
    })

    handle('video:debugSeedLedger', (_e, entries: Array<{ plan_id: string; stage_id: string; job_id: string; kind: string; cny: number; at: number }>) => {
      ledger.seed(entries as Parameters<CostLedger['seed']>[0])
      return ledger.list()
    })

    handle('video:debugReset', () => {
      jobs.clear()
      ledger.clear()
      tokens.clear()
      usedTokens.clear()
      return true
    })
  }

  return { jobs, ledger, emitJob, authorizePaid }
}
