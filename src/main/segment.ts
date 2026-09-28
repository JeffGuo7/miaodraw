import { nativeImage, app } from 'electron'
import fs from 'node:fs'

import path from 'node:path'

export interface SegPoint {
  x: number
  y: number
}

export interface SegMask {
  maskUrl: string // 白色像素 = 选中区域，其余透明（PNG dataURL）
  width: number
  height: number
}

const HF_HOST = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
const MODEL_ID = 'Xenova/slimsam-77-uniform'

/* eslint-disable @typescript-eslint/no-explicit-any */
let modelPromise: Promise<any> | null = null

async function getTf(): Promise<any> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const tf = await import('@huggingface/transformers')
      tf.env.cacheDir = path.join(app.getPath('userData'), 'models')
      tf.env.remoteHost = HF_HOST
      tf.env.allowLocalModels = false
      const processor = await tf.AutoProcessor.from_pretrained(MODEL_ID)
      const model = await tf.SamModel.from_pretrained(MODEL_ID)
      return { processor, model, RawImage: tf.RawImage, Tensor: tf.Tensor }
    })()
  }
  return modelPromise
}

interface SamSession {
  src: string
  inputs: any
  emb: any
  width: number
  height: number
}

let session: SamSession | null = null

function mediaToPath(absMapper: (url: string) => string | null, src: string): string | null {
  try {
    const u = new URL(src)
    if (u.protocol === 'media:') return absMapper(src)
  } catch {
    /* 非 URL */
  }
  return null
}

async function readRaw(src: string, absMapper: (url: string) => string | null): Promise<any> {
  const tf = await getTf()
  const abs = mediaToPath(absMapper, src)
  if (abs && fs.existsSync(abs)) return tf.RawImage.read(abs)
  if (src.startsWith('data:')) {
    const img = nativeImage.createFromDataURL(src)
    if (img.isEmpty()) throw new Error('图片解码失败')
    const size = img.getSize()
    const bgra = img.toBitmap()
    const rgb = new Uint8ClampedArray(size.width * size.height * 3)
    for (let i = 0; i < size.width * size.height; i++) {
      rgb[i * 3] = bgra[i * 4 + 2]
      rgb[i * 3 + 1] = bgra[i * 4 + 1]
      rgb[i * 3 + 2] = bgra[i * 4]
    }
    return new tf.RawImage(rgb, size.width, size.height, 3)
  }
  if (fs.existsSync(src)) return tf.RawImage.read(src)
  throw new Error('无法读取图片')
}

function maskToDataUrl(mask: Uint8Array, w: number, h: number): string {
  const bgra = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) {
      bgra[i * 4] = 255
      bgra[i * 4 + 1] = 255
      bgra[i * 4 + 2] = 255
      bgra[i * 4 + 3] = 255
    }
  }
  const img = nativeImage.createFromBitmap(bgra, { width: w, height: h })
  return img.toDataURL()
}

export function createSegmentService(absMapper: (url: string) => string | null): {
  mask(src: string, points: SegPoint[]): Promise<SegMask>
} {
  async function ensureSession(src: string): Promise<SamSession> {
    if (session && session.src === src) return session
    const tf = await getTf()
    const raw = await readRaw(src, absMapper)
    const inputs = await tf.processor(raw)
    const emb = await tf.model.get_image_embeddings(inputs)
    const original = (inputs as { original_sizes?: Array<[number, number]> }).original_sizes?.[0]
    session = { src, inputs, emb, width: original?.[0] ?? 0, height: original?.[1] ?? 0 }
    return session
  }

  return {
    async mask(src: string, points: SegPoint[]): Promise<SegMask> {
      const s = await ensureSession(src)
      const { processor, model, Tensor } = await getTf()
      const input_points = new Tensor(
        'float32',
        Float32Array.from(points.flatMap((p) => [p.x, p.y])),
        [1, 1, points.length, 2]
      )
      const input_labels = new Tensor(
        'int64',
        BigInt64Array.from(points.map(() => 1n)),
        [1, 1, points.length]
      )
      const outputs = await model({
        image_embeddings: s.emb.image_embeddings,
        image_positional_embeddings: s.emb.image_positional_embeddings,
        input_points,
        input_labels
      })
      const masks = (await processor.post_process_masks(
        outputs.pred_masks,
        (s.inputs as { original_sizes: unknown }).original_sizes,
        (s.inputs as { reshaped_input_sizes: unknown }).reshaped_input_sizes
      )) as Array<{ data: ArrayLike<number>; dims: number[] }>
      const t = masks[0]
      const h = t.dims[t.dims.length - 2]
      const w = t.dims[t.dims.length - 1]
      const mask = new Uint8Array(w * h)
      for (let i = 0; i < mask.length; i++) mask[i] = Number(t.data[i]) > 0 ? 255 : 0
      return { maskUrl: maskToDataUrl(mask, w, h), width: w, height: h }
    }
  }
}

export function segmentModelsDir(): string {
  return path.join(app.getPath('userData'), 'models')
}


