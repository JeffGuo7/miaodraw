import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from './logger'
import { vendorCardFor } from './prompt-guards'
import { makeImageFileName, sniffImageExt } from './image-file'
import { checkRemoteUrl } from './net-guard'

/**
 * HTTP 直连层（Cherry Studio 式架构：API Key + Base URL + 模型，纯 HTTP，无外部进程依赖）。
 *
 * 两类协议：
 * 1. OpenAI 兼容（/chat/completions、/models）：文本对话（Agent 规划）、视觉理解（提示词反推）、
 *    连通检查、模型目录自动拉取。百炼官方工作空间专属域名原生支持该协议。
 * 2. DashScope 原生（/api/v1/services/aigc/multimodal-generation/generation）：
 *    百炼生图/改图，同步一次请求直接返回图片 URL（wan2.7-image 系列）。
 */

/** 下载模型/供应商返回的图片前的安全校验：只允许 https 公网地址（阿里云产物域允许 http） */
function assertSafeImageUrl(raw: string): void {
  const guard = checkRemoteUrl(raw, { allowHttpAliyun: true })
  if (!guard.ok) {
    log('warn', `reject unsafe image url: ${guard.reason}`)
    throw new Error(`拒绝下载不安全的图片地址（${guard.reason}）`)
  }
}

export const DASHSCOPE_ORIGIN = 'https://dashscope.aliyuncs.com'

/** 用户填写的接入点归一化为源（origin）：兼容裸域名、/api/v1、/compatible-mode/v1 三种填法 */
export function originOf(base: string): string {
  const b = (base || '').trim()
  if (!b) return DASHSCOPE_ORIGIN
  try {
    return new URL(b).origin
  } catch {
    return DASHSCOPE_ORIGIN
  }
}

export const compatBase = (origin: string): string => `${origin.replace(/\/+$/, '')}/compatible-mode/v1`
export const dashBaseOf = (origin: string): string => `${origin.replace(/\/+$/, '')}/api/v1`

// ---------- 取消注册表：runId → AbortController ----------
const aborts = new Map<string, AbortController>()
const userCancelled = new WeakSet<AbortController>()

export function cancelHttp(runId: string): boolean {
  const c = aborts.get(runId)
  if (!c) return false
  userCancelled.add(c)
  c.abort()
  return true
}

export function cancelAllHttp(): void {
  for (const c of aborts.values()) {
    userCancelled.add(c)
    c.abort()
  }
  aborts.clear()
}

// ---------- 生图并发闸：防止并发任务互相挤兑 ----------
const MAX_IMAGE_CONCURRENT = 2
let imgActive = 0
const imgWaiters: Array<() => void> = []

async function acquireImageSlot(): Promise<void> {
  if (imgActive < MAX_IMAGE_CONCURRENT) {
    imgActive++
    return
  }
  await new Promise<void>((resolve) => imgWaiters.push(resolve))
  imgActive++
}

function releaseImageSlot(): void {
  imgActive = Math.max(0, imgActive - 1)
  const next = imgWaiters.shift()
  if (next) next()
}

// ---------- 底层请求 ----------
interface JsonResp {
  status: number
  json: Record<string, unknown>
}

/** 带超时与取消的 JSON POST；runId 注册进取消表，gen:cancel 可中断 */
async function postJson(url: string, body: unknown, apiKey: string, timeoutMs: number, runId?: string): Promise<JsonResp> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  if (runId) aborts.set(runId, ac)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    })
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>
    return { status: r.status, json }
  } catch (e) {
    if (ac.signal.aborted) {
      throw new Error(userCancelled.has(ac) ? '已取消本次任务' : `请求超时（${Math.round(timeoutMs / 1000)}s）`, { cause: e })
    }
    throw new Error(`网络请求失败：${e instanceof Error ? e.message : String(e)}`, { cause: e })
  } finally {
    clearTimeout(timer)
    if (runId) aborts.delete(runId)
  }
}

