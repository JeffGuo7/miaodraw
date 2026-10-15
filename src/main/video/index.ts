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
import { planStageJobs, type PlanStageInput } from './planning.ts'
import { parseScript } from './script.ts'
import { runStage, prepareStage } from './executor.ts'

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
  /** 审计/记账落库（写 plan_events；event 由调用方给定：video_script/video_paid/video_compose/…） */
  audit?: (event: { plan_id: string; stage_id: string; event?: string; job_id?: string; kind?: string; cny?: number; request_id?: string | null; at?: number; detail?: string }) => void
  /** V1 executor 需要的目录与凭证（由主进程注入，模块本身不读 electron） */
  paths?: { imageDir: () => string; videoDir: () => string; tmpDir: () => string }
  bailian?: { origin: () => string; apiKey: () => string }
}

/** 一次性凭证暂存（按 planId:stageId 存最新一张；用后作废） */
const tokens = new Map<string, ConfirmToken>()
const tokenKey = (planId: string, stageId: string): string => `${planId}|${stageId}`

/** 诊断用：从任意响应体里尽力取音频 URL（失败返回空串） */
function parseTtsResponseLike(raw: string): string {
  try {
    const j = JSON.parse(raw)
    const out = (j && j.output) || {}
    return String((out.audio && out.audio.url) || out.audio_url || '')
  } catch {
    return ''
  }
}

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
  /** 协作式取消标记 */
  const cancelled = new Set<string>()

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

  /**
   * `video:confirm`：用户在预估卡上确认后签发一次性凭证（绑定 stageId + revision + 付费项哈希）。
   * 生产通道（非探针）：渲染层拿到 token 后随 `video:run` 一起提交。
   */
  handle('video:confirm', (_e, payload: { planId: string; stageId: string; revision: number; items: CostItem[]; acceptUnpriced?: boolean }) => {
    const items = payload?.items ?? []
    if (!items.length) throw new Error('没有可确认的付费项（先做一次预估）')
    const token = issueConfirmToken({
      stageId: payload?.stageId,
      revision: Number(payload?.revision) || 0,
      paidHash: paidItemsHash(items),
      nonce: randomUUID(),
      acceptUnpriced: payload?.acceptUnpriced
    })
    tokens.set(tokenKey(payload?.planId, payload?.stageId), token)
    const est = estimateCost(items)
    opts.audit?.({ plan_id: payload?.planId, stage_id: payload?.stageId, event: 'video_confirm', detail: `用户确认付费执行：预估 ¥${est.expectCny.toFixed(2)}（${items.length} 项）` })
    return { token, estimate: est, paidItemsHash: paidItemsHash(items) }
  })

  /**
   * `video:run`：真正执行（付费闸门 fail-closed）。返回最终的 jobs / 成片路径 / 实际花费。
   * 不通过闸门 → 直接返回 COST_GATE_REQUIRED，**不发任何付费请求**。
   */
  handle('video:run', async (_e, payload: {
    planId: string
    stageId: string
    revision: number
    brief: string
    shotCount?: number
    shotSeconds?: number
    onScreenText?: string
    imageModel?: string
    ratio?: string
    resolution?: string
    voice?: string
    confirmToken?: ConfirmToken | null
    acceptUnpriced?: boolean
    onlyWorkItems?: string[]
    /** 复用预估阶段的分镜（保证与确认凭证绑定的付费项一致） */
    prepared?: { narration: string; shots: Array<{ workItemId: string; imagePrompt: string }> }
  }) => {
    const planId = String(payload?.planId ?? '')
    const stageId = String(payload?.stageId ?? '')
    if (!planId || !stageId) throw new Error('缺少 planId / stageId')
    const key = tokenKey(planId, stageId)
    if (cancelled.has(key)) return { ok: false, code: 'CANCELLED', reason: '该阶段已取消，重新执行请先清除取消标记' }
    if (!opts.paths || !opts.bailian) throw new Error('视频执行器未注入目录/凭证')
    const spentBefore = ledger.spentOf(planId)
    // 一次性凭证：**执行开始时即消费**（同一凭证不可能再跑第二次 → 杜绝重复付费）
    const usedToken = payload?.confirmToken ?? tokens.get(key) ?? null
    if (usedToken) {
      if (usedTokens.has(usedToken.token)) {
        return { ok: false, code: 'TOKEN_USED', reason: '该确认凭证已使用过，请重新确认后再执行', spentTotal: spentBefore }
      }
      usedTokens.add(usedToken.token)
    }
    const res = await runStage(
      {
        planId,
        stageId,
        revision: Number(payload?.revision) || 0,
        brief: String(payload?.brief ?? ''),
        shotCount: payload?.shotCount,
        shotSeconds: payload?.shotSeconds,
        onScreenText: payload?.onScreenText,
        imageModel: payload?.imageModel,
        ratio: payload?.ratio,
        resolution: payload?.resolution,
        voice: payload?.voice,
        imageDir: opts.paths.imageDir(),
        videoDir: opts.paths.videoDir(),
        tmpDir: opts.paths.tmpDir(),
        origin: opts.bailian.origin(),
        apiKey: opts.bailian.apiKey(),
        budgetCny: opts.budgetCny(),
        spentCny: spentBefore,
        confirmToken: payload?.confirmToken ?? tokens.get(key) ?? null,
        acceptUnpriced: payload?.acceptUnpriced,
        onlyWorkItems: payload?.onlyWorkItems,
        prepared: payload?.prepared
          ? {
              script: { title: '', narration: payload.prepared.narration, shots: payload.prepared.shots.map((s, i) => ({ index: i + 1, narration: '', image_prompt: s.imagePrompt })), issues: [], blacklistHits: [], budget: { min: 0, max: 0 } },
              shots: payload.prepared.shots.map((s, i) => ({ workItemId: s.workItemId || `shot_${i + 1}`, imagePrompt: s.imagePrompt }))
            }
          : undefined,
        shouldCancel: () => cancelled.has(key),
        audit: (e) => opts.audit?.(e),
        onProgress: (p) => send('video:progress', { planId, ...p })
      },
      {
        get: (p, s, w) => jobs.get(p, s, w),
        ensure: (j) => jobs.ensure(j),
        put: (j) => put(j)
      }
    )

    // 记账落库（内存账本 + plan_events 审计）；凭证仅在成功走完闸门后消费
    const at = Date.now()
    for (const c of res.charges) {
      ledger.record({ plan_id: planId, stage_id: stageId, job_id: c.jobId, kind: 'image', cny: c.cny, request_id: c.request_id, at })
      opts.audit?.({ plan_id: planId, stage_id: stageId, event: 'video_paid', job_id: c.jobId, kind: c.kind, cny: c.cny, request_id: c.request_id, at, detail: 'video run 记账' })
    }
    if (res.ok) {
      const tok = payload?.confirmToken ?? tokens.get(key)
      if (tok) usedTokens.add(tok.token)
    }
    return { ...res, spentBefore, spentTotal: ledger.spentOf(planId), remaining: Math.max(0, Math.round((opts.budgetCny() - ledger.spentOf(planId)) * 100) / 100) }  })

  /** 协作式取消：标记后当前执行会在下一个付费步骤前停止（已产生的作业产物保留） */
  handle('video:cancel', (_e, payload: { planId: string; stageId: string }) => {
    const key = tokenKey(payload?.planId, payload?.stageId)
    cancelled.add(key)
    return { ok: true, cancelled: key }
  })

  handle('video:resume', (_e, payload: { planId: string; stageId: string; jobs?: VideoJobRecord[] }) => {
    const key = tokenKey(payload?.planId, payload?.stageId)
    cancelled.delete(key)
    // 重启续跑：渲染层把 IndexedDB 里的作业回灌主进程（幂等 put），再挑出 failed/running
    if (Array.isArray(payload?.jobs)) for (const j of payload.jobs) if (j?.id) jobs.put(j)
    const pending = jobs.listByStage(payload?.planId, payload?.stageId).filter((j) => j.status === 'failed' || j.status === 'running')
    return { ok: true, retriedJobIds: pending.map((j) => j.id), onlyWorkItems: pending.map((j) => j.work_item_id), seeded: Array.isArray(payload?.jobs) ? payload.jobs.length : 0 }
  })

  /**
   * `video:plan`：**只预估不执行**（设计稿 §2.5）——把阶段要干的活翻译成 jobs + 成本，
   * 不写注册表、不计账、不发任何付费请求。
   */
  handle('video:plan', async (_e, payload: PlanStageInput & { brief?: string; shotCount?: number; shotSeconds?: number; onScreenText?: string; ratio?: string; resolution?: string }) => {
    // 带 brief 时：跑一次分镜 LLM（规划步骤，无付费图片/视频请求），返回可确认的付费项清单
    if (payload?.brief && !payload?.shots?.length) {
      if (!opts.bailian) throw new Error('视频执行器未注入凭证')
      const prepared = await prepareStage({
        planId: payload.planId,
        stageId: payload.stageId,
        revision: Number(payload.revision) || 0,
        brief: String(payload.brief),
        shotCount: payload.shotCount,
        shotSeconds: payload.shotSeconds,
        onScreenText: payload.onScreenText,
        imageModel: payload.imageModel,
        ratio: payload.ratio,
        resolution: payload.resolution,
        origin: opts.bailian.origin(),
        apiKey: opts.bailian.apiKey()
      })
      const est = prepared.planned.estimate
      return {
        planId: payload.planId,
        stageId: payload.stageId,
        revision: Number(payload.revision) || 0,
        shotCount: prepared.shots.length,
        shots: prepared.shots,
        narration: prepared.script.narration,
        issues: prepared.script.issues,
        blacklist: prepared.script.blacklistHits.map((h) => h.kind),
        jobs: prepared.planned.jobs.map((j) => ({ id: j.id, kind: j.kind, paid: j.paid, model: j.model, shot_index: j.shot_index })),
        items: prepared.planned.items,
        paidItemsHash: paidItemsHash(prepared.planned.items),
        estimatedCost: est.expectCny,
        currency: est.currency,
        estimate: est,
        modelMix: prepared.planned.modelMix,
        unpriced: est.unpriced,
        budget: { spent: ledger.spentOf(payload.planId), remaining: Math.max(0, Math.round((opts.budgetCny() - ledger.spentOf(payload.planId)) * 100) / 100) }
      }
    }
    const plan = planStageJobs(payload)
    return {
      planId: payload?.planId,
      stageId: payload?.stageId,
      revision: Number(payload?.revision) || 0,
      jobKeys: plan.jobs.map((j) => j.id),
      jobs: plan.jobs.map((j) => ({ id: j.id, kind: j.kind, paid: j.paid, model: j.model, shot_index: j.shot_index })),
      shots: plan.shotCount,
      items: plan.items,
      paidItemsHash: paidItemsHash(plan.items),
      estimatedCost: plan.estimate.expectCny,
      currency: plan.estimate.currency,
      estimate: plan.estimate,
      modelMix: plan.modelMix,
      unpriced: plan.estimate.unpriced,
      budget: { spent: ledger.spentOf(payload?.planId), remaining: Math.max(0, Math.round((opts.budgetCny() - ledger.spentOf(payload?.planId)) * 100) / 100) }
    }
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

    /** 分镜解析（零成本）：探针用固定 LLM 文本断言解析/校验，不调用任何模型 */
    handle('video:debugParseScript', (_e, payload: { llmText: string; shotCount?: number; shotSeconds?: number; expectedTotalSeconds?: number }) => {
      const r = parseScript(payload?.llmText ?? '', { shotCount: payload?.shotCount, shotSeconds: payload?.shotSeconds, expectedTotalSeconds: payload?.expectedTotalSeconds })
      return { title: r.title, narration: r.narration, shots: r.shots, issues: r.issues, blacklist: r.blacklistHits.map((h) => h.kind), budget: r.budget }
    })

    /** TTS 端点诊断（零成本计划外，仅用于定位请求形态）：逐个试组合并回传原始状态/响应 */
    handle('video:debugTtsProbe', async (_e, payload: { text?: string }) => {
      if (!opts.bailian) throw new Error('未注入凭证')
      const origin = opts.bailian.origin().replace(/\/+$/, '')
      const key = opts.bailian.apiKey()
      const text = payload?.text ?? '这是一次接口自检。'
      const tries = [
        { id: 'a:qwen3-tts-flash', url: `${origin}/api/v1/services/aigc/multimodal-generation/generation`, body: { model: 'qwen3-tts-flash', input: { text, voice: 'Cherry' } } },
        { id: 'b:qwen-tts', url: `${origin}/api/v1/services/aigc/multimodal-generation/generation`, body: { model: 'qwen-tts', input: { text, voice: 'Cherry' } } },
        { id: 'c:qwen3-tts-flash+lang', url: `${origin}/api/v1/services/aigc/multimodal-generation/generation`, body: { model: 'qwen3-tts-flash', input: { text, voice: 'Cherry' }, parameters: { language_type: 'Chinese' } } },
        { id: 'd:compat/audio/speech', url: `${origin}/compatible-mode/v1/audio/speech`, body: { model: 'qwen3-tts-flash', input: text, voice: 'Cherry' } },
        { id: 'e:official-domain', url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', body: { model: 'qwen3-tts-flash', input: { text, voice: 'Cherry' } } },
        { id: 'f:no-voice', url: `${origin}/api/v1/services/aigc/multimodal-generation/generation`, body: { model: 'qwen3-tts-flash', input: { text } } },
        { id: 'g:parameters-voice', url: `${origin}/api/v1/services/aigc/multimodal-generation/generation`, body: { model: 'qwen3-tts-flash', input: { text }, parameters: { voice: 'Cherry' } } }
      ]
      const out: Array<{ id: string; status: number; body: string; audioUrl?: string }> = []
      for (const t of tries) {
        try {
          const res = await fetch(t.url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(t.body), signal: AbortSignal.timeout(60_000) })
          const body = await res.text()
          let audioUrl = ''
          try {
            audioUrl = parseTtsResponseLike(body)
          } catch {
            audioUrl = ''
          }
          out.push({ id: t.id, status: res.status, body: body.slice(0, 240), audioUrl })
        } catch (e) {
          out.push({ id: t.id, status: -1, body: e instanceof Error ? e.message : String(e) })
        }
      }
      return out
    })

    handle('video:debugSeedLedger', (_e, entries: Array<{ plan_id: string; stage_id: string; job_id: string; kind: string; cny: number; at: number }>) => {      ledger.seed(entries as Parameters<CostLedger['seed']>[0])
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
