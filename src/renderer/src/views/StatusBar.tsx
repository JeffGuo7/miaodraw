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
  health: { ok: boolean; version: string; hasKey?: boolean; hasAnyKey?: boolean } | null
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

  // 三态：未配置 ≠ 故障。首屏直接亮红点会让新用户以为软件坏了。
  const configured = !!(health?.hasAnyKey ?? health?.hasKey)
  const state: 'ok' | 'bad' | 'idle' | 'unknown' = !health ? 'unknown' : health.ok ? 'ok' : configured ? 'bad' : 'idle'
  const dotClass = state === 'ok' ? 'sb-dot sb-dot-ok' : state === 'bad' ? 'sb-dot sb-dot-bad' : 'sb-dot'
  const dotTitle =
    state === 'ok' ? '模型服务在线' : state === 'bad' ? '已配置密钥但连不上，点顶栏可重试' : state === 'idle' ? '还没配置模型服务（设置 → 模型服务）' : '检测中…'

  return (
    <div className="statusbar">
      <Tooltip title={dotTitle}>
        <span className={dotClass} data-sb-state={state} />
      </Tooltip>
      <span className="sb-muted">{state === 'ok' ? '在线' : state === 'bad' ? '连接失败' : state === 'idle' ? '未配置' : '检测中'}</span>
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
