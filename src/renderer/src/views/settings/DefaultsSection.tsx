import type { JSX } from 'react'
import { Select, Typography } from 'antd'
import type { ModelCap, ModelConfig } from '../../types'
import { byCap, modelKey, providerLabel, resolveModels } from '../../models'
import { CAP_META, ProviderAvatar, SectionHead } from './shared'

const CARDS: Array<{ kind: ModelCap; hint: string }> = [
  { kind: 'image', hint: '创作页与 Agent 出图使用' },
  { kind: 'text', hint: 'AI 助手规划指令时使用' },
  { kind: 'vision', hint: '提示词反推 / 图片理解使用' }
]

export default function DefaultsSection({
  mc,
  onSetDefault
}: {
  mc: ModelConfig
  onSetDefault: (kind: ModelCap, key: string) => void
}): JSX.Element {
  const catalog = resolveModels(mc)
  const defaultsNow = mc.defaults ?? {}

  return (
    <div className="sec">
      <SectionHead
        title="默认模型"
        desc="按能力各选一个默认模型；创作页、AI 助手与反推会自动使用，也可以在对应页面临时切换。"
      />
      <div className="cap-grid">
        {CARDS.map(({ kind, hint }) => {
          const list = byCap(catalog, kind)
          const cur = defaultsNow[kind]
          const hit = list.find((m) => modelKey(m.provider, m.model) === cur) ?? list[0]
          const value = hit ? modelKey(hit.provider, hit.model) : undefined
          return (
            <div key={kind} className="cap-card">
              <span className={`cap-pill ${CAP_META[kind].cls}`}>{CAP_META[kind].label}</span>
              <div className="cap-card-model">{hit ? hit.label : '暂无可用模型'}</div>
              <div className="cap-card-provider">
                {hit ? (
                  <>
                    <ProviderAvatar id={hit.provider} name={providerLabel(hit.provider, mc)} size={18} />
                    <span>{providerLabel(hit.provider, mc)}</span>
                    <span className="cap-card-price">{hit.price}</span>
                  </>
                ) : (
                  <span>请在「模型服务」里添加模型</span>
                )}
              </div>
              <Select
                className="fill-select"
                style={{ width: '100%', marginTop: 14 }}
                value={value}
                placeholder="选择模型"
                options={list.map((m) => ({
                  value: modelKey(m.provider, m.model),
                  label: `${m.label} · ${providerLabel(m.provider, mc)}`
                }))}
                onChange={(v) => onSetDefault(kind, String(v))}
              />
              <Typography.Text className="cap-card-hint">{hint}</Typography.Text>
            </div>
          )
        })}
      </div>
    </div>
  )
}
