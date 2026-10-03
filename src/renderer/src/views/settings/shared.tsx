import type { JSX } from 'react'
import type { ModelCap } from '../../types'

/** 设置页二级分区 */
export type SectionKey = 'services' | 'defaults' | 'status' | 'data' | 'about'

/** 模型条目来源：内置模板 / 用户追加 / 服务端拉取 / 自定义供应商自带 */
export type ModelSource = 'builtin' | 'extra' | 'fetched' | 'custom'

export interface UiModel {
  id: string
  name: string
  caps: ModelCap[]
  source: ModelSource
  /** 仅用户追加 / 拉取的模型可删；内置模板为锁定态 */
  deletable: boolean
}

export interface UiProvider {
  id: string
  kind: 'builtin' | 'custom'
  name: string
  note: string
  baseUrl: string
  /** 百炼（写入现有 bailianWsSet）与自定义供应商可编辑；其余为内置固定端点 */
  baseUrlEditable: boolean
  /** 地址有未保存修改（用于就地「保存」入口） */
  baseUrlDirty: boolean
  enabled: boolean
  configured: boolean
  masked: string
  plainFallback: boolean
  models: UiModel[]
}

export const CAP_META: Record<ModelCap, { label: string; cls: string }> = {
  image: { label: '生图', cls: 'cap-image' },
  text: { label: '文本', cls: 'cap-text' },
  vision: { label: '视觉', cls: 'cap-vision' }
}

export const CAP_ORDER: ModelCap[] = ['image', 'text', 'vision']

/** 密钥获取地址（新窗口打开，主进程已限制为 http(s) 外链） */
export const KEY_URLS: Record<string, string> = {
  bailian: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key',
  siliconflow: 'https://cloud.siliconflow.cn/account/ak',
  openai: 'https://platform.openai.com/api-keys'
}

/** 内置模板模型的能力（与 models.ts resolveModels 的判定保持一致，仅用于展示） */
export function builtinCaps(providerId: string, modelId: string): ModelCap[] {
  if (providerId === 'bailian' && modelId.startsWith('qwen3-vl')) return ['vision', 'text']
  if (modelId.startsWith('qwen3.8')) return ['text']
  return ['image']
}

/** 服务端拉取目录的能力推断（展示用兜底；供应商启用时以 models.ts resolveModels 为准） */
export function guessCaps(id: string): ModelCap[] {
  if (/vl|vision/i.test(id)) return ['vision', 'text']
  if (/image|wan\d|z-image|flux|kolors|dall|stable|sd3|diffusion/i.test(id)) return ['image']
  return ['text']
}

export function CapPills({ caps }: { caps: ModelCap[] }): JSX.Element {
  return (
    <span className="cap-pills">
      {CAP_ORDER.filter((c) => caps.includes(c)).map((c) => (
        <span key={c} className={`cap-pill ${CAP_META[c].cls}`}>
          {CAP_META[c].label}
        </span>
      ))}
    </span>
  )
}

const AVATAR_TONES = ['a', 'b', 'c', 'd', 'e', 'f']

/** 首字母圆形图标（Cherry 的 logo 位；妙绘无内置图源，用品牌色首字母代替） */
export function ProviderAvatar({ id, name, size = 32 }: { id: string; name: string; size?: number }): JSX.Element {
  let h = 7
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 9973
  const tone = AVATAR_TONES[h % AVATAR_TONES.length]
  const letter = (name || '?').trim().slice(0, 1).toUpperCase()
  return (
    <span
      className={`pv-avatar tone-${tone}`}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.44)) }}
    >
      {letter}
    </span>
  )
}

/** 设置页分区标题（默认模型 / 服务状态 / 数据与目录 / 关于共用） */
export function SectionHead({ title, desc }: { title: string; desc: string }): JSX.Element {
  return (
    <div className="sec-head">
      <h2 className="sec-title">{title}</h2>
      <p className="sec-desc">{desc}</p>
    </div>
  )
}
