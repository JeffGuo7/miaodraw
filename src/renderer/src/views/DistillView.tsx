import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Image,
  Input,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
  Upload
} from 'antd'
import { CopyOutlined, PictureOutlined, RetweetOutlined, ScanOutlined } from '@ant-design/icons'

interface Props {
  seed: { ts: number; data: ArrayBuffer; name: string } | null
  onUsePrompt: (prompt: string) => void
}

export default function DistillView({ seed, onUsePrompt }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [srcUrl, setSrcUrl] = useState('')
  const [srcData, setSrcData] = useState<{ data: ArrayBuffer; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const lastSeedTs = useRef(0)

  function revoke(): void {
    setSrcUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return ''
    })
  }

  function applySource(data: ArrayBuffer, name: string): void {
    revoke()
    setSrcData({ data, name })
    setSrcUrl(URL.createObjectURL(new Blob([data])))
    setPrompt('')
    void run(data, name)
  }

  async function run(data: ArrayBuffer, name: string): Promise<void> {
    setBusy(true)
    setElapsed(0)
    const t0 = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500)
    try {
      const r = await window.api.distill({ data, name })
      setPrompt(r.prompt)
      message.success(`反推完成 · ${(r.elapsed / 1000).toFixed(0)} 秒`)
    } catch (e) {
      message.error(`反推失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      window.clearInterval(timer)
      setBusy(false)
    }
  }

  useEffect(() => {
    if (seed && seed.ts !== lastSeedTs.current) {
      lastSeedTs.current = seed.ts
      applySource(seed.data, seed.name)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  return (
    <Row gutter={20}>
      <Col span={9}>
        <Card title="源图片" styles={{ body: { padding: 14 } }}>
          <Upload.Dragger
            accept="image/*"
            maxCount={1}
            showUploadList={false}
            disabled={busy}
            beforeUpload={(f) => {
              void f.arrayBuffer().then((d) => applySource(d, f.name))
              return false
            }}
            className="ref-dragger"
          >
            {srcUrl ? (
              <div className="ref-preview" onClick={(e) => e.stopPropagation()}>
                <img src={srcUrl} alt="源图片" />
                <Space>
                  <Button
                    size="small"
                    icon={<ScanOutlined />}
                    loading={busy}
                    onClick={() => srcData && run(srcData.data, srcData.name)}
                  >
                    重新反推
                  </Button>
                  <Button size="small" disabled={busy} onClick={() => { revoke(); setSrcData(null); setPrompt('') }}>
                    更换图片
                  </Button>
                </Space>
              </div>
            ) : (
              <div className="ref-empty">
                <PictureOutlined style={{ fontSize: 30, color: '#5b8cff' }} />
                <div>点击或拖入一张图片</div>
                <Typography.Text type="secondary">支持 JPG / PNG / WebP，自动反推提示词</Typography.Text>
              </div>
            )}
          </Upload.Dragger>
          <Typography.Paragraph type="secondary" className="tip-text" style={{ marginTop: 12 }}>
            <Tag color="blue">qwen3-vl-plus</Tag>
            视觉模型理解画面后输出一段通用提示词，可直接粘贴到 Midjourney / 即梦 / SD 等任何生图产品使用。
          </Typography.Paragraph>
        </Card>
      </Col>
      <Col span={15}>
        <Card
          title="反推结果"
          extra={
            srcUrl && (
              <Space>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  disabled={!prompt}
                  onClick={async () => {
                    await navigator.clipboard.writeText(prompt)
                    message.success('已复制到剪贴板')
                  }}
                >
                  复制
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<RetweetOutlined />}
                  disabled={!prompt}
                  onClick={() => {
                    onUsePrompt(prompt)
                    message.success('已带入创作台')
                  }}
                >
                  去生成
                </Button>
              </Space>
            )
          }
          styles={{ body: { padding: 14 } }}
        >
          {busy ? (
            <div className="result-center" style={{ minHeight: 380 }}>
              <Spin size="large" />
              <Typography.Text type="secondary" style={{ marginTop: 18 }}>
                视觉模型正在理解画面… {elapsed}s
              </Typography.Text>
            </div>
          ) : prompt ? (
            <>
              <Input.TextArea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                autoSize={{ minRows: 14, maxRows: 24 }}
              />
              <Typography.Text type="secondary" className="tip-text">
                可直接编辑；复制后粘贴到任意生图产品
              </Typography.Text>
            </>
          ) : srcUrl ? (
            <Image src={srcUrl} alt="源图片" height={200} />
          ) : (
            <div className="result-center" style={{ minHeight: 380 }}>
              <ScanOutlined style={{ fontSize: 54, color: '#c7c7cc' }} />
              <Typography.Text type="secondary" style={{ marginTop: 16 }}>
                上传一张图，自动反推出可复用的提示词
              </Typography.Text>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  )
}
