import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { FolderOpenOutlined, SearchOutlined } from '@ant-design/icons'
import { providerLabel } from '../models'
import { healthLabel, healthState } from './health-state'

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

  // 统一状态机（顶栏/状态栏/设置页共用）：未配置 / 已配置 / 在线 / 连接失败。
  // 只配第三方时不能显示"连接失败"——那是百炼的探测结果，与他无关。
  const state = healthState(health)
  const dotClass =
    state === 'ok'
      ? 'sb-dot sb-dot-ok'
      : state === 'bad'
        ? 'sb-dot sb-dot-bad'
        : state === 'ready'
          ? 'sb-dot sb-dot-ready'
          : 'sb-dot'
  const dotTitle =
    state === 'ok'
      ? '模型服务在线'
      : state === 'bad'
        ? '已配置百炼密钥但连不上，点顶栏可重试'
        : state === 'ready'
          ? '已配置第三方服务商（百炼未配置，不影响使用）'
          : state === 'idle'
            ? '还没配置模型密钥（设置 → 模型服务）'
            : '检测中…'

  return (
    <div className="statusbar">
      <Tooltip title={dotTitle}>
        <span className={dotClass} data-sb-state={state} />
      </Tooltip>
      <span className="sb-muted">{healthLabel(state)}</span>
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
