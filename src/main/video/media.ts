/**
 * 配音与合成（V1 `tts.ts` + `compose.ts`）的**纯构造层**：请求体 / 响应解析 / ffmpeg 参数，零 IO 可单测。
 *
 * 事实依据（团队实测）：
 * - 百炼 TTS：POST {base}/services/aigc/multimodal-generation/generation，model `qwen3-tts-flash`，声线 Cherry
 * - 本机 ffmpeg 9.0.2 在 PATH（`Gyan.FFmpeg` 包）；compose 用 concat demuxer + 音频混流
 */
import { DEFAULT_SHOT_SECONDS } from './script.ts'

// ── TTS ──

export const TTS_MODEL = 'qwen3-tts-flash'
export const TTS_DEFAULT_VOICE = 'Cherry'

export interface TtsRequest {
  model: string
  input: { text: string; voice: string }
}

/** 百炼 TTS 请求体（同步返回音频 URL） */
export function buildTtsBody(text: string, voice = TTS_DEFAULT_VOICE): TtsRequest {
  return { model: TTS_MODEL, input: { text: String(text ?? '').trim(), voice } }
}

/**
 * 百炼 TTS 端点。**实测（2026-10-15）**：工作区 MaaS 域（llm-xxx.cn-beijing.maas.aliyuncs.com）
 * 对该接口返回 400 空体；同一把 key 打官方域 200 正常出音频 → TTS 固定走官方域，可用环境变量覆盖。
 */
export const TTS_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'

export function buildTtsUrl(baseUrl?: string): string {
  const base = String(baseUrl || process.env.MIAODRAW_TTS_BASE_URL || TTS_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const withApi = base.endsWith('/api/v1') ? base : `${base}/api/v1`
  return `${withApi}/services/aigc/multimodal-generation/generation`
}

/** TTS 返回的音频地址实测为 http://dashscope-result-*.oss-*.aliyuncs.com；只放行阿里云产物域（https 或 http 均可） */
export function isAllowedAudioUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw ?? ''))
    const host = u.hostname.toLowerCase()
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    return ['aliyuncs.com', 'aliyuncs.com.cn', 'aliyun.com', 'alibaba.com', 'alicdn.com'].some((s) => host === s || host.endsWith(`.${s}`))
  } catch {
    return false
  }
}

/** 从响应里取音频 URL（容忍多种字段形态；取不到返回空串由调用方报错） */
export function parseTtsResponse(json: unknown): { audioUrl: string; requestId: string } {
  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  const output = root.output && typeof root.output === 'object' ? (root.output as Record<string, unknown>) : {}
  const audio = output.audio && typeof output.audio === 'object' ? (output.audio as Record<string, unknown>) : {}
  const choices = Array.isArray(output.choices) ? (output.choices as unknown[]) : []
  const msg = choices.length ? ((choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined) : undefined
  const content = Array.isArray(msg?.content) ? (msg?.content as unknown[]) : []
  const firstAudio = content.map((c) => (c as Record<string, unknown>).audio).find((a) => typeof a === 'string')
  const url = String(audio.url ?? output.audio_url ?? firstAudio ?? '').trim()
  return { audioUrl: url, requestId: String(root.request_id ?? '') }
}

/** 口播时长估算（无音频时用；中文 3.5 字/秒，音频真时长以 ffprobe 为准） */
export function estimateSpeechSeconds(text: string): number {
  const chars = String(text ?? '').replace(/\s/g, '').length
  return Math.max(1, Math.round((chars / 3.5) * 10) / 10)
}

// ── compose（ffmpeg） ──

export interface ComposeSpec {
  /** 每镜头图片绝对路径（顺序即镜头顺序） */
  images: string[]
  /** 配音文件绝对路径（可缺省 = 静音成片） */
  audio?: string
  outPath: string
  /** 每镜头时长（秒）；缺省用音频时长/镜头数均分 */
  secondsPerShot?: number
  fps?: number
  /** 9:16 → 1080x1920；16:9 → 1920x1080 */
  ratio?: string
  resolution?: string
}

export function dimensions(ratio = '9:16', resolution = '720P'): { w: number; h: number } {
  const long = String(resolution).toUpperCase() === '1080P' ? 1920 : 1280
  const short = String(resolution).toUpperCase() === '1080P' ? 1080 : 720
  return ratio === '16:9' ? { w: long, h: short } : ratio === '1:1' ? { w: short, h: short } : { w: short, h: long }
}

/**
 * 生成 ffmpeg 参数：图片序列（每张停 secondsPerShot 秒）→ 视频轨 + AAC 音轨 → mp4。
 * 用 concat demuxer 写临时清单（避免命令行过长），此处只产出参数，文件写入由调用方做。
 */
export function buildComposeArgs(spec: ComposeSpec, args: { listFile: string }): string[] {
  const { w, h } = dimensions(spec.ratio, spec.resolution)
  const fps = Math.max(1, Math.round(spec.fps ?? 30))
  const out = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', args.listFile
  ]
  if (spec.audio) out.push('-i', spec.audio)
  out.push(
    // 画面统一到目标尺寸+时长，音频对齐后混流
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-movflags', '+faststart'
  )
  if (spec.audio) out.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
  else out.push('-an')
  out.push(spec.outPath)
  return out
}

/** concat 清单内容：`file '<abs>'` + `duration <sec>`（最后一张要重复一次才是 ffmpeg 的正确语义） */
export function buildConcatList(images: string[], secondsPerShot = DEFAULT_SHOT_SECONDS): string {
  const lines: string[] = []
  for (const img of images) {
    lines.push(`file '${String(img).replace(/'/g, "'\\''")}'`)
    lines.push(`duration ${Math.max(0.1, Number(secondsPerShot) || DEFAULT_SHOT_SECONDS)}`)
  }
  if (images.length) lines.push(`file '${String(images[images.length - 1]).replace(/'/g, "'\\''")}'`)
  return `${lines.join('\n')}\n`
}

/** ffprobe 取时长（秒）：参数 + 输出解析都在这里，便于单测 */
export function buildProbeArgs(file: string): string[] {
  return ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]
}

export function parseProbeDuration(stdout: string): number {
  const n = Number(String(stdout ?? '').trim().split(/\s+/)[0])
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
}

/** 按音频时长把镜头时长均分（音频驱动视频时长，设计稿 §三③） */
export function distributeByAudio(audioSeconds: number, shotCount: number, fallback = DEFAULT_SHOT_SECONDS): number {
  const n = Math.max(1, Math.round(shotCount) || 1)
  const total = Number(audioSeconds) || 0
  if (total <= 0) return fallback
  return Math.max(1, Math.round((total / n) * 100) / 100)
}
