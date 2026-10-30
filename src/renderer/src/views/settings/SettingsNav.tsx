import type { JSX } from 'react'
import { InfoCircleOutlined, PictureOutlined, SettingOutlined } from '@ant-design/icons'
import type { SectionKey } from './shared'

interface NavItem {
  key: SectionKey
  label: string
  icon: JSX.Element
}

/** 设置分区（5 → 3）：百炼密钥与服务状态合进「模型服务」，数据与关于合进「关于与数据」 */
const ITEMS: NavItem[] = [
  { key: 'services', label: '模型服务', icon: <SettingOutlined /> },
  { key: 'defaults', label: '默认模型', icon: <PictureOutlined /> },
  { key: 'about', label: '关于与数据', icon: <InfoCircleOutlined /> }
]

export default function SettingsNav({
  active,
  onChange
}: {
  active: SectionKey
  onChange: (k: SectionKey) => void
}): JSX.Element {
  return (
    <nav className="settings-nav">
      <div className="sn-title">设置</div>
      {ITEMS.map((it) => (
        <div
          key={it.key}
          className={`sn-item${active === it.key ? ' active' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => onChange(it.key)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onChange(it.key)
          }}
        >
          <span className="sn-icon">{it.icon}</span>
          <span className="sn-label">{it.label}</span>
        </div>
      ))}
    </nav>
  )
}
