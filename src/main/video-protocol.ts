/**
 * 百炼视频协议（V1：直连 DashScope，彻底不依赖 Pixelle）—— 纯函数，零 node 依赖。
 *
 * 主进程用它发请求/解析任务，渲染层用它算预估价与默认档位（同一份真源，避免两边漂移）。
 * 接口规格（Jeff 实测跑通）：
 *   POST {origin}/api/v1/services/aigc/video-generation/video-synthesis
 *   headers: Authorization: Bearer <key> / X-DashScope-Async: enable / Content-Type: application/json
 *   body: {model, input:{prompt}, parameters:{resolution, ratio, duration, prompt_extend}}
 *   GET  {origin}/api/v1/tasks/{task_id} → output.task_status + output.video_url
 */

export type VideoModel = 'wan2.7-t2v'
export type VideoResolution = '720P' | '1080P'
export type VideoRatio = '16:9' | '9:16' | '1:1'

export interface VideoSpec {
  prompt: string
  model: VideoModel
  resolution: VideoResolution
  ratio: VideoRatio
  /** 秒；红线：默认最短 2 秒 */
  duration: number
  /** 红线：默认关（省 token、少改写） */
  promptExtend: boolean
  negative?: string
}

export const VIDEO_MODEL: VideoModel = 'wan2.7-t2v'
export const VIDEO_RESOLUTIONS: VideoResolution[] = ['720P', '1080P']
export const VIDEO_RATIOS: VideoRatio[] = ['16:9', '9:16', '1:1']
/** 时长档位（秒）：默认 2 秒，最贵的 10 秒也要显式选 */
export const VIDEO_DURATIONS = [2, 3, 5, 10]
export const PROMPT_MAX_CHARS = 800

/** 红线默认档：最短时长 + 最低分辨率 + 关 prompt_extend */
export const DEFAULT_VIDEO_SPEC: Omit<VideoSpec, 'prompt'> = {
  model: VIDEO_MODEL,
  resolution: '720P',
  ratio: '16:9',
  duration: 2,
  promptExtend: false
}

/** 拉取任务状态的轮询上限（30 分钟） */
export const VIDEO_POLL_LIMIT_MS = 30 * 60 * 1000
/** 下载体积上限保护（200MB） */
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024
/** 连续失败上限：达到后停止自动重试，必须人工再点（成本护栏） */
export const MAX_AUTO_RETRY = 2
/** 单次提交硬上限（元）：预估价超过它一律拒绝提交（fail-closed，UI 与主进程都拦） */
export const VIDEO_HARD_CAP_CNY = 6

export interface VideoSpecInput {
  prompt?: unknown
  model?: unknown
  resolution?: unknown
  ratio?: unknown
  duration?: unknown
  promptExtend?: unknown
  negative?: unknown
}

/** 提示词截断：超长截断而不是报错（视频 prompt 有上限，宁可短不可被拒） */
export function truncatePrompt(text: string, max = PROMPT_MAX_CHARS): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

function pickEnum<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(String(v) as T) ? (String(v) as T) : fallback
}

function pickDuration(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VIDEO_SPEC.duration
  if (VIDEO_DURATIONS.includes(n)) return n
  // 非法档位向上取最近合法档（不许悄悄跑更长/更贵的）
  return VIDEO_DURATIONS.find((d) => d >= n) ?? VIDEO_DURATIONS[VIDEO_DURATIONS.length - 1]
}

/** 归一化：任何非法输入都回落到红线默认档，绝不放大成更贵的参数 */
export function normalizeVideoSpec(input: VideoSpecInput): VideoSpec {
  return {
    prompt: truncatePrompt(String(input?.prompt ?? '')),
    model: pickEnum(input?.model, [VIDEO_MODEL], VIDEO_MODEL),
    resolution: pickEnum(input?.resolution, VIDEO_RESOLUTIONS, DEFAULT_VIDEO_SPEC.resolution),
    ratio: pickEnum(input?.ratio, VIDEO_RATIOS, DEFAULT_VIDEO_SPEC.ratio),
    duration: pickDuration(input?.duration),
    promptExtend: input?.promptExtend === true,
    negative: input?.negative ? String(input.negative) : undefined
  }
}

export function buildVideoSubmitUrl(origin: string): string {
  return `${String(origin ?? '').replace(/\/+$/, '')}/api/v1/services/aigc/video-generation/video-synthesis`
}

export function buildVideoTaskUrl(origin: string, taskId: string): string {
  return `${String(origin ?? '').replace(/\/+$/, '')}/api/v1/tasks/${encodeURIComponent(String(taskId ?? ''))}`
}

/** 提交体（严格照实测规格；只有 prompt_extend 为 true 才带上该字段） */
export function buildVideoSubmitBody(spec: VideoSpec): Record<string, unknown> {
  return {
    model: spec.model,
    input: { prompt: spec.prompt, ...(spec.negative ? { negative_prompt: spec.negative } : {}) },
    parameters: {
      resolution: spec.resolution,
      ratio: spec.ratio,
      duration: spec.duration,
      prompt_extend: spec.promptExtend
    }
  }
}

export type TaskState = 'pending' | 'running' | 'succeeded' | 'failed'

