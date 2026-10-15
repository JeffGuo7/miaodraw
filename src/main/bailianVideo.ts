/**
 * 百炼视频生成（V1 第 0 期）：提交 → 轮询（退避）→ 下载（校验）→ 落盘。**零 Pixelle 依赖**。
 *
 * 安全/成本要点：
 * - 只走 DashScope 原生异步接口，URL 由 video-protocol 的纯函数构造（可单测）
 * - 下载地址必须 https + 阿里云产物域白名单；边下边数，超上限立刻中止
 * - 先写 .part，全部校验通过才 rename（fail-closed：失败删 .part，不留半成品）
 * - 落盘同时写 sidecar 记账（model/duration/预估价/taskId），供成本审计
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  VIDEO_MAX_BYTES,
  VIDEO_POLL_LIMIT_MS,
  buildVideoSubmitBody,
  buildVideoSubmitUrl,
  buildVideoTaskUrl,
  estimateVideoCost,
  mapTaskStatus,
  pollDelayMs,
  progressOf,
  validateVideoUrl,
  withinSizeCap,
  type TaskState,
  type VideoSpec
} from './video-protocol'

export interface VideoJobProgress {
  state: TaskState
  /** 0~1（任务接口不给百分比，用状态档位映射） */
  progress: number
  detail?: string
  taskId?: string
}

export interface VideoJobInput {
  spec: VideoSpec
  /** 工作空间接入点，如 https://llm-xxx.cn-beijing.maas.aliyuncs.com */
  origin: string
  apiKey: string
  /** 落盘目录（videos/） */
  outDir: string
  /** 轮询上限，默认 30 分钟（探针可调小） */
  pollLimitMs?: number
  onProgress?: (p: VideoJobProgress) => void
}

export interface VideoJobResult {
  file: string
  absPath: string
  /** 相对路径（资产索引键）：videos/<file> */
  relPath: string
  /** 渲染层可直接用的 media URL */
  url: string
  taskId: string
  model: string
  resolution: string
  ratio: string
  durationSec: number
  sizeBytes: number
  /** 提交前算出的预估价（记账用，实际以账单为准） */
  estimatedCny: number
  elapsed: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function newVideoFileName(now = Date.now()): string {
  return `video_${now}_${crypto.randomBytes(3).toString('hex')}.mp4`
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function errText(json: unknown, fallback: string): string {
  const r = asRecord(json)
  const code = String(r.code ?? asRecord(r.output).code ?? '')
  const message = String(r.message ?? asRecord(r.output).message ?? '')
  const s = `${code} ${message}`.trim()
  return s || fallback
}

/**
 * 提交 + 轮询 + 下载。失败一律抛错（调用方负责 UI 提示与失败计数）。
 */
export async function generateVideoJob(input: VideoJobInput): Promise<VideoJobResult> {
  const { spec, origin, apiKey, outDir } = input
  if (!apiKey) throw new Error('未配置百炼 API Key，请到「设置 → 模型服务」粘贴密钥并保存')
  if (!spec.prompt.trim()) throw new Error('提示词不能为空')

  const cost = estimateVideoCost(spec)
  const started = Date.now()
  const submitUrl = buildVideoSubmitUrl(origin)

  // ── 提交 ──
  const submitRes = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-DashScope-Async': 'enable',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildVideoSubmitBody(spec)),
    signal: AbortSignal.timeout(60_000)
  })
  const submitText = await submitRes.text()
  let submitJson: unknown = null
  try {
    submitJson = JSON.parse(submitText)
  } catch {
    submitJson = null
  }
  if (!submitRes.ok) throw new Error(`提交失败（HTTP ${submitRes.status}）：${errText(submitJson, submitText.slice(0, 200))}`)
  const taskId = String(asRecord(asRecord(submitJson).output).task_id ?? asRecord(submitJson).task_id ?? '')
  if (!taskId) throw new Error(`提交未返回 task_id：${submitText.slice(0, 200)}`)

