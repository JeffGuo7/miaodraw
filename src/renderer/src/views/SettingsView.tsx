import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import {
  App as AntdApp,
  Badge,
  Button,
  Card,
  Descriptions,
  Input,
  Popconfirm,
  Space,
  Typography
} from 'antd'
import { DownloadOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import type { HealthInfo } from '../types'
import { PROVIDERS } from '../models'

export default function SettingsView({ visible }: { visible: boolean }): JSX.Element {
  const { message } = AntdApp.useApp()
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [info, setInfo] = useState<{ version: string; name: string; libraryRoot: string; outputsDir: string } | null>(null)
  const [updating, setUpdating] = useState(false)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)

  function refresh(): void {
    void window.api.health().then(setHealth)
    void window.api.appInfo().then(setInfo)
    void window.api
      .getSettings()
      .then((s) => {
        const providers = (s.providers ?? {}) as Record<string, { apiKey?: string }>
        setKeys({
          siliconflow: providers.siliconflow?.apiKey ?? '',
          openai: providers.openai?.apiKey ?? ''
        })
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    if (visible) refresh()
  }, [visible])

  async function saveKey(provider: string): Promise<void> {
    const s = await window.api.getSettings()
    const providers = { ...((s.providers as Record<string, { apiKey?: string }>) ?? {}) }
    providers[provider] = { apiKey: keys[provider] ?? '' }
    await window.api.setSettings({ providers })
    message.success('已保存')
  }

  async function testProvider(provider: string): Promise<void> {
    setTesting(provider)
    try {
      const r = await window.api.testProvider(provider)
      if (r.ok) message.success(r.out)
      else message.error(`测试失败：${r.out}`)
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="settings-wrap">
      <Card title="模型服务" styles={{ body: { padding: 16 } }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
          创作页可跨服务商选择模型。阿里云百炼由 bl CLI 管理（文生图 + 改图全支持）；其余服务商填入 API Key 即可启用，当前仅支持文生图。
        </Typography.Paragraph>
        {PROVIDERS.filter((p) => p.id !== 'bailian').map((p) => (
          <div key={p.id} className="provider-row">
            <div className="provider-head">
              <Badge status={keys[p.id] ? 'success' : 'default'} text={<Typography.Text strong>{p.label}</Typography.Text>} />
              <Typography.Text type="secondary" className="provider-note">
                {p.note}
              </Typography.Text>
            </div>
            <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
              <Input.Password
                value={keys[p.id] ?? ''}
                onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
                placeholder={`${p.label} API Key`}
                visibilityToggle
              />
              <Button onClick={() => void saveKey(p.id)}>保存</Button>
              <Button loading={testing === p.id} onClick={() => void testProvider(p.id)}>
                测试
              </Button>
            </Space.Compact>
          </div>
        ))}
      </Card>

      <Card title="创作引擎（百炼 CLI）" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="状态">
            <Badge
              status={health ? (health.ok ? 'success' : 'error') : 'default'}
              text={health ? (health.ok ? '在线' : '离线') : '检测中…'}
            />
          </Descriptions.Item>
          <Descriptions.Item label="版本">{health?.version || '—'}</Descriptions.Item>
          <Descriptions.Item label="CLI 路径">
            <Typography.Text copyable style={{ fontSize: 12 }}>
              {health?.entry || '—'}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>
        <Popconfirm
          title="运行 bl update 更新百炼 CLI？"
          okText="更新"
          cancelText="取消"
          onConfirm={async () => {
            setUpdating(true)
            try {
              const r = await window.api.blUpdate()
              if (r.ok) message.success('百炼 CLI 已更新，重启应用后生效')
              else message.warning(`更新未完成：${r.out.slice(0, 200)}`)
              refresh()
            } catch (e) {
              message.error(e instanceof Error ? e.message : String(e))
            } finally {
              setUpdating(false)
            }
          }}
        >
          <Button icon={<DownloadOutlined />} loading={updating} style={{ marginTop: 12 }}>
            检查并更新百炼 CLI
          </Button>
        </Popconfirm>
        <Typography.Paragraph type="secondary" className="tip-text">
          更新由百炼官方通道完成，更新后重启妙绘即可生效
        </Typography.Paragraph>
      </Card>

      <Card title="数据目录" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="作品目录">
            <Typography.Text copyable style={{ fontSize: 12 }}>
              {info?.outputsDir || '—'}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="案例库">
            <Typography.Text copyable style={{ fontSize: 12 }}>
              {info?.libraryRoot || '—'}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>
        <Space style={{ marginTop: 12 }}>
          <Button icon={<FolderOpenOutlined />} onClick={() => void window.api.openPath('outputs')}>
            打开作品目录
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => void window.api.openPath('library')}>
            打开案例库
          </Button>
        </Space>
      </Card>

      <Card title="关于" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
        <Space direction="vertical" size={2}>
          <Typography.Text>妙绘工作台 v{info?.version ?? '…'}</Typography.Text>
          <Typography.Text type="secondary">AI 图像创作客户端 · 多服务商模型 · 阿里云百炼 / 硅基流动 / OpenAI</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Electron + React + Ant Design · 灵感：Cherry Studio / LobeChat
          </Typography.Text>
        </Space>
        <Button size="small" icon={<ReloadOutlined />} style={{ marginLeft: 12 }} onClick={refresh}>
          重新检测
        </Button>
      </Card>
    </div>
  )
}
