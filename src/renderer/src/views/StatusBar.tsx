import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Badge, Tooltip } from 'antd'
import { FolderOpenOutlined, SearchOutlined } from '@ant-design/icons'
import { providerLabel } from '../models'

export default function StatusBar({
  onOpenPalette,
  version
}: {
  onOpenPalette: () => void
  version: string
}): JSX.Element {
  const [health, setHealth] = useState<{ ok: boolean; version: string } | null>(null)
  const [active, setActive] = useState<{ provider: string; model: string } | null>(null)

  useEffect(() => {
    function refresh(): void {
      void window.api
        .health()
        .then(setHealth)
        .catch(() => undefined)
      void window.api
        .getSettings()
        .then((s) => setActive((s.activeModel as { provider: string; model: string }) ?? null))
        .catch(() => undefined)
    }
    refresh()
    const t = window.setInterval(refresh, 60000)
    window.addEventListener('active-model-changed', refresh)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('active-model-changed', refresh)
    }
  }, [])

  return (
    <div className="statusbar">
      <Badge
        status={health ? (health.ok ? 'success' : 'error') : 'default'}
        text={
          <span className="sb-text">
            {health ? (health.ok ? `百炼 CLI ${health.version}` : '引擎离线') : '检测引擎…'}
          </span>
        }
      />
      <span className="sb-sep" />
      <span className="sb-text">
        当前模型：{active ? `${providerLabel(active.provider)} · ${active.model}` : '默认'}
      </span>
      <div className="toolbar-spacer" />
      <Tooltip title="全局搜索（Ctrl + K）">
        <button className="sb-btn" onClick={onOpenPalette}>
          <SearchOutlined /> 搜索
        </button>
      </Tooltip>
      <Tooltip title="打开作品目录">
        <button className="sb-btn" onClick={() => void window.api.openPath('outputs')}>
          <FolderOpenOutlined /> 作品
        </button>
      </Tooltip>
      <span className="sb-sep" />
      <span className="sb-text">v{version || '0.1.0'}</span>
    </div>
  )
}

export function touchActiveModel(): void {
  window.dispatchEvent(new CustomEvent('active-model-changed'))
}