async function getJson(url: string, apiKey: string, timeoutMs: number): Promise<JsonResp> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ac.signal })
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>
    return { status: r.status, json }
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`, { cause: e })
    throw new Error(`网络请求失败：${e instanceof Error ? e.message : String(e)}`, { cause: e })
  } finally {
    clearTimeout(timer)
  }
}

function dataUri(name: string, data: ArrayBuffer): string {
  const ext = (path.extname(name) || '.png').toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${Buffer.from(data).toString('base64')}`
}

// ---------- OpenAI 兼容 chat（文本 + 视觉） ----------
export interface HttpChatOpts {
  apiBase: string
  apiKey: string
  model: string
  system?: string
  message: string
  temperature?: number
  /** 视觉输入：本地图片转 base64 data URI */
  images?: Array<{ name: string; data: ArrayBuffer }>
  timeoutMs?: number
  runId?: string
  /** 百炼 qwen3.5+ 默认开启思考模式，非流式规划必须显式关闭；其他网关不需要传 */
  disableThinking?: boolean
}

/** 返回模型输出的纯文本内容；失败抛出服务端错误信息 */
export async function httpChat(o: HttpChatOpts): Promise<string> {
  const base = o.apiBase.replace(/\/+$/, '')
  const hasImages = !!o.images?.length
  const content: unknown = hasImages
    ? [
        ...(o.images ?? []).map((img) => ({ type: 'image_url', image_url: { url: dataUri(img.name, img.data) } })),
        { type: 'text', text: o.message }
      ]
    : o.message
  const messages: Array<Record<string, unknown>> = []
  if (o.system) messages.push({ role: 'system', content: o.system })
  messages.push({ role: 'user', content })
  const body: Record<string, unknown> = { model: o.model, messages, temperature: o.temperature ?? 0.7 }
  if (o.disableThinking) body.enable_thinking = false
  const { status, json } = await postJson(`${base}/chat/completions`, body, o.apiKey, o.timeoutMs ?? 180000, o.runId)
  const err = json['error'] as { message?: string } | undefined
  if (status < 200 || status >= 300 || err) {
    throw new Error(err?.message || (json['message'] as string) || `HTTP ${status}`)
  }
  const choices = json['choices'] as Array<{ message?: { content?: unknown } }> | undefined
  const raw = choices?.[0]?.message?.content
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  // 部分网关把 content 拆成多段
  if (Array.isArray(raw)) {
    const text = raw
      .map((p) => (typeof p === 'object' && p !== null && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('')
      .trim()
    if (text) return text
  }
  throw new Error('模型没有返回文本内容')
}

// ---------- 模型目录自动拉取（GET /models） ----------
/** 返回服务端模型 ID 列表（排序去重）；用于设置页「拉取模型列表」与连通检查 */
export async function httpModels(apiBase: string, apiKey: string, timeoutMs = 15000): Promise<string[]> {
  const base = apiBase.replace(/\/+$/, '')
  const { status, json } = await getJson(`${base}/models`, apiKey, timeoutMs)
  const err = json['error'] as { message?: string } | undefined
  if (status < 200 || status >= 300 || err) {
    throw new Error(err?.message || (json['message'] as string) || `HTTP ${status}`)
  }
  const data = json['data'] as Array<{ id?: string }> | undefined
  const ids = (data ?? []).map((m) => String(m.id ?? '')).filter(Boolean)
  ids.sort()
  return [...new Set(ids)]
}

// 模型目录噪音过滤与能力推断的唯一真源在 src/shared/model-caps.ts（渲染层共用）
export { MODEL_NOISE_RE, deriveCaps } from '../shared/model-caps'

// ---------- 多素材融合：素材类型与模型能力注册表 ----------
/** 素材角色：告诉模型"这张图是干什么的"（可空则仅按序号引用） */
export type RefRole = 'subject' | 'style' | 'background' | 'pose' | 'outfit' | 'sketch' | 'ref'

export interface RefImage {
  name: string
  data: ArrayBuffer
  role?: RefRole
  source?: string
}

export type ImageProtocol = 'dashscope-multimodal' | 'openai-images'

export interface ImageCapability {
  protocol: ImageProtocol
  /** 参考图上限（官方文档：wan2.7=9 张，qwen-image-3.x=3 张） */
  maxRefs: number
}

/** 生图模型能力注册表（与渲染层 models.ts 的 refLimit 保持同规则，改一处要同步另一处） */
export function imageCapability(model: string): ImageCapability {
  const m = (model || '').toLowerCase()
  // 参考图上限统一取厂商卡（P0 提示词质量层），避免两处硬编码漂移
  const cap = vendorCardFor(m)?.maxRefs ?? 1
  if (m.startsWith('wan2.')) return { protocol: 'dashscope-multimodal', maxRefs: cap }
  if (m.startsWith('qwen-image-3')) return { protocol: 'openai-images', maxRefs: cap }
  if (m.startsWith('qwen-image')) return { protocol: 'dashscope-multimodal', maxRefs: cap }
  if (m.startsWith('doubao-seedream')) return { protocol: 'openai-images', maxRefs: cap }
  if (m.startsWith('gpt-image')) return { protocol: 'openai-images', maxRefs: cap }
  return { protocol: 'dashscope-multimodal', maxRefs: cap }
}

/** 超出模型上限时截断，并给出可读提示 */
export function clampRefs<T>(refs: T[] | undefined, model: string): { refs: T[]; dropped: number } {
  const list = refs ?? []
  const cap = imageCapability(model).maxRefs
  if (list.length <= cap) return { refs: list, dropped: 0 }
  return { refs: list.slice(0, cap), dropped: list.length - cap }
}

// ---------- 百炼生图 / 改图（DashScope 原生 · 同步） ----------
export interface HttpImageOpts {
  /** 百炼源：工作空间专属域名（https://{ws}.cn-beijing.maas.aliyuncs.com）或官方默认 */
  origin: string
  apiKey: string
  model: string
  prompt: string
  negative?: string
  w: number
  h: number
  seed?: number
  /** 融合素材：数组顺序即"图1/图2/图3"，wan2.7 系列最多 9 张 */
  refs?: RefImage[]
  /** 出图张数（wan2.7 组图模式为最大张数，1-12；普通模式 1-4） */
  n?: number
  /** 组图模式（wan2.7 enable_sequential）：一次产出同角色的连续画面 */
  sequential?: boolean
  runId?: string
  onProgress?: (stage: string, detail?: string) => void
}

export interface HttpImageResult {
  /** 第一张（兼容单图调用方） */
  buffer: Buffer
  remoteUrl: string
  /** 全部产物（组图/多图输出时长度 > 1） */
  buffers: Buffer[]
  remoteUrls: string[]
  actualSize?: string
}

/** wan2.7 系列总像素下限 768*768、上限 2048*2048；越界时按比例收敛，避免小尺寸直接报错 */
function clampSize(w: number, h: number): { w: number; h: number } {
  const min = 589824
  const max = 4194304
  let a = Math.max(1, Math.round(w))
  let b = Math.max(1, Math.round(h))
  const total = a * b
  if (total < min) {
    const f = Math.sqrt(min / total)
    a = Math.round(a * f)
    b = Math.round(b * f)
  } else if (total > max) {
    const f = Math.sqrt(max / total)
    a = Math.round(a * f)
    b = Math.round(b * f)
  }  return { w: a, h: b }
}

/** 百炼 wan2.7-image 系列文生图/改图：同步接口一次返回图片 URL，无任务轮询 */
export async function httpBailianImage(o: HttpImageOpts): Promise<HttpImageResult> {
  await acquireImageSlot()
  try {
    const t0 = Date.now()
    const size = clampSize(o.w, o.h)
    const w = size.w
    const h = size.h
    const content: Array<Record<string, string>> = []
    const refs = o.refs ?? []
    if (refs.length) {
      o.onProgress?.('upload', refs.length > 1 ? `上传 ${refs.length} 张素材` : '上传参考图')
      // 顺序即"图1/图2/图3"，与提示词里的引用一一对应
      for (const r of refs) content.push({ image: dataUri(r.name, r.data) })
    }
    // wan2.7 无独立负向参数：以指令式合并进提示词
    const text = o.negative?.trim() ? `${o.prompt}。画面中不要出现：${o.negative.trim()}` : o.prompt
    content.push({ text })
    const body = {
      model: o.model,
      input: { messages: [{ role: 'user', content }] },
      parameters: {
        size: `${w}*${h}`,
        n: o.n && o.n > 0 ? o.n : 1,
        watermark: false,
        ...(o.sequential ? { enable_sequential: true } : {}),
        ...(o.seed && o.seed > 0 ? { seed: o.seed } : {})
      }
    }
    o.onProgress?.('infer', '服务商推理中')
    const { status, json } = await postJson(
      `${dashBaseOf(o.origin)}/services/aigc/multimodal-generation/generation`,
      body,
      o.apiKey,
      620000,
      o.runId
    )
    const code = json['code'] as string | undefined
    const msg = json['message'] as string | undefined
    if (status < 200 || status >= 300 || code) {
      throw new Error(msg ? `${code ? code + '：' : ''}${msg}` : `HTTP ${status}`)
    }
    const output = json['output'] as
      | { choices?: Array<{ message?: { content?: Array<{ type?: string; image?: string; text?: string }> } }> }
      | undefined
    const parts = output?.choices?.[0]?.message?.content ?? []
    // 兼容两种返回形态：wan 系带 type:'image'，z-image-turbo 只给 {image:url}（无 type）
    const imageUrls = parts.filter((p) => p.image).map((p) => String(p.image))
    if (!imageUrls.length) {
      const t = parts.find((p) => p.text)?.text
      throw new Error(t ? `模型未返回图片：${t.slice(0, 200)}` : '服务商未返回图片')
    }
    o.onProgress?.('save', imageUrls.length > 1 ? `下载 ${imageUrls.length} 张结果` : '下载生成结果')
    const buffers: Buffer[] = []
    for (const u of imageUrls) {
      assertSafeImageUrl(u)
      const resp = await fetch(u)
      if (!resp.ok) throw new Error(`下载生成结果失败：HTTP ${resp.status}`)
      buffers.push(Buffer.from(await resp.arrayBuffer()))
    }
    const usage = json['usage'] as { size?: string } | undefined
    log(
      'info',
      `httpBailianImage model=${o.model} ${w}x${h} n=${imageUrls.length} sequential=${!!o.sequential} in ${Date.now() - t0}ms bytes=${buffers.reduce((s, b) => s + b.length, 0)}`
    )
    return { buffer: buffers[0], remoteUrl: imageUrls[0], buffers, remoteUrls: imageUrls, actualSize: usage?.size }
  } finally {
    releaseImageSlot()
  }
}

// ---------- OpenAI 兼容同步生图（百炼 qwen-image-3.x / 硅基流动 / 自定义网关） ----------
export interface HttpOpenAIImageOpts {
  /** OpenAI 兼容根：百炼为 {origin}/compatible-mode/v1，其他供应商为自带 baseUrl */
  apiBase: string
  apiKey: string
  model: string
  prompt: string
  negative?: string
  /** 融合素材：image 字段传数组（百炼 qwen-image-3.x 支持 1-3 张） */
  refs?: RefImage[]
  w: number
  h: number
  n?: number
  seed?: number
  runId?: string
  onProgress?: (stage: string, detail?: string) => void
}

/** OpenAI 兼容同步生图：参数平铺在顶层，`image` 传数组即多素材融合（官方不支持 /images/edits multipart） */
export async function httpOpenAIImages(o: HttpOpenAIImageOpts): Promise<HttpImageResult> {
  await acquireImageSlot()
  try {
    const t0 = Date.now()
    const base = o.apiBase.replace(/\/+$/, '')
    if (!base) throw new Error('缺少 API 地址')
    const refs = o.refs ?? []
    const body: Record<string, unknown> = {
      model: o.model,
      prompt: o.prompt,
      // OpenAI 协议用字母 x 作分隔符（DashScope 原生协议用星号）
      size: `${Math.round(o.w)}x${Math.round(o.h)}`,
      n: o.n && o.n > 0 ? o.n : 1,
      watermark: false
    }
    if (refs.length) {
      body.image = refs.length === 1 ? dataUri(refs[0].name, refs[0].data) : refs.map((r) => dataUri(r.name, r.data))
    }
    if (o.negative?.trim()) body.negative_prompt = o.negative.trim()
    if (o.seed && o.seed > 0) body.seed = o.seed
    o.onProgress?.(refs.length ? 'upload' : 'infer', refs.length ? `上传 ${refs.length} 张素材` : '服务商推理中')
    const { status, json } = await postJson(`${base}/images/generations`, body, o.apiKey, 620000, o.runId)
    const err = json['error'] as { message?: string } | undefined
    const code = json['code'] as string | undefined
    const msg = json['message'] as string | undefined
    if (status < 200 || status >= 300 || err || code) {
      throw new Error(err?.message || msg || `HTTP ${status}`)
    }
    const data = json['data'] as Array<{ url?: string; b64_json?: string }> | undefined
    if (!data?.length) throw new Error('服务商未返回图片')
    const buffers: Buffer[] = []
    const remoteUrls: string[] = []
    for (const item of data) {
      if (item.b64_json) {
        buffers.push(Buffer.from(item.b64_json, 'base64'))
        remoteUrls.push(item.url ?? '')
      } else if (item.url) {
        o.onProgress?.('save', data.length > 1 ? `下载 ${data.length} 张结果` : '下载生成结果')
        assertSafeImageUrl(item.url)
        const resp = await fetch(item.url)
        if (!resp.ok) throw new Error(`下载生成结果失败：HTTP ${resp.status}`)
        buffers.push(Buffer.from(await resp.arrayBuffer()))
        remoteUrls.push(item.url)
      }
    }
    if (!buffers.length) throw new Error('服务商未返回图片')
    log(
      'info',
      `httpOpenAIImages model=${o.model} ${o.w}x${o.h} refs=${refs.length} n=${buffers.length} in ${Date.now() - t0}ms bytes=${buffers.reduce((s, b) => s + b.length, 0)}`
    )
    return { buffer: buffers[0], remoteUrl: remoteUrls[0] ?? '', buffers, remoteUrls }
  } finally {
    releaseImageSlot()
  }
}

// ---------- DashScope 异步任务（图像编辑/擦除等 image2image 能力） ----------
export type WanxEditFn =
  | 'description_edit'
  | 'description_edit_with_mask'
  | 'remove_watermark'
  | 'expand'
  | 'super_resolution'
  | 'colorization'
  | 'doodle'
  | 'stylization_all'
  | 'stylization_local'

export interface DashEditOpts {
  origin: string
  apiKey: string
  /** wanx2.1-imageedit（通用图像编辑）或 image-erase-completion（擦除补全） */
  model: string
  input: Record<string, unknown>
  parameters?: Record<string, unknown>
  runId?: string
  onProgress?: (stage: string, detail?: string) => void
  timeoutMs?: number
}

/**
 * DashScope 异步任务：提交（X-DashScope-Async: enable）→ 轮询 /tasks/{id} → 取回结果图。
 * 图像编辑类接口均为异步，与生图（同步）不同，必须走这条链路。
 */
async function dashEditTask(o: DashEditOpts): Promise<HttpImageResult> {
  const ac = new AbortController()
  const cancelled = { v: false }
  if (o.runId) aborts.set(o.runId, ac)
  const t0 = Date.now()
  const timeoutMs = o.timeoutMs ?? 300000
  try {
    o.onProgress?.('submit', '提交任务')
    const sub = await fetch(`${dashBaseOf(o.origin)}/services/aigc/image2image/image-synthesis`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${o.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      },
      body: JSON.stringify({ model: o.model, input: o.input, parameters: o.parameters ?? {} }),
      signal: ac.signal
    })
    const subJson = (await sub.json().catch(() => ({}))) as Record<string, unknown>
    const subOut = subJson['output'] as { task_id?: string; task_status?: string } | undefined
    if (sub.status < 200 || sub.status >= 300 || subJson['code'] || !subOut?.task_id) {
      const msg = (subJson['message'] as string) || (subJson['code'] as string) || `HTTP ${sub.status}`
      throw new Error(String(msg))
    }
    const taskId = subOut.task_id
    log('info', `dashEditTask submit model=${o.model} task=${taskId}`)
    // 轮询：4s 一次，直到 SUCCEEDED / FAILED / 超时 / 取消
    for (;;) {
      if (ac.signal.aborted) {
        cancelled.v = true
        throw new Error('已取消本次任务')
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`图像编辑任务超时（${Math.round(timeoutMs / 1000)}s）`)
      await new Promise((r) => setTimeout(r, 4000))
      if (ac.signal.aborted) {
        cancelled.v = true
        throw new Error('已取消本次任务')
      }
      const st = await fetch(`${dashBaseOf(o.origin)}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${o.apiKey}` },
        signal: ac.signal
      })
      const stJson = (await st.json().catch(() => ({}))) as Record<string, unknown>
      const out = stJson['output'] as
        | { task_status?: string; code?: string; message?: string; results?: Array<{ url?: string }>; output_image_url?: string }
        | undefined
      const status = out?.task_status
      if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
        throw new Error(`${out?.code ?? status}：${out?.message ?? '任务失败'}`)
      }
      if (status === 'SUCCEEDED') {
        const urls = (out?.results ?? []).map((r) => r.url).filter((u): u is string => !!u)
        if (!urls.length && out?.output_image_url) urls.push(out.output_image_url)
        if (!urls.length) throw new Error('任务成功但没有返回图片')
        o.onProgress?.('save', '下载编辑结果')
        const buffers: Buffer[] = []
        for (const u of urls) {
          assertSafeImageUrl(u)
          const resp = await fetch(u)
          if (!resp.ok) throw new Error(`下载结果失败：HTTP ${resp.status}`)
          buffers.push(Buffer.from(await resp.arrayBuffer()))
        }
        log('info', `dashEditTask done model=${o.model} task=${taskId} in ${Date.now() - t0}ms n=${buffers.length}`)
        return { buffer: buffers[0], remoteUrl: urls[0], buffers, remoteUrls: urls }
      }
      o.onProgress?.('running', status === 'PENDING' ? '排队中' : '模型处理中')
    }
  } catch (e) {
    if (cancelled.v) throw new Error('已取消本次任务', { cause: e })
    throw e
  } finally {
    if (o.runId) aborts.delete(o.runId)
  }
}

