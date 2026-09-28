import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { App as AntdApp, Badge, Button, Modal, Space, Steps, Typography } from 'antd'
import {
  AppstoreOutlined,
  EditOutlined,
  HistoryOutlined,
  ScanOutlined,
} from '@ant-design/icons'

interface Props {
  open: boolean
  onClose: () => void
}

const FEATURES = [
  { icon: <EditOutlined />, title: '创作', desc: '文生图 / 图生图，一次一张高质量作品' },
  { icon: <AppstoreOutlined />, title: '灵感库', desc: '千余个去重案例，点卡片即得提示词' },
  { icon: <ScanOutlined />, title: '提示词反推', desc: '任意图片反推提示词，全平台通用' },
  { icon: <HistoryOutlined />, title: '历史记录', desc: '作品参数全保存，一键复现' }
]

export default function Onboarding({ open, onClose }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [step, setStep] = useState(0)
  const [checking, setChecking] = useState(false)
  const [health, setHealth] = useState<{ ok: boolean; version: string } | null>(null)

  useEffect(() => {
    if (open && step === 1 && !health && !checking) {
      setChecking(true)
      void window.api
        .health()
        .then(setHealth)
        .catch(() => setHealth({ ok: false, version: '' }))
        .finally(() => setChecking(false))
    }
  }, [open, step, health, checking])

  function finish(): void {
    void window.api.setSettings({ onboarded: '1' })
    message.success('开始创作吧！')
    onClose()
  }

  return (
    <Modal open={open} onCancel={finish} footer={null} width={520} centered>
      <div style={{ textAlign: 'center', padding: '8px 4px 0' }}>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          欢迎使用妙绘工作台
        </Typography.Title>
        <Typography.Text type="secondary">阿里云百炼 API 驱动的 AI 图像创作客户端</Typography.Text>
      </div>
      <Steps
        current={step}
        items={[{ title: '了解' }, { title: '检测引擎' }, { title: '就绪' }]}
        style={{ margin: '22px 0 18px' }}
        size="small"
      />
      <div style={{ minHeight: 170 }}>
        {step === 0 && (
          <div className="ob-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="ob-feature">
                <span className="ob-feature-icon">{f.icon}</span>
                <div>
                  <div className="ob-feature-title">{f.title}</div>
                  <div className="ob-feature-desc">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className="ob-engine">
            {checking ? (
              <Typography.Text type="secondary">正在检测百炼 CLI…</Typography.Text>
            ) : health?.ok ? (
              <Space direction="vertical" size={4} align="center" style={{ width: '100%' }}>
                <Badge status="success" text={<span style={{ fontSize: 16 }}>引擎在线 · bl {health.version}</span>} />
                <Typography.Text type="secondary">
                  若尚未登录百炼，到「设置 → 百炼密钥」粘贴 API Key 即可直接创作
                </Typography.Text>
              </Space>
            ) : (
              <Space direction="vertical" size={4} align="center" style={{ width: '100%' }}>
                <Badge status="error" text={<span style={{ fontSize: 15 }}>未检测到百炼引擎</span>} />
                <Typography.Text type="secondary">
                  最简单：到「设置 → 百炼密钥」粘贴百炼 / Token Plan 密钥，保存即用；
                  也可安装命令行版：npm i -g bailian-cli && bl auth login
                </Typography.Text>
              </Space>
            )}
          </div>
        )}
        {step === 2 && (
          <div style={{ textAlign: 'center', padding: '18px 0' }}>
            <Typography.Title level={4} style={{ marginBottom: 8 }}>
              一切就绪
            </Typography.Title>
            <Typography.Text type="secondary">
              小技巧：任意界面按 Ctrl + K 可全局搜索案例与作品
            </Typography.Text>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
        <Button type="text" onClick={finish}>
          跳过
        </Button>
        <Space>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>上一步</Button>}
          {step < 2 ? (
            <Button type="primary" disabled={step === 1 && (checking || !health)} onClick={() => setStep(step + 1)}>
              {step === 1 ? '下一步' : '开始'}
            </Button>
          ) : (
            <Button type="primary" onClick={finish}>
              开始创作
            </Button>
          )}
        </Space>
      </div>
    </Modal>
  )
}
