import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { App as AntdApp, Button, InputNumber, Select, Space, Typography } from 'antd'
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
  const { message } = AntdApp.useApp()
  // 成本护栏：图片/改图/Agent 共用一份累计预算（主进程 fail-closed，超预算直接拒绝发起付费请求）
  const [budget, setBudget] = useState<number>(20)
  const [spent, setSpent] = useState<number>(0)
  const [saving, setSaving] = useState(false)

  const loadBudget = (): void => {
    void window.api
      .getSettings()
      .then((s) => {
        const raw = s as Record<string, unknown>
        const b = Number(raw.imageBudget)
        const sp = Number(raw.imageSpentCny)
        setBudget(Number.isFinite(b) && b > 0 ? b : 20)
        setSpent(Number.isFinite(sp) && sp >= 0 ? sp : 0)
      })
      .catch(() => undefined)
  }

  useEffect(loadBudget, [])

  const saveBudget = async (value: number): Promise<void> => {
    setSaving(true)
    try {
      await window.api.setSettings({ imageBudget: String(value) } as never)
      setBudget(value)
      message.success(`图片预算已设为 ¥${value}（保存即生效）`)
      loadBudget()
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const resetSpent = async (): Promise<void> => {
    try {
      await window.api.setSettings({ imageSpentCny: '0' } as never)
      setSpent(0)
      message.success('已用额度已归零（不影响账单，仅重置本地计数）')
      loadBudget()
    } catch (e) {
      message.error(`重置失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <>
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

      <div className="sec">
        <SectionHead
          title="成本护栏"
          desc="图片 / 改图 / Agent 共用一份累计预算。超预算时主进程直接拒绝发起付费请求（fail-closed），不会静默扣费。"
        />
        <div className="card-block">
          <div className="stat">
            <span className="stat-label">本期已用</span>
            <span className="stat-value code">
              ¥{spent.toFixed(2)} / ¥{budget.toFixed(2)}
            </span>
          </div>
          <Space style={{ marginTop: 12 }} wrap>
            <InputNumber
              min={1}
              max={10000}
              step={10}
              value={budget}
              addonBefore="¥"
              onChange={(v) => setBudget(typeof v === 'number' ? v : 20)}
            />
            <Button type="primary" loading={saving} onClick={() => void saveBudget(budget)}>
              保存预算
            </Button>
            <Button onClick={() => void resetSpent()}>重置已用</Button>
          </Space>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            价目以百炼账单为准（仅 z-image-turbo / wan2.7-image 已核对）；默认 ¥20，用于防止误操作导致的大额扣费。
          </Typography.Text>
        </div>
      </div>
    </>
  )
}
