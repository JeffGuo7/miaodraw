export interface ModelDef {
  model: string
  label: string
  price: string
}

export interface ProviderDef {
  id: 'bailian' | 'siliconflow' | 'openai'
  label: string
  note: string
  i2i: boolean
  models: ModelDef[]
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'bailian',
    label: '阿里云百炼',
    note: 'bl CLI 直连 · 文生图 + 改图全支持',
    i2i: true,
    models: [
      { model: 'qwen-image-3.0-pro', label: 'Qwen-Image 3.0 Pro 旗舰', price: '¥0.27' },
      { model: 'wan2.7-image', label: 'Wan 2.7 Image', price: '¥0.2' }
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

export function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id
}

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export interface ActiveModel {
  provider: string
  model: string
}
