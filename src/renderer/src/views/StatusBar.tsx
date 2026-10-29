import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { FolderOpenOutlined, SearchOutlined } from '@ant-design/icons'
import { providerLabel } from '../models'

/**
 * 底部状态栏：模型/服务状态 + 快捷入口 + 版本。
 * 健康状态由 App 统一轮询后传入（此前 App 头部与这里各轮询一次 /health，每分钟两次 IPC）。
 */
export default function StatusBar({
  onOpenPalette,
  version,
  health
}: {
  onOpenPalette: () => void
  version: string
  health: { ok: boolean; version: string } | null
}): JSX.Element {
  const [active, setActive] = useState<{ provider: string; model: string } | null>(null)

  useEffect(() => {
    function refresh(): void {
      void window.api
        .getSettings()
        .then((s) => setActive((s.activeModel as { provider: string; model: string }) ?? null))
        .catch(() => undefined)
    }
    refresh()
    window.addEventListener('active-model-changed', refresh)
    return () => window.removeEventListener('active-model-changed', refresh)
  }, [])

  return (
    <div className="statusbar">
      <span className={health?.ok ? 'sb-dot sb-dot-ok' : 'sb-dot sb-dot-bad'} />
      <span className="sb-text">{health ? (health.ok ? '服务在线' : '服务未连接') : '检测服务…'}</span>
      <span className="sb-sep" />
      <span className="sb-text">
        当前模型：{active ? `${providerLabel(active.provider)} · ${active.model}` : '默认'}
      </span>
      <div className="toolbar-spacer" />
      <Tooltip title="全局搜索（Ctrl + K）">
        <Button type="text" size="small" className="sb-btn" icon={<SearchOutlined />} onClick={onOpenPalette}>
          搜索
        </Button>
      </Tooltip>
      <Tooltip title="打开作品目录">
        <Button type="text" size="small" className="sb-btn" icon={<FolderOpenOutlined />} onClick={() => void window.api.openPath('outputs')}>
          作品
        </Button>
      </Tooltip>
      <span className="sb-sep" />
      <span className="sb-text">v{version || '0.1.0'}</span>
    </div>
  )
}

export function touchActiveModel(): void {
  window.dispatchEvent(new CustomEvent('active-model-changed'))
}