  input.onProgress?.({ state: 'pending', progress: progressOf('pending'), detail: '已提交，排队中', taskId })

  // ── 轮询（限流/网络错误退避） ──
  const taskUrl = buildVideoTaskUrl(origin, taskId)
  const deadline = Date.now() + (input.pollLimitMs ?? VIDEO_POLL_LIMIT_MS)
  let attempt = 0
  let errStreak = 0
  let videoUrl = ''
  for (;;) {
    if (Date.now() > deadline) throw new Error(`生成超时（${Math.round((input.pollLimitMs ?? VIDEO_POLL_LIMIT_MS) / 60000)} 分钟）`)
    const backoff = errStreak > 0 ? Math.min(15_000, pollDelayMs(attempt) * (1 + errStreak)) : pollDelayMs(attempt)
    await sleep(backoff)
    attempt++
    let view
    try {
      const r = await fetch(taskUrl, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) })
      const t = await r.text()
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`)
      if (!r.ok) throw new Error(`查询失败（HTTP ${r.status}）：${t.slice(0, 200)}`)
      view = mapTaskStatus(JSON.parse(t))
      errStreak = 0
    } catch (e) {
      errStreak++
      if (errStreak >= 8) throw new Error(`轮询连续失败：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    input.onProgress?.({ state: view.state, progress: progressOf(view.state), detail: view.message || undefined, taskId })
    if (view.state === 'succeeded') {
      videoUrl = view.videoUrl
      if (!videoUrl) throw new Error('任务成功但未返回 video_url')
      break
    }
    if (view.state === 'failed') {
      throw new Error(`生成失败：${`${view.code} ${view.message}`.trim() || '任务返回 FAILED'}`)
    }
  }

  // ── 下载（https + 白名单 + 体积上限 + .part 原子落盘） ──
  const check = validateVideoUrl(videoUrl)
  if (!check.ok) throw new Error(`下载地址被拒绝：${check.reason}`)
  const file = newVideoFileName()
  const absPath = path.join(outDir, file)
  await fsp.mkdir(outDir, { recursive: true })
  const sizeBytes = await downloadToFile(videoUrl, absPath)

  // ── 记账 sidecar（成本审计：预估价 + 实际档位） ──
  await fsp
    .writeFile(
      `${absPath}.json`,
      JSON.stringify(
        {
          kind: 'bailian-video',
          taskId,
          model: spec.model,
          resolution: spec.resolution,
          ratio: spec.ratio,
          duration_sec: spec.duration,
          prompt_extend: spec.promptExtend,
          prompt: spec.prompt.slice(0, 500),
          estimated_cny: cost.cny,
          price_note: cost.note,
          size_bytes: sizeBytes,
          created_at: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    )
    .catch(() => undefined)

  return {
    file,
    absPath,
    relPath: `videos/${file}`,
    url: `media://local/vid/${encodeURIComponent(file)}`,
    taskId,
    model: spec.model,
    resolution: spec.resolution,
    ratio: spec.ratio,
    durationSec: spec.duration,
    sizeBytes,
    estimatedCny: cost.cny,
    elapsed: Date.now() - started
  }
}

/** 流式下载：先写 .part，成功才 rename；失败删 .part（fail-closed） */
async function downloadToFile(url: string, absPath: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (!withinSizeCap(declared)) throw new Error(`视频过大（${Math.round(declared / 1024 / 1024)}MB，上限 ${VIDEO_MAX_BYTES / 1024 / 1024}MB）`)
  if (!res.body) throw new Error('下载响应没有内容')

  const part = `${absPath}.part`
  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb): void {
      written += chunk.length
      if (written > VIDEO_MAX_BYTES) {
        cb(new Error(`视频超过体积上限（${VIDEO_MAX_BYTES / 1024 / 1024}MB），已中止下载`))
        return
      }
      cb(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), counter, fs.createWriteStream(part))
    if (written === 0) throw new Error('下载内容为空')
    await fsp.rename(part, absPath) // 校验通过才 rename
    return written
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => undefined)
    throw e
  }
}
