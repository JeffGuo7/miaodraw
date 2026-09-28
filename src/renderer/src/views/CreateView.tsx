import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Image,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  Upload
} from 'antd'
import {
  CheckOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  LeftOutlined,
  PictureOutlined,
  ReloadOutlined,
  RetweetOutlined,
  RightOutlined,
  ScanOutlined,
  SendOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { ActiveModel, ChainItem, GenOpts, GenResult } from '../types'
import { PROVIDERS, providerDef, providerLabel } from '../models'
import CompareSlider from './CompareSlider'
import { touchActiveModel } from './StatusBar'
import { mediaUrlData, mediaUrlToFile } from '../utils'

const MODELS_LEGACY: Record<string, boolean> = {
  'qwen-image-3.0': true,
  'qwen-image-3.0-pro': true,
  'z-image-turbo': true,
  'wanx2.0-t2i-turbo': true
}

const SIZES = [
  { value: '1024x1024', label: '方图 1:1 · 1024' },
  { value: '896x1152', label: '竖图 3:4 · 896×1152' },
  { value: '1152x896', label: '横图 4:3 · 1152×896' },
  { value: '768x1344', label: '竖屏 9:16 · 768×1344' },
  { value: '1344x768', label: '宽屏 16:9 · 1344×768' }
]

interface Props {
  seed: {
    ts: number
    prompt?: string
    mode?: 't2i' | 'i2i'
    refFile?: File
    negative?: string
    size?: string
    model?: string
    seed?: number
  }
  onDistill: (data: ArrayBuffer, name: string) => void
  onHealthStale: () => void
  onGenerated: () => void
  onOpenSettings: () => void
}

export default function CreateView({ seed, onDistill, onHealthStale, onGenerated, onOpenSettings }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [mode, setMode] = useState<'t2i' | 'i2i'>('t2i')
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [active, setActive] = useState<ActiveModel>({ provider: PROVIDERS[0].id, model: PROVIDERS[0].models[0].model })
  const [size, setSize] = useState(SIZES[0].value)
  const [seedNum, setSeedNum] = useState<number | null>(null)
  const [refFile, setRefFile] = useState<File | null>(null)
  const [refPreview, setRefPreview] = useState('')
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<GenResult | null>(null)
  const [err, setErr] = useState('')
  const lastOpts = useRef<GenOpts | null>(null)
  const runIdRef = useRef('')
  const [stages, setStages] = useState<Array<{ stage: string; detail?: string }>>([])
  const [chain, setChain] = useState<{ items: ChainItem[]; idx: number } | null>(null)
  const [compare, setCompare] = useState(false)
  const [parentName, setParentName] = useState<string | undefined>(undefined)
  const [agentGoal, setAgentGoal] = useState('')
  const [agentBusy, setAgentBusy] = useState(false)
  const [agentSteps, setAgentSteps] = useState<Array<{ label: string; done: boolean }>>([])
  const [agentReply, setAgentReply] = useState('')

  // 真实阶段进度（主进程推送）
  useEffect(() => {
    return window.api.onGenProgress((e) => {
      if (e.runId !== runIdRef.current) return
      setStages((old) => {
        const rest = old.filter((s) => s.stage !== e.stage)
        return [...rest, { stage: e.stage, detail: e.detail }]
      })
    })
  }, [])
  useEffect(() => {
    window.api
      .getSettings()
      .then((s) => {
        if (s.size && SIZES.some((x) => x.value === s.size)) setSize(s.size)
        const am = s.activeModel as { provider?: string; model?: string } | undefined
        if (am?.provider && am?.model && PROVIDERS.some((p) => p.id === am.provider)) {
          const def = providerDef(am.provider)
          if (def?.models.some((m) => m.model === am.model)) setActive({ provider: am.provider, model: am.model })
        } else if (s.model && MODELS_LEGACY[s.model]) {
          setActive({ provider: 'bailian', model: s.model })
        }
        const pv = (s.providers ?? {}) as Record<string, { apiKey?: string }>
        setProviderKeys({ siliconflow: pv.siliconflow?.apiKey ?? '', openai: pv.openai?.apiKey ?? '' })
      })
      .catch(() => undefined)
  }, [])

  // 跨视图流转（从灵感库/历史带提示词或底图过来）
  useEffect(() => {
    if (!seed.ts) return
    if (seed.prompt !== undefined) setPrompt(seed.prompt)
    if (seed.mode) setMode(seed.mode)
    if (seed.refFile) applyRef(seed.refFile)
    if (seed.negative !== undefined) setNegative(seed.negative)
    if (seed.size && SIZES.some((s) => s.value === seed.size)) setSize(seed.size)
    if (seed.seed !== undefined) setSeedNum(seed.seed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed.ts])

  useEffect(() => {
    if (!busy) return
    const start = Date.now()
    setElapsed(0)
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [busy])

  function applyRef(f: File): void {
    setRefFile(f)
    setRefPreview((old) => {
      if (old) URL.revokeObjectURL(old)
      return URL.createObjectURL(f)
    })
  }

  function saveSettings(provider: string, model: string, size: string): void {
    window.api
      .setSettings({ activeModel: { provider, model }, size })
      .then(() => touchActiveModel())
      .catch(() => undefined)
  }

  const provider = active.provider
  const needKey = provider !== 'bailian' && !providerKeys[provider]
  const i2iUnsupported = mode === 'i2i' && !(providerDef(provider)?.i2i ?? false)

  async function doGenerate(): Promise<void> {
    if (busy) return
    const p = prompt.trim()
    if (!p) {
      message.warning('请先输入画面描述')
      return
    }
    if (mode === 'i2i' && !refFile) {
      message.warning('图生图模式：请先上传参考图')
      return
    }
    setBusy(true)
    setErr('')
    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setStages([])
    try {
      const [w, h] = size.split('x').map(Number)
      const opts: GenOpts = {
        prompt: p,
        negative: negative.trim() || undefined,
        w,
        h,
        seed: seedNum ?? 0,
        model: active.model,
        provider,
        runId,
        parent: mode === 'i2i' ? parentName : undefined,
        ref:
          mode === 'i2i' && refFile
            ? { name: refFile.name, data: await refFile.arrayBuffer() }
            : undefined
      }
      lastOpts.current = opts
      const res = await window.api.generate(opts)
      setResult(res)
      setSeedNum(res.seed)
      setCompare(false)
      void window.api
        .imageChain(res.file)
        .then((items) => setChain({ items, idx: items.length - 1 }))
        .catch(() => undefined)
      onHealthStale()
      onGenerated()
      message.success(`生成完成 · ${(res.elapsed / 1000).toFixed(0)} 秒`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function reroll(): Promise<void> {
    setSeedNum(null)
    await doGenerate()
  }

  async function runAgentFlow(): Promise<void> {
    if (agentBusy) return
    const goal = agentGoal.trim()
    if (!goal) {
      message.warning('先描述你想做什么')
      return
    }
    setAgentBusy(true)
    setAgentSteps([])
    setAgentReply('')
    setErr('')
    const runId = crypto.randomUUID()
    try {
      const off = window.api.onAgentProgress((e) => {
        if (e.runId !== runId) return
        if (e.stage === 'plan') {
          setAgentSteps([{ label: 'AI 规划中', done: false }])
        } else if (e.stage === 'step') {
          setAgentSteps((old) => [...old.map((s) => ({ ...s, done: true })), { label: `${e.index ?? ''} ${e.label ?? ''}`.trim(), done: false }])
        } else if (e.stage === 'done') {
          setAgentSteps((old) => old.map((s) => ({ ...s, done: true })))
        }
      })
      const defaultModel = provider === 'bailian' ? active.model : 'qwen-image-3.0'
      const r = await window.api.agentRun({ runId, goal, baseName: result?.file, model: defaultModel })
      off()
      if (r.last) {
        setResult({ file: r.last.file, url: r.last.url, elapsed: 0, seed: 0, model: defaultModel })
        void window.api
          .imageChain(r.last.file)
          .then((items) => setChain({ items, idx: items.length - 1 }))
          .catch(() => undefined)
        onGenerated()
      }
      if (r.reply) setAgentReply(r.reply)
      message.success('AI 助手执行完成')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAgentBusy(false)
    }
  }

  async function useAsRef(): Promise<void> {
    if (!result) return
    try {
      const f = await mediaUrlToFile(result.url, result.file)
      setMode('i2i')
      setParentName(result.file)
      applyRef(f)
      message.success('已作为参考图，描述要怎么改它')
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  async function distillResult(): Promise<void> {
    if (!result) return
    try {
      const data = await mediaUrlData(result.url)
      onDistill(data, result.file)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Row gutter={20} className="create-row">
      {/* 左：控制面板 */}
      <Col flex="420px" className="create-side">
        <Card
          title={
            <Segmented
              block
              value={mode}
              onChange={(v) => setMode(v as 't2i' | 'i2i')}
              options={[
                { value: 't2i', label: '文生图' },
                { value: 'i2i', label: '图生图' }
              ]}
            />
          }
          styles={{ header: { padding: '10px 16px' }, body: { padding: 16 } }}
        >
          {needKey && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`未配置 ${providerLabel(provider)} 的 API Key`}
              action={
                <Button size="small" onClick={onOpenSettings}>
                  去设置
                </Button>
              }
            />
          )}
          {i2iUnsupported && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="当前模型不支持图生图，已为你切换回百炼"
              action={
                <Button
                  size="small"
                  onClick={() => setActive({ provider: 'bailian', model: 'qwen-image-3.0' })}
                >
                  切回百炼
                </Button>
              }
            />
          )}
          {mode === 'i2i' && (
            <Upload.Dragger
              accept="image/*"
              maxCount={1}
              showUploadList={false}
              disabled={busy}
              beforeUpload={(f) => {
                applyRef(f)
                return false
              }}
              className="ref-dragger"
            >
              {refPreview ? (
                <div className="ref-preview" onClick={(e) => e.stopPropagation()}>
                  <img src={refPreview} alt="参考图" />
                  <Button
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={() => {
                      setRefFile(null)
                      setRefPreview('')
                    }}
                  >
                    移除
                  </Button>
                </div>
              ) : (
                <div className="ref-empty">
                  <PictureOutlined style={{ fontSize: 30, color: '#5b8cff' }} />
                  <div>点击或拖入参考图</div>
                  <Typography.Text type="secondary">保留画面主体，按描述修改</Typography.Text>
                </div>
              )}
            </Upload.Dragger>
          )}

          <Typography.Text className="field-label">画面描述</Typography.Text>
          <Input.TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={mode === 'i2i' ? '例：保持人物长相，改成坐在咖啡店里，窗外下雨' : '描述想要的画面，中英文均可，越具体越好'}
            autoSize={{ minRows: 5, maxRows: 12 }}
            maxLength={4000}
            showCount
            disabled={busy}
            onPressEnter={(e) => {
              if (e.ctrlKey || e.metaKey) void doGenerate()
            }}
          />

          <Typography.Text className="field-label">
            负面提示词 <Typography.Text type="secondary" className="optional">(不想出现的内容，可留空)</Typography.Text>
          </Typography.Text>
          <Input
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
            placeholder="例：模糊、文字、水印"
            disabled={busy}
          />

          <Row gutter={10}>
            <Col span={14}>
              <Typography.Text className="field-label">服务商 / 模型</Typography.Text>
              <Select
                value={`${active.provider}::${active.model}`}
                onChange={(v) => {
                  const [p, m] = String(v).split('::')
                  setActive({ provider: p, model: m })
                  saveSettings(p, m, size)
                }}
                disabled={busy}
                style={{ width: '100%' }}
                options={PROVIDERS.map((p) => ({
                  label: p.label,
                  title: p.note,
                  options: p.models.map((m) => ({
                    value: `${p.id}::${m.model}`,
                    label: `${m.label}（${m.price}/张）`
                  }))
                }))}
              />
            </Col>
            <Col span={10}>
              <Typography.Text className="field-label">尺寸</Typography.Text>
              <Select
                value={size}
                onChange={(v) => {
                  setSize(v)
                  saveSettings(active.provider, active.model, v)
                }}
                disabled={busy}
                style={{ width: '100%' }}
                options={SIZES}
              />
            </Col>
          </Row>

          <Typography.Text className="field-label">种子</Typography.Text>
          <Space.Compact style={{ width: '100%' }}>
            <InputNumber
              value={seedNum}
              onChange={(v) => setSeedNum(v)}
              min={0}
              style={{ width: '100%' }}
              placeholder="留空则随机"
              disabled={busy}
            />
            <Tooltip title="清空种子=随机">
              <Button icon={<ReloadOutlined />} disabled={busy} onClick={() => setSeedNum(null)} />
            </Tooltip>
          </Space.Compact>

          <Button
            type="primary"
            icon={<SendOutlined />}
            size="large"
            block
            loading={busy}
            disabled={needKey || i2iUnsupported}
            onClick={doGenerate}
            className="gen-btn"
          >
            {busy ? `生成中… ${elapsed}s` : '生成'}
          </Button>
          <Typography.Text type="secondary" className="tip-text">
            Ctrl + Enter 快速生成 · 出图约 30~60 秒
          </Typography.Text>
        </Card>
      </Col>
      <Col flex="auto" className="create-main">
        {err && (
          <Alert
            type="error"
            showIcon
            closable
            message="生成失败"
            description={<pre className="err-pre">{err}</pre>}
            style={{ marginBottom: 14 }}
          />
        )}
        <Card
          styles={{ body: { padding: 14, height: '100%', display: 'flex', flexDirection: 'column' } }}
          className="result-card"
        >
          {busy ? (
            <div className="result-center">
              <Spin size="large" />
              <Typography.Text type="secondary" style={{ marginTop: 18 }}>
                {providerLabel(provider)} {active.model} · 已用 {elapsed} 秒
              </Typography.Text>
              <div className="stage-row">
                {stages.length === 0 ? (
                  <Tag color="processing">准备中…</Tag>
                ) : (
                  stages.map((s) => (
                    <Tag key={s.stage} color="processing">
                      {s.detail ?? s.stage}
                    </Tag>
                  ))
                )}
              </div>
            </div>
          ) : result ? (
            <>
              <div className="result-img-wrap">
                {compare && chain && chain.idx > 0 ? (
                  <CompareSlider before={chain.items[chain.idx - 1].url} after={chain.items[chain.idx].url} />
                ) : (
                  <Image
                    src={chain ? chain.items[chain.idx].url : result.url}
                    alt={result.file}
                    className="result-img"
                  />
                )}
              </div>
              <div className="result-meta">
                <Space size={6} wrap>
                  {chain && chain.items.length > 1 && (
                    <Space size={0} className="chain-nav">
                      <Button
                        size="small"
                        icon={<LeftOutlined />}
                        disabled={chain.idx === 0}
                        onClick={() => setChain({ ...chain, idx: chain.idx - 1 })}
                      />
                      <Tag style={{ margin: '0 2px' }}>
                        版本 {chain.idx + 1}/{chain.items.length}
                      </Tag>
                      <Button
                        size="small"
                        icon={<RightOutlined />}
                        disabled={chain.idx === chain.items.length - 1}
                        onClick={() => setChain({ ...chain, idx: chain.idx + 1 })}
                      />
                    </Space>
                  )}
                  {chain && chain.idx > 0 && (
                    <Button size="small" type={compare ? 'primary' : 'default'} onClick={() => setCompare(!compare)}>
                      对比
                    </Button>
                  )}
                  <Tag color="blue">{result.model}</Tag>
                  <Tag>{size.replace('x', '×')}</Tag>
                  {result.seed > 0 && <Tag>种子 {result.seed}</Tag>}
                  <Tag>{(result.elapsed / 1000).toFixed(0)}s</Tag>
                </Space>
                <Space size={4} wrap>
                  <Tooltip title="保存到本地">
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      onClick={async () => {
                        const r = await window.api.saveImage(result.url)
                        if (r.ok) message.success(`已保存：${r.path}`)
                        else if (r.err !== '已取消') message.error(r.err)
                      }}
                    >
                      保存
                    </Button>
                  </Tooltip>
                  <Tooltip title="打开所在文件夹">
                    <Button
                      size="small"
                      icon={<FolderOpenOutlined />}
                      onClick={() => void window.api.revealImage(result.url)}
                    />
                  </Tooltip>
                  <Popconfirm title="把这张图作为参考图，进入图生图？" okText="确定" cancelText="取消" onConfirm={useAsRef}>
                    <Button size="small" icon={<RetweetOutlined />}>
                      用作底图
                    </Button>
                  </Popconfirm>
                  <Tooltip title="反推这张图的提示词">
                    <Button size="small" icon={<ScanOutlined />} onClick={distillResult}>
                      蒸馏
                    </Button>
                  </Tooltip>
                  <Tooltip title="同描述重新随机生成">
                    <Button size="small" icon={<ReloadOutlined />} onClick={reroll}>
                      再来一张
                    </Button>
                  </Tooltip>
                </Space>
              </div>
            </>
          ) : (
            <div className="result-center">
              <PictureOutlined style={{ fontSize: 54, color: '#c7c7cc' }} />
              <Typography.Text type="secondary" style={{ marginTop: 16 }}>
                写下描述，点「生成」，作品会出现在这里
              </Typography.Text>
            </div>
          )}
        

        <Card
          title="AI 助手 · 一句话连环创作"
          size="small"
          styles={{ body: { padding: 14 } }}
          style={{ marginTop: 14 }}
        >
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={agentGoal}
              onChange={(e) => setAgentGoal(e.target.value)}
              placeholder={result ? '例：把背景换成雪夜街道，然后提高对比度' : '例：画一张日系清新风格的咖啡店招牌'}
              disabled={agentBusy}
              onPressEnter={(e) => {
                e.preventDefault()
                void runAgentFlow()
              }}
            />
            <Button type="primary" icon={<ThunderboltOutlined />} loading={agentBusy} onClick={() => void runAgentFlow()}>
              运行
            </Button>
          </Space.Compact>
          {agentSteps.length > 0 && (
            <div className="agent-steps">
              {agentSteps.map((s, i) => (
                <Tag key={i} color={s.done ? 'success' : 'processing'} icon={s.done ? <CheckOutlined /> : <ThunderboltOutlined />}>
                  {s.label}
                </Tag>
              ))}
            </div>
          )}
          {agentReply && (
            <Typography.Paragraph type="secondary" className="tip-text" style={{ marginBottom: 0 }}>
              {agentReply}
            </Typography.Paragraph>
          )}
        </Card>
</Card>
      </Col>
    </Row>
  )
}
