import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Image,
  Input,
  Progress,
  Row,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  Upload
} from 'antd'
import { CopyOutlined, PictureOutlined, RetweetOutlined, ScanOutlined } from '@ant-design/icons'
import type { CaptionProgress } from '../types'

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
  const [local, setLocal] = useState(false)
  const [rewrite, setRewrite] = useState(true)
  const [progress, setProgress] = useState<CaptionProgress | null>(null)
  const [raw, setRaw] = useState('')
  const [captionModel, setCaptionModel] = useState('')
  const lastSeedTs = useRef(0)

  useEffect(() => window.api.onLocalCaptionProgress((p) => setProgress(p)), [])
  useEffect(() => {
    void window.api.captionModel().then((r) => setCaptionModel(r.model)).catch(() => undefined)
  }, [])

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
    setRaw('')
    void run(data, name)
  }

  async function runLocal(data: ArrayBuffer, name: string): Promise<void> {
    setBusy(true)
    setElapsed(0)
    setProgress(null)
    const t0 = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500)
    try {
      const r = await window.api.distillLocal({ data, name, rewrite })
      setPrompt(r.prompt)
      setRaw(r.rewritten ? (r.raw || '') : '')
      message.success(`本地反推完成 · ${(r.elapsed / 1000).toFixed(0)} 秒${r.rewritten ? ' · 已改写为中文' : ''}`)
    } catch (e) {
      message.error(`本地反推失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      window.clearInterval(timer)
      setBusy(false)
      setProgress(null)
    }
  }

  async function run(data: ArrayBuffer, name: string): Promise<void> {
    if (local) return runLocal(data, name)
    setBusy(true)
    setElapsed(0)
    const t0 = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500)
    try {
      const r = await window.api.distill({ data, name })
      setPrompt(r.prompt)
      setRaw('')
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
    <Row gutter={20} style={{ height: '100%' }} align="stretch">
      <Col span={9}>
        <Card title="源图片" style={{ height: '100%' }} styles={{ body: { padding: 14 } }}>
          <Segmented
            block
            value={local ? 'local' : 'online'}
            onChange={(v) => setLocal(v === 'local')}
            options={[
              { value: 'online', label: '在线 · 质量高' },
              { value: 'local', label: '本地 · 离线免费' }
            ]}
            style={{ marginBottom: 10 }}
          />
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
          <Typography.Paragraph type="secondary" className="tip-text" style={{ marginTop: 12, marginBottom: 0 }}>
            {local ? (
              <>
                <Tag color="purple">本地 {captionModel || '视觉模型'}</Tag>
                图片不出本机、不花钱；首次使用会下载约 250MB 模型到本机缓存。本地小模型只出简短英文描述，
                建议勾选下方「用文本模型改写成中文提示词」。
              </>
            ) : (
              <>
                <Tag color="blue" title="qwen3-vl-plus">云端视觉模型</Tag>
                由视觉模型理解画面后输出一段通用提示词，可直接粘贴到 Midjourney / 即梦 / SD 等任何生图产品使用。
              </>
            )}
          </Typography.Paragraph>
          {local && (
            <Checkbox checked={rewrite} onChange={(e) => setRewrite(e.target.checked)} style={{ marginTop: 8 }}>
              用文本模型改写成中文提示词（消耗少量 token）
            </Checkbox>
          )}
        </Card>
      </Col>
      <Col span={15}>
        <Card
          title="反推结果"
          style={{ height: '100%' }}
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
                {progress?.stage === 'download' ? '正在下载本地模型…' : '正在理解画面…'} {elapsed}s
              </Typography.Text>
              {progress?.stage === 'download' && (
                <div style={{ width: 320, marginTop: 14 }}>
                  <Progress percent={progress.percent ?? 0} size="small" status="active" />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {progress.file || '模型文件'}（仅首次需要，之后离线可用）
                  </Typography.Text>
                </div>
              )}
            </div>
          ) : prompt ? (
            <>
              <Input.TextArea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                autoSize={{ minRows: 14, maxRows: 24 }}
              />
              {raw && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 10 }}
                  message="本地模型原始描述（英文）"
                  description={<span style={{ fontSize: 12 }}>{raw}</span>}
                />
              )}
              <Typography.Text type="secondary" className="tip-text">
                可直接编辑；复制后粘贴到任意生图产品
              </Typography.Text>
            </>
          ) : srcUrl ? (
            <Image src={srcUrl} alt="源图片" height={200} />
          ) : (
            <div className="result-center" style={{ minHeight: 380 }}>
              <ScanOutlined style={{ fontSize: 54, color: '#c7c7cc' }} />
              <div className="result-empty-title">这里会出现反推出的提示词</div>
              <div className="result-empty-sub">左边放一张图，系统会读懂画面并写成可复用的描述</div>
              <div className="distill-steps">
                {[
                  { n: '1', t: '放图', d: '拖入或点选一张参考图' },
                  { n: '2', t: '反推', d: '选在线（质量高）或本地（免费）' },
                  { n: '3', t: '拿去用', d: '复制，或直接送进创作页' }
                ].map((s) => (
                  <div key={s.n} className="distill-step">
                    <span className="distill-step-n">{s.n}</span>
                    <span className="distill-step-t">{s.t}</span>
                    <span className="distill-step-d">{s.d}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  )
}
