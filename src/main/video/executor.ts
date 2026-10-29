/**
 * 视频管线执行器（V1）：`doc-to-video` 阶段的 executor —— script → shots(图) → tts → compose。
 *
 * 每一步都走同一套纪律（硬约束①②）：
 *   ensure job（幂等）→ decideSubmit（done 复用 / running 先对账 / 超限 blocked）→ 执行 → 记账 + 审计
 * 付费项在**开始执行前**一次性过闸门（预算 + 一次性 confirmToken）；不通过则直接返回，不发任何付费请求。
 *
 * 产物落点（设计稿 §2.3）：
 *   镜头图 → outputs/（进 assets，画布可显示）；音频与成片中间文件 → videos/（只进 assets，不占画布）
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { httpBailianImage, httpChat, httpOpenAIImages, imageCapability, compatBase, originOf, persistImage, type RefImage } from '../http.ts'
import { buildImagePrompt } from '../prompt-guards.ts'
import {
  buildConcatList,
  buildComposeArgs,
  buildProbeArgs,
  buildTtsBody,
  buildTtsUrl,
  dimensions,
  distributeByAudio,
  isAllowedAudioUrl,
  parseProbeDuration,
  parseTtsResponse
} from './media.ts'
import { buildScriptPrompt, parseScript, shotImagePrompt, type ScriptResult } from './script.ts'
import { planStageJobs, type PlanShotInput } from './planning.ts'
import { decideSubmit, markDone, markFailed, markRunning, type VideoJobRecord } from './jobs.ts'
import { authorizePaidSubmit, type ConfirmToken, type CostEstimate } from './cost.ts'

const execFileAsync = promisify(execFile)

/**
 * running 对账（硬约束①的缺口）：进程在「已提交付费请求、但还没写回 job 状态」时崩溃，
 * 重启后 job 仍是 running。此时直接重提会**重复付费**，所以先看产物是否已落盘：
 * 落盘 → 转 done 直接复用；未落盘 → 才允许重提（且由 attempts 上限兜底）。
 */
async function reconcileLanded(rel: string | undefined, baseDir: string): Promise<boolean> {
  if (!rel) return false
  try {
    const abs = path.isAbsolute(rel) ? rel : path.join(baseDir, path.basename(rel))
    const st = await fsp.stat(abs)
    return st.size > 0
  } catch {
    return false
  }
}

/** 分镜 LLM：省钱档（用户口径：推理模型用 flash） */
export const SCRIPT_MODEL = 'qwen3.8-flash'
export const IMAGE_MODEL_DEFAULT = 'z-image-turbo'

export interface RunStageInput {
  planId: string
  stageId: string
  revision: number
  /** 用户需求原句（保真，不扩写） */
  brief: string
  shotCount?: number
  shotSeconds?: number
  onScreenText?: string
  imageModel?: string
  ratio?: string
  resolution?: string
  voice?: string
  /** 图片产物目录（outputs/） */
  imageDir: string
  /** 视频/音频产物目录（videos/） */
  videoDir: string
  /** 临时目录（concat 清单等） */
  tmpDir: string
  origin: string
  apiKey: string
  budgetCny: number
  /** 已花费（记账账本给出，用于预算判定） */
  spentCny: number
  confirmToken?: ConfirmToken | null
  acceptUnpriced?: boolean
  /** 只跑这些 work_item（续跑用）；缺省=全部 */
  onlyWorkItems?: string[]
  /** 已完成的规划（预估阶段产出）：传入则跳过 LLM 步骤，保证 confirmToken 绑定的付费项与执行一致 */
  prepared?: { script: ScriptResult; shots: PlanShotInput[] }
  /** 协作式取消：每个付费步骤前检查（取消后不再发起新的付费请求） */
  shouldCancel?: () => boolean
  onProgress?: (p: { jobId: string; stageId: string; percent: number; message: string }) => void
  audit?: (e: { plan_id: string; stage_id: string; event: string; detail: string; request_id?: string | null }) => void}

export interface RunStageResult {
  ok: boolean
  code?: string
  reason?: string
  estimate: CostEstimate
  jobs: VideoJobRecord[]
  script?: ScriptResult
  /** 成片相对路径（videos/xxx.mp4） */
  finalRelPath?: string
  finalAbsPath?: string
  imagePaths: string[]  // 相对 outputs/
  audioPath?: string    // 相对 videos/
  spentCny: number
  /** 每步实际花费（元）：记账用 */
  charges: Array<{ jobId: string; kind: string; cny: number; request_id?: string }>
  msg: string
}