export interface WanxEditOpts {
  origin: string
  apiKey: string
  fn: WanxEditFn
  /** 底图（本地字节，自动转 base64 data URI） */
  image: { name: string; data: ArrayBuffer }
  /** 涂抹蒙版：非 0 区域为编辑区域（局部重绘/擦除用） */
  mask?: { name: string; data: ArrayBuffer }
  /** 提示词：官方要求所有 function 都必填，编辑类语义都靠它 */
  prompt: string
  /** super_resolution：1~4（1 = 仅高清不放大） */
  upscaleFactor?: number
  /** expand：四向扩展比例 1.0~2.0 */
  expandScales?: { top?: number; bottom?: number; left?: number; right?: number }
  runId?: string
  onProgress?: (stage: string, detail?: string) => void
}

/** 万相通用图像编辑（wanx2.1-imageedit）：局部重绘 / 去水印 / 扩图 / 超分 / 上色 / 线稿生图 */
export async function httpWanxEdit(o: WanxEditOpts): Promise<HttpImageResult> {
  const input: Record<string, unknown> = {
    function: o.fn,
    prompt: o.prompt,
    base_image_url: dataUri(o.image.name, o.image.data)
  }
  if (o.mask) input.mask_image_url = dataUri(o.mask.name, o.mask.data)
  const parameters: Record<string, unknown> = { watermark: false, n: 1 }
  if (o.fn === 'super_resolution') parameters.upscale_factor = Math.min(4, Math.max(1, Math.round(o.upscaleFactor ?? 2)))
  if (o.fn === 'expand' && o.expandScales) {
    parameters.top_scale = o.expandScales.top ?? 1
    parameters.bottom_scale = o.expandScales.bottom ?? 1
    parameters.left_scale = o.expandScales.left ?? 1
    parameters.right_scale = o.expandScales.right ?? 1
  }
  return dashEditTask({ origin: o.origin, apiKey: o.apiKey, model: 'wanx2.1-imageedit', input, parameters, runId: o.runId, onProgress: o.onProgress })
}

