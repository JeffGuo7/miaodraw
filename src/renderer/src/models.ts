import type { ModelCap, ModelConfig, ModelDefaults } from './types'

export interface ModelDef {
  model: string
  label: string
  price: string
}

export interface ProviderDef {
  id: string
  label: string
  note: string
  i2i: boolean
  models: ModelDef[]
}

/** 内置供应商模板（协议统一：全部纯 HTTP 直连；bailian 另支持 DashScope 原生生图/改图）。模型条目可被用户配置扩展 */
export const PROVIDERS: ProviderDef[] = [
  {
    id: 'bailian',
    label: '阿里云百炼',
    note: 'HTTP 直连 · 生图 / 改图 / 文本 / 视觉全覆盖',
    i2i: true,
    models: [
      { model: 'wan2.7-image', label: 'Wan 2.7 Image（推荐·已验证）', price: '¥0.2' },
      { model: 'wan2.7-image-pro', label: 'Wan 2.7 Image Pro（4K 文生图）', price: '按量' },
      { model: 'qwen3.8-flash', label: 'Qwen3.8 Flash（文本·Agent 规划）', price: '按量' },
      { model: 'qwen3-vl-plus', label: 'Qwen3-VL Plus（视觉·反推）', price: '按量' }
    ]
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    note: '需 API Key · 仅文生图',
    i2i: false,
    models: [
      { model: 'Kwai-Kolors/Kolors', label: 'Kolors 可图', price: '¥0.14' },
      { model: 'Kwai-Kolors/Kolors-Turbo', label: 'Kolors 加速版', price: '¥0.05' },
      { model: 'black-forest-labs/FLUX.1-schnell', label: 'FLUX.1 schnell', price: '≈¥0.01' }
    ]
  },
  {
    id: 'openai',
    label: 'OpenAI',
    note: '需 API Key · 仅文生图',
    i2i: false,
    models: [{ model: 'gpt-image-1', label: 'GPT Image 1', price: '$0.04' }]
  }
]

export const MODELS_LEGACY: Record<string, boolean> = {
  'qwen-image-3.0': true,
  'qwen-image-3.0-pro': true,
  'z-image-turbo': true,
  'wanx2.0-t2i-turbo': true
}

/** 解析后的可用模型：内置模板 + 用户追加 + 自定义供应商（启用的） */
export interface ResolvedModel {
  provider: string
  model: string
  label: string
  price: string
  caps: ModelCap[]
  i2i: boolean
  custom: boolean
}

/** 默认值键："provider::model" */
export const modelKey = (provider: string, model: string): string => `${provider}::${model}`
export const parseModelKey = (key: string): { provider: string; model: string } | null => {
  const [p, m] = key.split('::')
  return p && m ? { provider: p, model: m } : null
}

/** 自动拉取目录的噪音过滤（与主进程 http.ts 同规则）：与创作无关的模型不进下拉 */
const NOISE_RE = /(asr|tts|embedding|rerank|realtime|livetranslate|-s2s|ocr|omni|deep-research|deep-search|qvq|qwen-vl-ocr|qwen-audio|qwen-mt|gui-|for-status|auto-handle)/i

/** 按模型 ID 推断能力标签：vl→视觉，image/wan/z-image/flux 等→生图，其余→文本 */
function deriveCaps(id: string): ModelCap[] {
  if (/vl|vision/i.test(id)) return ['vision', 'text']
  if (/image|wan\d|z-image|flux|kolors|dall|stable|sd3|diffusion/i.test(id)) return ['image']
  return ['text']
}

/** 合并内置模板与用户配置，产出全部可用模型（供下拉/默认值/设置页使用） */
export function resolveModels(cfg: ModelConfig | undefined): ResolvedModel[] {
  const out: ResolvedModel[] = []
  const seen = new Set<string>()
  for (const p of PROVIDERS) {
    for (const m of p.models) {
      seen.add(modelKey(p.id, m.model))
      out.push({ provider: p.id, model: m.model, label: m.label, price: m.price, caps: [p.id === 'bailian' && m.model.startsWith('qwen3-vl') ? 'vision' : m.model.startsWith('qwen3.8') ? 'text' : 'image'], i2i: p.i2i, custom: false })
    }
    for (const m of cfg?.extraModels?.[p.id] ?? []) {
      seen.add(modelKey(p.id, m.id))
      out.push({ provider: p.id, model: m.id, label: m.name || m.id, price: '按量', caps: m.caps, i2i: m.caps.includes('image') && p.i2i, custom: true })
    }
    // 服务端 /models 自动拉取的目录（Cherry Studio 式自动发现），去重后并入
    for (const id of cfg?.fetchedModels?.[p.id] ?? []) {
      if (seen.has(modelKey(p.id, id)) || NOISE_RE.test(id)) continue
      seen.add(modelKey(p.id, id))
      const caps = deriveCaps(id)
      out.push({ provider: p.id, model: id, label: id, price: '按量', caps, i2i: caps.includes('image') && p.i2i, custom: false })
    }
  }
  for (const c of cfg?.customProviders ?? []) {
    if (!c.enabled) continue
    for (const m of c.models) {
      out.push({ provider: c.id, model: m.id, label: `${c.name} · ${m.name || m.id}`, price: '按量', caps: m.caps, i2i: m.caps.includes('image'), custom: true })
    }
  }
  return out
}

/** 按能力过滤 */
export const byCap = (models: ResolvedModel[], cap: ModelCap): ResolvedModel[] => models.filter((m) => m.caps.includes(cap))

/** 能力默认值解析：用户配置优先，未配置回退该能力第一个内置模型 */
export function resolveDefaults(cfg: ModelConfig | undefined, models: ResolvedModel[]): { image: ResolvedModel; text: ResolvedModel; vision: ResolvedModel } {
  const pick = (kind: keyof ModelDefaults): ResolvedModel => {
    const key = cfg?.defaults?.[kind]
    if (key) {
      const hit = models.find((m) => modelKey(m.provider, m.model) === key)
      if (hit) return hit
    }
    return byCap(models, kind === 'image' ? 'image' : kind)[0] ?? byCap(models, 'image')[0] ?? models[0]
  }
  return { image: pick('image'), text: pick('text'), vision: pick('vision') }
}

export function providerLabel(id: string, cfg?: ModelConfig): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? cfg?.customProviders?.find((c) => c.id === id)?.name ?? id
}

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export interface ActiveModel {
  provider: string
  model: string
}