export interface TaskView {
  state: TaskState
  taskId: string
  videoUrl: string
  code: string
  message: string
  /** 任务不存在等不可恢复错误（调用方据此立刻失败，不必轮询到超时） */
  fatal: boolean
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/**
 * 解析 GET /api/v1/tasks/{id} 返回体。
 * 成功：output.task_status=SUCCEEDED + output.video_url
 * 失败：output.task_status=FAILED（或顶层 code/message，例如 task 不存在）
 */
export function mapTaskStatus(json: unknown): TaskView {
  const root = asRecord(json)
  const output = asRecord(root.output)
  const rawStatus = String(output.task_status ?? root.task_status ?? '').toUpperCase()
  const code = String(output.code ?? root.code ?? '')
  const message = String(output.message ?? root.message ?? '')
  const videoUrl = String(output.video_url ?? '')
  const taskId = String(output.task_id ?? root.task_id ?? '')

  let state: TaskState
  if (rawStatus === 'SUCCEEDED') state = 'succeeded'
  else if (rawStatus === 'FAILED' || rawStatus === 'CANCELED' || rawStatus === 'CANCELLED' || rawStatus === 'UNKNOWN') state = 'failed'
  else if (rawStatus === 'RUNNING') state = 'running'
  else if (rawStatus === 'PENDING' || rawStatus === 'QUEUED') state = 'pending'
  else if (code) state = 'failed'
  else state = 'pending'

  // task 不存在（InvalidParameter / TaskNotFound 之类）轮询下去没意义
  const fatal = state === 'failed' && (!rawStatus || /not.?found|invalid|unauthorized|forbidden/i.test(`${code} ${message}`))
  return { state, taskId, videoUrl, code, message, fatal }
}

/** 状态 → 进度（任务接口不返回百分比，用档位映射给 UI 一个可动的进度条） */
export function progressOf(state: TaskState): number {
  if (state === 'pending') return 0.05
  if (state === 'running') return 0.6
  if (state === 'succeeded') return 1
  return 0
}

/** 轮询节奏：前 20 次 3s，之后 5s；遇限流/网络错误由调用方在此基础上退避 */
export function pollDelayMs(attempt: number): number {
  return attempt < 20 ? 3000 : 5000
}

const DOWNLOAD_HOST_SUFFIXES = ['aliyuncs.com', 'aliyuncs.com.cn', 'aliyun.com', 'alibaba.com', 'alicdn.com']

export interface UrlCheck {
  ok: boolean
  reason?: string
}

/**
 * 下载 URL 白名单校验：必须 HTTPS，且域名落在阿里云产物域（防 SSRF / 被任务返回体带偏）。
 */
export function validateVideoUrl(raw: string): UrlCheck {
  let u: URL
  try {
    u = new URL(String(raw ?? ''))
  } catch {
    return { ok: false, reason: '视频地址不是合法 URL' }
  }
  if (u.protocol !== 'https:') return { ok: false, reason: `只允许 https 下载（收到 ${u.protocol}）` }
  const host = u.hostname.toLowerCase()
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ok: false, reason: '下载域名不合法' }
  if (!DOWNLOAD_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return { ok: false, reason: `下载域名不在白名单：${host}` }
  }
  return { ok: true }
}

/** 体积上限校验（拿不到 content-length 时按 0 放行，边下边数由调用方兜底） */
export function withinSizeCap(bytes: number, cap = VIDEO_MAX_BYTES): boolean {
  return !Number.isFinite(bytes) || bytes <= 0 || bytes <= cap
}

// ── 预估价（团队实测基准：2 秒 720P ≈ ¥1.2；以账单为准） ──
const PRICE_PER_SECOND: Record<string, Record<VideoResolution, number>> = {
  'wan2.7-t2v': { '720P': 0.6, '1080P': 1.2 }
}

export interface CostEstimate {
  /** 预估价（元） */
  cny: number
  perSecond: number
  /** 价目是否已核实（false 时 UI 必须写「以账单为准」） */
  verified: boolean
  note: string
}

export function estimateVideoCost(spec: VideoSpec, capCny = VIDEO_HARD_CAP_CNY): CostEstimate & { overCap: boolean } {
  const table = PRICE_PER_SECOND[spec.model]
  const perSecond = table?.[spec.resolution] ?? 0
  const cny = Math.round(perSecond * spec.duration * 100) / 100
  const overCap = Number.isFinite(capCny) && cny > capCny
  return {
    cny,
    perSecond,
    verified: false,
    note: `预估价（实测基准：2 秒 720P ≈ ¥1.2），实际以百炼账单为准${spec.promptExtend ? '；已开 prompt_extend，可能额外计费' : ''}`,
    overCap
  }
}

// ── 成本护栏：同一节点连续失败 2 次后停止自动重试 ──
export function afterFailure(failCount: number): number {
  return Math.max(0, Math.round(Number(failCount) || 0)) + 1
}

export function canAutoRetry(failCount: number, max = MAX_AUTO_RETRY): boolean {
  return Math.max(0, Math.round(Number(failCount) || 0)) < max
}

/** 画幅 → 尺寸提示（给 UI 显示，不参与请求体） */
export function ratioLabel(ratio: VideoRatio): string {
  if (ratio === '9:16') return '竖屏 9:16'
  if (ratio === '1:1') return '方形 1:1'
  return '横屏 16:9'
}

// ── 血统边（纯函数：只对「已入库的父产物」建边，未入库的连线不算数） ──
export interface VideoLineageParent {
  assetId?: string
}

export interface VideoLineageEdge {
  child_id: string
  parent_id: string
  role: 'derived'
  input_index: null
  operation: 'bailian-video'
  metadata: string
  created_at: number
}

export function buildVideoLineage(
  childId: string,
  parents: VideoLineageParent[],
  spec: { model: string; duration: number },
  now: number
): VideoLineageEdge[] {
  const edges: VideoLineageEdge[] = []
  for (const p of parents) {
    if (!p?.assetId) continue
    edges.push({
      child_id: childId,
      parent_id: p.assetId,
      role: 'derived',
      input_index: null,
      operation: 'bailian-video',
      metadata: JSON.stringify({ source: 'bailian-video', model: spec.model, duration_sec: spec.duration }),
      created_at: now
    })
  }
  return edges
}
