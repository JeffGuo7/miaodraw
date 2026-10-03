import type { JSX } from 'react'
import { Button, Space, Typography } from 'antd'
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import type { HealthInfo } from '../../types'
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
    </div>
  )
}