const IMAGE_PRICE: Record<string, number> = { 'z-image-turbo': 0.1, 'wan2.7-image': 0.2 }

function sha1(buf: Buffer | string): string {
  return createHash('sha1').update(buf).digest('hex')
}

/**
 * 预估阶段（`video:plan` 的核心）：跑一次 LLM → 分镜 + 逐镜头画面提示词 → 规划 jobs 与成本。
 * **不产生任何付费请求**（LLM 调用极低，属于规划成本），供 UI 展示预估并签发确认凭证。
 */
export async function prepareStage(input: {
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
  origin: string
  apiKey: string
}): Promise<{ script: ScriptResult; shots: PlanShotInput[]; planned: ReturnType<typeof planStageJobs> }> {
  const shotCount = Math.max(1, Math.round(input.shotCount ?? 3))
  const shotSeconds = Math.max(1, Math.round(input.shotSeconds ?? 3))
  const ratio = input.ratio || '9:16'
  const imageModel = input.imageModel || IMAGE_MODEL_DEFAULT

  const llmText = await httpChat({
    apiBase: compatBase(originOf(input.origin)),
    apiKey: input.apiKey,
    model: SCRIPT_MODEL,
    system: '你是短视频编导，只输出 JSON。',
    message: buildScriptPrompt(input.brief, { shotCount, shotSeconds, onScreenText: input.onScreenText }),
    timeoutMs: 120_000,
    disableThinking: true
  })
  const script = parseScript(llmText, { shotCount, shotSeconds })
  const shots: PlanShotInput[] = script.shots.slice(0, shotCount).map((s, i) => ({
    workItemId: `shot_${i + 1}`,
    imagePrompt: shotImagePrompt(s, { ratio, onScreenText: input.onScreenText })
  }))
  const planned = planStageJobs({
    planId: input.planId,
    stageId: input.stageId,
    revision: input.revision,
    shots,
    narration: script.narration,
    imageModel,
    withTts: true,
    withCompose: true
  })
  return { script, shots, planned }
}