export interface EraseOpts {
  origin: string
  apiKey: string
  image: { name: string; data: ArrayBuffer }
  /** 擦除蒙版：涂抹区域（非 0 值）会被抹除并补全背景 */
  mask: { name: string; data: ArrayBuffer }
  runId?: string
  onProgress?: (stage: string, detail?: string) => void
}

/** 图像擦除补全（image-erase-completion）：抹掉物体/水印并补全背景，无需提示词 */
export async function httpEraseCompletion(o: EraseOpts): Promise<HttpImageResult> {
  return dashEditTask({
    origin: o.origin,
    apiKey: o.apiKey,
    model: 'image-erase-completion',
    input: {
      image_url: dataUri(o.image.name, o.image.data),
      mask_url: dataUri(o.mask.name, o.mask.data)
    },
    // 涂抹产生的 mask：官方建议 dilate_flag=false；add_watermark 必须显式关掉（默认 true）
    parameters: { dilate_flag: false, fast_mode: false, add_watermark: false },
    runId: o.runId,
    onProgress: o.onProgress
  })
}

// ---------- 产物落盘（文件 + 参数 sidecar，历史页可复现） ----------
/** sidecar 里的素材条目：hash 指向 userData/refs/<hash>，复现时不依赖原文件是否还在 */
export interface SidecarRef {
  order: number
  role?: string
  hash?: string
  name?: string
  source?: string
}

