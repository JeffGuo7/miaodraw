import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Alert, App as AntdApp, Button, Input, Progress, Space, Typography } from 'antd'
import { CloudDownloadOutlined, FolderOpenOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons'
import type { HealthInfo, UpdateInfo, UpdateProgress } from '../../types'
import { SectionHead } from './shared'

interface AppInfoShape {
  version: string
  name: string
  libraryRoot: string
  outputsDir: string
}

export function DataSection({
  info,
  onOpen
}: {
  info: AppInfoShape | null
  onOpen: (kind: string) => void
}): JSX.Element {
  return (
    <div className="sec">
      <SectionHead title="数据与目录" desc="作品与案例库都保存在本机，不会上传云端；可随时打开目录自行备份。" />
      <div className="card-block">
        <div className="stat">
          <span className="stat-label">作品目录</span>
          <span className="stat-value">
            <Typography.Text copyable style={{ fontSize: 13 }}>
              {info?.outputsDir || '—'}
            </Typography.Text>
          </span>
        </div>
        <div className="stat" style={{ marginTop: 16 }}>
          <span className="stat-label">案例库</span>
          <span className="stat-value">
            <Typography.Text copyable style={{ fontSize: 13 }}>
              {info?.libraryRoot || '—'}
            </Typography.Text>
          </span>
        </div>
        <Space style={{ marginTop: 18 }}>
          <Button icon={<FolderOpenOutlined />} onClick={() => onOpen('outputs')}>
            打开作品目录
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => onOpen('library')}>
            打开案例库
          </Button>
        </Space>
      </div>
    </div>
  )
}

export function AboutSection({
  info,
  health,
  onRecheck
}: {
  info: AppInfoShape | null
  health: HealthInfo | null
  onRecheck: () => Promise<void>
}): JSX.Element {
  const { message } = AntdApp.useApp()
  const [checking, setChecking] = useState(false)
  const [upd, setUpd] = useState<UpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [file, setFile] = useState('')
  const [feed, setFeed] = useState('')
  const [feedOpen, setFeedOpen] = useState(false)

  useEffect(() => window.api.onUpdateProgress((p) => setProgress(p)), [])
  useEffect(() => {
    void window.api
      .getSettings()
      .then((s) => setFeed(String((s as { updateFeed?: string }).updateFeed ?? '')))
      .catch(() => undefined)
  }, [])

  async function check(): Promise<void> {
    setChecking(true)
    setUpd(null)
    setFile('')
    setProgress(null)
    try {
      const r = await window.api.updateCheck()
      setUpd(r)
      if (!r.ok) message.warning(r.out || '检查更新失败')
      else if (r.hasUpdate) message.success(`发现新版本 v${r.latest}`)
      else message.success(`已是最新版本 v${r.current}`)
    } finally {
      setChecking(false)
    }
  }

  async function download(): Promise<void> {
    if (!upd?.assetUrl || !upd.assetName) return
    setBusy(true)
    setProgress({ stage: 'download', percent: 0 })
    try {
      const r = await window.api.updateDownload({ url: upd.assetUrl, name: upd.assetName, size: upd.assetSize })
      if (r.ok && r.file) {
        setFile(r.file)
        message.success('下载完成，点「立即安装」启动安装向导')
      } else {
        message.error(r.out || '下载失败')
      }
    } finally {
      setBusy(false)
    }
  }

  async function saveFeed(): Promise<void> {
    await window.api.setSettings({ updateFeed: feed.trim() } as never)
    message.success(feed.trim() ? '已保存自定义更新源' : '已恢复使用 GitHub Releases')
    setFeedOpen(false)
    setUpd(null)
  }

  return (
    <div className="sec">
      <SectionHead title="关于" desc="妙绘工作台 · AI 图像创作客户端" />
      <div className="card-block">
        <div className="about-name">妙绘工作台</div>
        <div className="about-ver">v{info?.version ?? '…'}</div>
        <Typography.Paragraph className="about-desc">
          多服务商模型 · 阿里云百炼 / 硅基流动 / OpenAI · 纯 HTTP 直连引擎
          <br />
          Electron + React + Ant Design · 视觉参考：Cherry Studio / Toonflow
        </Typography.Paragraph>
        <div className="stat" style={{ marginTop: 4 }}>
          <span className="stat-label">当前接入点</span>
          <span className="stat-value code">{health?.entry || '—'}</span>
        </div>
        <Button icon={<ReloadOutlined />} style={{ marginTop: 16 }} onClick={() => void onRecheck()}>
          重新检测
        </Button>
      </div>

      <div className="card-block" style={{ marginTop: 12 }}>
        <div className="stat">
          <span className="stat-label">版本更新</span>
          <span className="stat-value">
            {!upd ? '未检查' : !upd.ok ? '检查失败' : upd.hasUpdate ? `发现新版本 v${upd.latest}` : `已是最新 v${upd.current}`}
          </span>
        </div>
        {progress?.stage === 'download' && (
          <div style={{ marginTop: 10 }}>
            <Progress percent={progress.percent ?? 0} size="small" status="active" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {progress.received ? `${(progress.received / 1048576).toFixed(1)} MB` : ''}
              {progress.total ? ` / ${(progress.total / 1048576).toFixed(1)} MB` : ''}
            </Typography.Text>
          </div>
        )}
        {upd?.notes && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }} ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}>
            {upd.notes}
          </Typography.Paragraph>
        )}
        {upd && !upd.ok && <Alert type="warning" showIcon message={upd.out} style={{ marginTop: 10 }} />}
        <Space style={{ marginTop: 12 }} wrap>
          <Button icon={<CloudDownloadOutlined />} loading={checking} onClick={() => void check()}>
            检查更新
          </Button>
          {upd?.hasUpdate && !file && (
            <Button type="primary" loading={busy} onClick={() => void download()}>
              下载 v{upd.latest}
            </Button>
          )}
          {busy && <Button onClick={() => void window.api.updateCancel()}>取消下载</Button>}
          {file && (
            <Button type="primary" onClick={() => void window.api.updateInstall(file).then((r) => (r.ok ? message.info('安装向导已启动，完成后重启妙绘') : message.error(r.out || '启动失败')))}>
              立即安装
            </Button>
          )}
          <Button type="text" icon={<LinkOutlined />} onClick={() => setFeedOpen((v) => !v)}>
            更新源
          </Button>
        </Space>
        {feedOpen && (
          <Space.Compact style={{ width: '100%', marginTop: 10 }}>
            <Input
              value={feed}
              onChange={(e) => setFeed(e.target.value)}
              placeholder="自定义更新源 JSON 地址（留空 = GitHub Releases）"
            />
            <Button type="primary" onClick={() => void saveFeed()}>
              保存
            </Button>
          </Space.Compact>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          更新源：{upd?.source === 'feed' || feed.trim() ? '自定义 JSON 源' : 'GitHub Releases'} · 安装包会下载到本机再启动安装向导，不会静默改动系统
        </Typography.Text>
      </div>
    </div>
  )
}
