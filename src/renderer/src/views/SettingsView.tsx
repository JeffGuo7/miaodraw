import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Input,
  Popconfirm,
  Space,
  Tag,
  Typography
} from 'antd'
import {
  DeleteOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import type { BailianKeyInfo, HealthInfo } from '../types'
import { PROVIDERS } from '../models'

export default function SettingsView({ visible }: { visible: boolean }): JSX.Element {
  const { message } = AntdApp.useApp()
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [info, setInfo] = useState<{ version: string; name: string; libraryRoot: string; outputsDir: string } | null>(null)
  const [updating, setUpdating] = useState(false)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [bk, setBk] = useState<BailianKeyInfo | null>(null)
  const [bkInput, setBkInput] = useState('')
  const [bkTesting, setBkTesting] = useState(false)

  function refresh(): void {
    void window.api.health().then(setHealth)
    void window.api.appInfo().then(setInfo)
    void window.api.bailianKeyGet().then(setBk).catch(() => undefined)
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

  async function saveBailianKey(): Promise<void> {
    const r = await window.api.bailianKeySet(bkInput.trim())
    if (!r.ok) {
      message.error(r.err)
      return
    }
    setBk(r.info)
    setBkInput('')
    if (r.plainFallback) message.warning('已保存，但本机系统安全存储不可用，密钥以编码形式保存（仅本机能读，建议尽快改用登录态）')
    else message.success('百炼密钥已加密保存，立即可用（无需 bl auth login）')
    void window.api.health().then(setHealth)
  }

  async function testBailianKey(): Promise<void> {
    setBkTesting(true)
    try {
      const r = await window.api.bailianKeyTest()
      if (r.ok) message.success(r.out)
      else message.error(`测试失败：${r.out}`)
    } finally {
      setBkTesting(false)
    }
  }

  async function clearBailianKey(): Promise<void> {
    setBk(await window.api.bailianKeyClear())
    message.success('已清除应用内百炼密钥')
    void window.api.health().then(setHealth)
  }

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
      <Card
        title={
          <Space size={8}>
            <KeyOutlined />
            <span>百炼密钥（免登录直接使用）</span>
            {bk?.configured && (
              <Tag color={bk.plan === 'token-plan' ? 'gold' : 'blue'} style={{ marginInlineStart: 4 }}>
                {bk.plan === 'token-plan' ? 'Token Plan 订阅密钥' : bk.plan === 'ordinary' ? '普通 API Key' : '自定义密钥'}
              </Tag>
            )}
          </Space>
        }
        styles={{ body: { padding: 16 } }}
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
          填入密钥后，妙绘会自动带着它调用百炼生图 / 改图 / 提示词反推，<strong>无需在命令行安装登录后运行 bl auth login</strong>。
          支持百炼控制台下载的普通 API Key（<Typography.Text code>sk-</Typography.Text> 开头）与
          Token Plan 订阅密钥（<Typography.Text code>sk-sp-</Typography.Text> 开头，自动识别并路由订阅端点）。
          密钥在本机加密保存，不会上传任何第三方。
        </Typography.Paragraph>
        {bk?.configured ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" style={{ marginBottom: 0 }}>
              <Descriptions.Item label="当前密钥">
                <Typography.Text code>{bk.masked}</Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            {bk.plainFallback && (
              <Alert
                type="warning"
                showIcon
                message="本机系统安全存储不可用，密钥为编码保存（仅本机可读），建议留意使用环境"
              />
            )}
            <Space wrap>
              <Button icon={<ReloadOutlined />} loading={bkTesting} onClick={() => void testBailianKey()}>
                测试连通
              </Button>
              <Popconfirm title="清除后创作将回退到命令行登录态（如有）。确认清除？" okText="清除" onConfirm={() => void clearBailianKey()}>
                <Button danger icon={<DeleteOutlined />}>
                  清除密钥
                </Button>
              </Popconfirm>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                更换密钥：在下方填入新密钥并保存即可覆盖
              </Typography.Text>
            </Space>
          </Space>
        ) : (
          <Space.Compact style={{ width: '100%', maxWidth: 640 }}>
            <Input.Password
              value={bkInput}
              onChange={(e) => setBkInput(e.target.value)}
              placeholder="粘贴百炼 API Key（sk-…）或 Token Plan 密钥（sk-sp-…）"
              visibilityToggle
              onPressEnter={() => bkInput.trim() && void saveBailianKey()}
            />
            <Button type="primary" disabled={!bkInput.trim()} onClick={() => void saveBailianKey()}>
              保存
            </Button>
          </Space.Compact>
        )}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
          密钥获取：登录百炼控制台，在「API-KEY 管理」下载普通密钥，或在「Token Plan · 订阅总览」下载订阅密钥（sk-sp- 开头）。
          保存后所有百炼调用自动使用该密钥；清除后回退到命令行 bl auth login 的登录态。
        </Typography.Paragraph>
      </Card>

      <Card title="模型服务" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
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
          <Descriptions.Item label="鉴权来源">
            {bk?.configured ? (
              <Tag color="success">{bk.plan === 'token-plan' ? '应用内 Token Plan 密钥' : '应用内百炼密钥'}</Tag>
            ) : (
              <Tag>命令行 bl 登录态</Tag>
            )}
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
