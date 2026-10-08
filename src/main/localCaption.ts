import { app } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { log } from './logger'

/**
 * 本地反推（离线、免费、图片不出本机）
 *
 * 选型经过实测（transformers.js v4.3.0）：
 *  - Florence-2 ❌ Unsupported model type: florence2
 *  - SmolVLM-256M ❌ image-to-text 推理报错（该版本无 image-text-to-text 管线）
 *  - moondream2 ❌ Unsupported model type: moondream1
 *  - vit-gpt2 ✅ 可用（约 250MB，q8 量化，秒级），但只出**简短英文描述**
 * 因此设计为「本地看 + 云端写」：本地模型负责离线出描述，主进程再用文本模型（qwen3.8-flash）
 * 把它改写成中文生图提示词（几百 token 成本）。没配文本模型时直接返回英文原描述。
 */

const HF_HOST = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
const MODEL_ID = process.env.CAPTION_MODEL || 'Xenova/vit-gpt2-image-captioning'
/** 量化档位（transformers.js 的 dtype 联合类型，可用环境变量覆盖） */
const DTYPE = (process.env.CAPTION_DTYPE || 'q8') as 'q8' | 'fp32' | 'fp16' | 'int8' | 'uint8' | 'q4'

export interface CaptionProgress {
  stage: 'download' | 'infer'
  file?: string
  percent?: number
}

/* 与 segment.ts 一致：transformers.js 的类型在动态导入下不便精确标注 */
/* eslint-disable @typescript-eslint/no-explicit-any */
let capPromise: Promise<any> | null = null

async function getCaptioner(onProgress?: (p: CaptionProgress) => void): Promise<any> {
  if (!capPromise) {
    capPromise = (async () => {
      const tf = await import('@huggingface/transformers')
      tf.env.cacheDir = path.join(app.getPath('userData'), 'models')
      tf.env.remoteHost = HF_HOST
      tf.env.allowLocalModels = false
      return await tf.pipeline('image-to-text', MODEL_ID, {
        dtype: DTYPE,
        progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
          if (p?.status === 'progress') {
            onProgress?.({ stage: 'download', file: p.file, percent: typeof p.progress === 'number' ? Math.round(p.progress) : undefined })
          }
        }
      })
    })()
    // 首次失败后清空缓存允许重试（断网/镜像抖动不至于让功能永久不可用）
    capPromise.catch(() => {
      capPromise = null
    })
  }
  return capPromise
}

function extractText(out: unknown): string {
  if (Array.isArray(out)) {
    const first = out[0] as { generated_text?: string } | undefined
    if (first?.generated_text) return first.generated_text.trim()
  }
  if (typeof out === 'object' && out !== null && 'generated_text' in out) {
    return String((out as { generated_text?: string }).generated_text || '').trim()
  }
  return ''
}

/** 本地反推：返回英文描述（调用方按需再改写成中文提示词） */
export async function localCaption(
  data: ArrayBuffer,
  name: string,
  onProgress?: (p: CaptionProgress) => void
): Promise<{ text: string; elapsed: number; model: string }> {
  const t0 = Date.now()
  const cap = await getCaptioner(onProgress)
  const ext = (path.extname(name) || '.png').toLowerCase()
  const tmp = path.join(app.getPath('temp'), `caption-${t0}${ext}`)
  await fsp.writeFile(tmp, Buffer.from(data))
  try {
    onProgress?.({ stage: 'infer' })
    const out = await cap(tmp, { max_new_tokens: 64 })
    const text = extractText(out)
    if (!text) throw new Error('本地模型没有返回描述（可尝试重试或改用在线反推）')
    log('info', `localCaption ok model=${MODEL_ID} in ${Date.now() - t0}ms`)
    return { text, elapsed: Date.now() - t0, model: MODEL_ID }
  } finally {
    fsp.unlink(tmp).catch(() => {})
  }
}

/** 预下载模型（让用户先看到进度，再点反推） */
export async function prefetchCaptionModel(onProgress?: (p: CaptionProgress) => void): Promise<{ ok: boolean; model: string; out?: string }> {
  try {
    await getCaptioner(onProgress)
    return { ok: true, model: MODEL_ID }
  } catch (e) {
    return { ok: false, model: MODEL_ID, out: e instanceof Error ? e.message : String(e) }
  }
}

export function captionModelId(): string {
  return MODEL_ID
}