export interface PersistMeta {
  prompt: string
  negative?: string
  w: number
  h: number
  seed: number
  model: string
  provider?: string
  parent?: string
  refs?: SidecarRef[]
}

function sidecarBody(meta: PersistMeta): string {
  return JSON.stringify(
    {
      prompt: meta.prompt,
      negative: meta.negative || undefined,
      w: meta.w,
      h: meta.h,
      seed: meta.seed,
      model: meta.model,
      provider: meta.provider || undefined,
      parent: meta.parent || undefined,
      refs: meta.refs?.length ? meta.refs : undefined,
      createdAt: new Date().toISOString()
    },
    null,
    2
  )
}

/** 仅写参数 sidecar（图片文件已由调用方落盘时使用） */
export async function writeImageSidecar(outputsDir: string, file: string, meta: PersistMeta): Promise<void> {
  await fsp.writeFile(path.join(outputsDir, `${file}.json`), sidecarBody(meta))
}

let persistSeq = 0


export async function persistImage(buffer: Buffer, outputsDir: string, meta: PersistMeta): Promise<{ file: string; url: string }> {
  await fsp.mkdir(outputsDir, { recursive: true })
  const t = Date.now()
  // 组图（wan2.7 支持一次 12 张）会在同一毫秒内连续落盘：
  // 只用时间戳命名会让后面的图覆盖前面的（静默丢图），必须带序号。
  persistSeq += 1
  const file = makeImageFileName(t, persistSeq, sniffImageExt(buffer))
  const abs = path.join(outputsDir, file)
  await fsp.writeFile(abs, buffer)
  await writeImageSidecar(outputsDir, file, meta)
  return { file, url: `media://local/out/${encodeURIComponent(file)}` }
}

// ---------- 供应商连接描述（调用方解析设置后传入，本模块不读设置） ----------
export interface ModelConn {
  provider: string
  model: string
  /** bailian：生图走 DashScope 原生协议、chat 走 compatible-mode；openai：全部走 OpenAI 兼容 */
  kind: 'bailian' | 'openai'
  /** bailian 源（工作空间专属域名或官方默认） */
  origin?: string
  /** OpenAI 兼容根地址（custom provider baseUrl 或内置表） */
  apiBase?: string
  apiKey: string
}