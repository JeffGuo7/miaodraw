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

/** 内置供应商模板（协议固定：bailian=CLI；其余 OpenAI 兼容）。模型条目可被用户配置扩展 */
export const PROVIDERS: ProviderDef[] = [
  {
    id: 'bailian',
    label: '阿里云百炼',
    note: 'bl CLI 直连 · 文生图 + 改图全支持',
    i2i: true,
    models: [
      { model: 'qwen-image-3.0-pro', label: 'Qwen-Image 3.0 Pro 旗舰', price: '¥0.27' },
      { model: 'wan2.7-image', label: 'Wan 2.7 Image', price: '¥0.2' },
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

/** 合并内置模板与用户配置，产出全部可用模型（供下拉/默认值/设置页使用） */
export function resolveModels(cfg: ModelConfig | undefined): ResolvedModel[] {
  const out: ResolvedModel[] = []
  for (const p of PROVIDERS) {
    for (const m of p.models) {
      out.push({ provider: p.id, model: m.model, label: m.label, price: m.price, caps: [p.id === 'bailian' && m.model.startsWith('qwen3-vl') ? 'vision' : m.model.startsWith('qwen3.8') ? 'text' : 'image'], i2i: p.i2i, custom: false })
    }
    for (const m of cfg?.extraModels?.[p.id] ?? []) {
      out.push({ provider: p.id, model: m.id, label: m.name || m.id, price: '按量', caps: m.caps, i2i: m.caps.includes('image') && p.i2i, custom: true })
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