export async function runStage(input: RunStageInput, registry: {
  get: (planId: string, stageId: string, workItemId: string) => VideoJobRecord | undefined
  ensure: (job: { planId: string; stageId: string; workItemId: string; kind: 'image' | 'tts' | 'compose' | 'frame' | 'video'; paid: boolean; shotIndex?: number; model?: string; promptHash?: string }) => VideoJobRecord
  put: (job: VideoJobRecord) => VideoJobRecord
}): Promise<RunStageResult> {
  const shotCount = Math.max(1, Math.round(input.shotCount ?? 3))
  const shotSeconds = Math.max(1, Math.round(input.shotSeconds ?? 3))
  const imageModel = input.imageModel || IMAGE_MODEL_DEFAULT
  const ratio = input.ratio || '9:16'
  const resolution = input.resolution || '720P'
  const charges: RunStageResult['charges'] = []
  const jobs: VideoJobRecord[] = []
  const imagePaths: string[] = []

  // ── 1) 文案/分镜（LLM，非付费图片项；先产出 image_prompts 才能规划作业） ──
  const progress = (jobId: string, percent: number, message: string): void => input.onProgress?.({ jobId, stageId: input.stageId, percent, message })
  let script: ScriptResult
  let shotInputs: PlanShotInput[]
  if (input.prepared) {
    // 预估阶段已跑过 LLM：直接复用，保证与用户确认的付费项一致
    script = input.prepared.script
    shotInputs = input.prepared.shots.slice(0, shotCount)
    progress('script', 0.15, '复用已确认的分镜')
  } else {
    progress('script', 0.05, '生成文案与分镜')
    try {
      const prepared = await prepareStage({ ...input, shotCount, shotSeconds })
      script = prepared.script
      shotInputs = prepared.shots
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_script', detail: `分镜 ${script.shots.length} 个${script.issues.length ? '；问题：' + script.issues.join('；') : ''}` })
    } catch (e) {
      return { ok: false, code: 'SCRIPT_FAILED', reason: `文案分镜失败：${e instanceof Error ? e.message : String(e)}`, estimate: { lines: [], minCny: 0, expectCny: 0, maxCny: 0, currency: 'CNY', unpriced: false, note: '' }, jobs, imagePaths, spentCny: 0, charges, msg: '未开始付费步骤' }
    }
  }

  // ── 2) 规划 + 付费闸门（fail-closed：不通过则一个付费请求都不发） ──
  const planned = planStageJobs({
    planId: input.planId,
    stageId: input.stageId,
    revision: input.revision,
    shots: shotInputs,
    narration: script.narration,
    imageModel,
    withTts: true,
    withCompose: true
  })
  const gate = authorizePaidSubmit({
    stageId: input.stageId,
    revision: input.revision,
    items: planned.items,
    token: input.confirmToken ?? null,
    spentCny: input.spentCny,
    budgetCny: input.budgetCny,
    acceptUnpriced: input.acceptUnpriced
  })
  if (!gate.ok) {
    input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_cost_gate', detail: `拒绝执行：${gate.code} ${gate.reason}` })
    return { ok: false, code: gate.code, reason: gate.reason, estimate: gate.estimate, jobs: planned.jobs, script, imagePaths, spentCny: 0, charges, msg: '成本闸门未通过，未发起任何付费请求' }
  }

  const allow = (wi: string): boolean => !input.onlyWorkItems?.length || input.onlyWorkItems.includes(wi)

  // ── 3) 镜头图（付费；逐 work_item 幂等） ──
  const { w, h } = dimensions(ratio, resolution)
  const cap = imageCapability(imageModel)
  for (let i = 0; i < shotInputs.length; i++) {
    const shot = shotInputs[i]
    let job = registry.ensure({ planId: input.planId, stageId: input.stageId, workItemId: shot.workItemId, kind: 'image', paid: true, shotIndex: i, model: imageModel, promptHash: sha1(shot.imagePrompt) })
    jobs.push(job)
    if (!allow(shot.workItemId)) continue
    const decision = decideSubmit(registry.get(input.planId, input.stageId, shot.workItemId))
    if (decision.action === 'reuse' || decision.action === 'skip') {
      // 复用既有产物：必须把路径补回 imagePaths，否则合成阶段拿不到素材（复跑时踩过）
      if (job.output_asset_id) imagePaths.push(job.output_asset_id)
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_job_reuse', detail: `镜头 ${i + 1} 复用既有产物（不重复付费）`, request_id: job.request_id })
      progress(job.id, 0.2 + (0.5 * (i + 1)) / shotInputs.length, `镜头 ${i + 1}/${shotInputs.length} 复用`)
      continue
    }
    if (decision.action === 'reconcile') {
      const landed = await reconcileLanded(job.output_asset_id, input.imageDir)
      if (landed && job.output_asset_id) {
        imagePaths.push(job.output_asset_id)
        job = registry.put(markDone(job, job.output_asset_id))
        jobs[jobs.length - 1] = job
        input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_job_reconcile', detail: `镜头 ${i + 1} 崩溃对账：产物已落盘，转 done（不重复付费）`, request_id: job.request_id })
        progress(job.id, 0.2 + (0.5 * (i + 1)) / shotInputs.length, `镜头 ${i + 1}/${shotInputs.length} 对账复用`)
        continue
      }
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_job_reconcile', detail: `镜头 ${i + 1} 崩溃对账：未发现产物，按未完成重提`, request_id: job.request_id })
    }
    if (input.shouldCancel?.()) {
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_cancel', detail: `用户取消：镜头 ${i + 1} 未执行` })
      return { ok: false, code: 'CANCELLED', reason: '已取消（后续付费步骤未执行）', estimate: gate.estimate, jobs, script, imagePaths, spentCny: charges.reduce((s, c) => s + c.cny, 0), charges, msg: '已取消' }
    }
    if (decision.action === 'blocked') {
      registry.put(markFailed(job, decision.reason))
      jobs[jobs.length - 1] = registry.get(input.planId, input.stageId, shot.workItemId) as VideoJobRecord
      return { ok: false, code: 'JOB_BLOCKED', reason: decision.reason, estimate: gate.estimate, jobs, script, imagePaths, spentCny: 0, charges, msg: '作业已达重试上限，需人工确认' }
    }
    job = registry.put(markRunning(job))
    progress(job.id, 0.2 + (0.5 * i) / shotInputs.length, `镜头 ${i + 1}/${shotInputs.length} 出图`)
    try {
      const prompt = buildImagePrompt(shot.imagePrompt, { size: `${w}x${h}` })
      const refs: RefImage[] = []
      const r = cap.protocol === 'openai-images'
        ? await httpOpenAIImages({ apiBase: compatBase(originOf(input.origin)), apiKey: input.apiKey, model: imageModel, prompt, refs, w, h, n: 1 })
        : await httpBailianImage({ origin: originOf(input.origin), apiKey: input.apiKey, model: imageModel, prompt, negative: undefined, w, h, seed: 0, refs, n: 1 })
      const buf = r.buffers[0]
      if (!buf?.length) throw new Error('未返回图片数据')
      const saved = await persistImage(buf, input.imageDir, { prompt, w, h, seed: 0, model: imageModel, provider: 'bailian', parent: shot.workItemId })
      imagePaths.push(`outputs/${saved.file}`)
      job = registry.put(markDone(job, `outputs/${saved.file}`))
      const cny = IMAGE_PRICE[imageModel] ?? 0
      job = registry.put({ ...job, cost_cny: cny })
      charges.push({ jobId: job.id, kind: 'image', cny, request_id: job.request_id })
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_paid', detail: `镜头 ${i + 1} 出图 ¥${cny}（${imageModel}）`, request_id: job.request_id })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      job = registry.put(markFailed(job, msg))
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_job_failed', detail: `镜头 ${i + 1} 出图失败：${msg}` })
      return { ok: false, code: 'IMAGE_FAILED', reason: `镜头 ${i + 1} 出图失败：${msg}`, estimate: gate.estimate, jobs, script, imagePaths, spentCny: charges.reduce((s, c) => s + c.cny, 0), charges, msg: '已停止后续步骤（不留半成品）' }
    }
    jobs[jobs.length - 1] = job
  }

  // ── 4) 配音（付费，按字符） ──
  const ttsJobKey = { planId: input.planId, stageId: input.stageId, workItemId: 'tts' }
  let ttsJob = registry.ensure({ ...ttsJobKey, kind: 'tts', paid: true, model: 'qwen3-tts-flash', promptHash: sha1(script.narration) })
  let audioAbs: string | undefined
  let audioRel: string | undefined
  if (allow('tts')) {
    if (input.shouldCancel?.()) {
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_cancel', detail: '用户取消：配音未执行' })
      jobs.push(ttsJob)
      return { ok: false, code: 'CANCELLED', reason: '已取消（配音及后续步骤未执行）', estimate: gate.estimate, jobs, script, imagePaths, spentCny: charges.reduce((s, c) => s + c.cny, 0), charges, msg: '已取消' }
    }
    const decision = decideSubmit(registry.get(ttsJobKey.planId, ttsJobKey.stageId, ttsJobKey.workItemId))
    if (decision.action === 'reuse' && ttsJob.output_asset_id) {
      audioRel = ttsJob.output_asset_id
      audioAbs = path.join(input.videoDir, path.basename(ttsJob.output_asset_id))
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_job_reuse', detail: '配音复用既有产物' })
    } else if (
      decision.action === 'reconcile' &&
      ttsJob.output_asset_id &&
      (await reconcileLanded(ttsJob.output_asset_id, input.videoDir))
    ) {
      audioRel = ttsJob.output_asset_id
      audioAbs = path.join(input.videoDir, path.basename(ttsJob.output_asset_id))
      ttsJob = registry.put(markDone(ttsJob, ttsJob.output_asset_id))
      input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_job_reconcile', detail: '配音崩溃对账：产物已落盘，转 done（不重复付费）', request_id: ttsJob.request_id })
    } else if (decision.action !== 'blocked' && script.narration.trim()) {
      ttsJob = registry.put(markRunning(ttsJob))
      progress(ttsJob.id, 0.75, '配音合成')
      try {
        const res = await fetch(buildTtsUrl(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildTtsBody(script.narration, input.voice)),
          signal: AbortSignal.timeout(120_000)
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`TTS HTTP ${res.status}：${text.slice(0, 200)}`)
        const parsed = parseTtsResponse(JSON.parse(text))
        if (!parsed.audioUrl) throw new Error(`TTS 未返回音频地址：${text.slice(0, 200)}`)
        if (!isAllowedAudioUrl(parsed.audioUrl)) throw new Error(`音频地址不在白名单：${parsed.audioUrl.slice(0, 80)}`)
        const audio = await fetch(parsed.audioUrl, { signal: AbortSignal.timeout(120_000) })
        if (!audio.ok) throw new Error(`音频下载失败 HTTP ${audio.status}`)
        const buf = Buffer.from(await audio.arrayBuffer())
        if (!buf.length) throw new Error('音频内容为空')
        const file = `tts_${Date.now()}.${/\.wav(\?|$)/i.test(parsed.audioUrl) ? 'wav' : 'mp3'}`
        await fsp.mkdir(input.videoDir, { recursive: true })
        await fsp.writeFile(path.join(input.videoDir, file), buf)
        audioRel = `videos/${file}`
        audioAbs = path.join(input.videoDir, file)
        ttsJob = registry.put({ ...markDone(ttsJob, audioRel), cost_cny: 0.002 })
        charges.push({ jobId: ttsJob.id, kind: 'tts', cny: 0.002 })
        input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_paid', detail: `配音 ¥0.002（${script.narration.length} 字）`, request_id: ttsJob.request_id })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ttsJob = registry.put(markFailed(ttsJob, msg))
        input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_job_failed', detail: `配音失败：${msg}` })
        return { ok: false, code: 'TTS_FAILED', reason: `配音失败：${msg}`, estimate: gate.estimate, jobs, script, imagePaths, spentCny: charges.reduce((s, c) => s + c.cny, 0), charges, msg: '已停止合成（不留半成品）' }
      }
    }
  }
  jobs.push(ttsJob)

  // ── 5) 合成（本地 ffmpeg，不花钱）：音频时长驱动镜头时长 ──
  const composeJobKey = { planId: input.planId, stageId: input.stageId, workItemId: 'compose' }
  let composeJob = registry.ensure({ ...composeJobKey, kind: 'compose', paid: false })
  if (!allow('compose')) {
    jobs.push(composeJob)
    return { ok: true, estimate: gate.estimate, jobs, script, imagePaths, audioPath: audioRel, spentCny: charges.reduce((s, c) => s + c.cny, 0), charges, msg: '按指定范围执行完毕（未合成）' }
  }
  composeJob = registry.put(markRunning(composeJob))
  progress(composeJob.id, 0.85, 'ffmpeg 合成成片')
  try {
    const absImages = imagePaths.map((rel) => path.join(input.imageDir, path.basename(rel)))
    let secondsPerShot = shotSeconds
    if (audioAbs && fs.existsSync(audioAbs)) {
      try {
        const { stdout } = await execFileAsync('ffprobe', buildProbeArgs(audioAbs), { timeout: 30_000 })
        const audioSeconds = parseProbeDuration(stdout)
        secondsPerShot = distributeByAudio(audioSeconds, absImages.length, shotSeconds)
      } catch {
        // 探测失败就按默认镜头时长，不阻塞成片
      }
    }
    await fsp.mkdir(input.tmpDir, { recursive: true })
    const listFile = path.join(input.tmpDir, `concat_${composeJob.id.replace(/[^\w.-]/g, '_')}.txt`)
    await fsp.writeFile(listFile, buildConcatList(absImages, secondsPerShot), 'utf8')
    const outFile = `film_${Date.now()}.mp4`
    const outAbs = path.join(input.videoDir, outFile)
    const args = buildComposeArgs({ images: absImages, audio: audioAbs, outPath: outAbs, secondsPerShot, ratio, resolution }, { listFile })
    await execFileAsync('ffmpeg', args, { timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024 })
    const st = await fsp.stat(outAbs)
    if (!st.size) throw new Error('合成产物为空')
    composeJob = registry.put(markDone(composeJob, `videos/${outFile}`))
    jobs[jobs.length - 1] = composeJob
    progress(composeJob.id, 1, '成片完成')
    input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_compose', detail: `成片 videos/${outFile}（${absImages.length} 镜头，每镜头 ${secondsPerShot}s，${(st.size / 1024).toFixed(0)}KB）` })
    return {
      ok: true,
      estimate: gate.estimate,
      jobs,
      script,
      imagePaths,
      audioPath: audioRel,
      finalRelPath: `videos/${outFile}`,
      finalAbsPath: outAbs,
      spentCny: charges.reduce((s, c) => s + c.cny, 0),
      charges,
      msg: `成片完成：${absImages.length} 镜头，预估 ¥${gate.estimate.expectCny.toFixed(2)}`
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    composeJob = registry.put(markFailed(composeJob, msg))
    jobs[jobs.length - 1] = composeJob
    input.audit?.({ plan_id: input.planId, stage_id: input.stageId, event: 'video_job_failed', detail: `合成失败：${msg}` })
    return { ok: false, code: 'COMPOSE_FAILED', reason: `合成失败：${msg}`, estimate: gate.estimate, jobs, script, imagePaths, audioPath: audioRel, spentCny: charges.reduce((s, c) => s + c.cny, 0), charges, msg: '成片未产出（不留半成品）' }
  }
}

/** 续跑：只重跑 failed/running（含 running 先对账由调用方决定 onlyWorkItems） */
