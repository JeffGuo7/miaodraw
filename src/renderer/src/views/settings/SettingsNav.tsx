import type { JSX } from 'react'
import {
  DatabaseOutlined,
  InfoCircleOutlined,
  PictureOutlined,
  SettingOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { SectionKey } from './shared'

interface NavItem {
  key: SectionKey
  label: string
  icon: JSX.Element
}

const GROUPS: Array<{ title?: string; items: NavItem[] }> = [
  {
    items: [
      { key: 'services', label: '模型服务', icon: <SettingOutlined /> },
      { key: 'defaults', label: '默认模型', icon: <PictureOutlined /> },
      { key: 'status', label: '服务状态', icon: <ThunderboltOutlined /> }
    ]
  },
  {
    title: '偏好',
    items: [
      { key: 'data', label: '数据与目录', icon: <DatabaseOutlined /> },
      { key: 'about', label: '关于', icon: <InfoCircleOutlined /> }
    ]
  }
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
      {GROUPS.map((g, gi) => (
        <div key={g.title ?? `g${gi}`}>
          {g.title && <div className="sn-group">{g.title}</div>}
          {g.items.map((it) => (
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
        </div>
      ))}
    </nav>
  )
}
