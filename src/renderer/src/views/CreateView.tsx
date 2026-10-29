import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Switch,
  Tag,
  Tooltip,
  Typography,
  Upload
} from 'antd'
import {
  AppstoreOutlined,
  CheckOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  HighlightOutlined,
  LeftOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  RetweetOutlined,
  RightOutlined,
  ScanOutlined,
  SendOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { ActiveModel, ChainItem, GenOpts, GenResult, ModelConfig, RefImage, RefRole, StyleEntry } from '../types'
import { byCap, modelKey, providerDef, providerLabel, refLimit, resolveModels } from '../models'
import CompareSlider from './CompareSlider'
import ImageEditModal from './ImageEditModal'
import StyleLibrary from './StyleLibrary'
import { touchActiveModel } from './StatusBar'
import { mediaUrlData, mediaUrlToFile } from '../utils'

const MODELS_LEGACY: Record<string, boolean> = {
  'qwen-image-3.0': true,
  'qwen-image-3.0-pro': true,
  'z-image-turbo': true,
  'wanx2.0-t2i-turbo': true
}

/** 素材托盘条目：数组顺序即提示词里的「图1/图2/图3」 */
interface RefItem {
  id: string
  file: File
  preview: string
  role: RefRole
  source: NonNullable<RefImage['source']>
}

const ROLE_OPTS: Array<{ value: RefRole; label: string }> = [
  { value: 'ref', label: '参考' },
  { value: 'subject', label: '主体' },
  { value: 'style', label: '风格' },
  { value: 'background', label: '背景' },
  { value: 'pose', label: '姿势' },
  { value: 'outfit', label: '服装' },
  { value: 'sketch', label: '线稿' }
]

/** 融合提示词模板：点一下即填，可再编辑；引用序号与素材顺序一致 */
const FUSION_TEMPLATES: Array<{ label: string; text: string }> = [
  { label: '换风格', text: '保持图1的主体与构图不变，用图2的风格、色彩与笔触重绘整幅画面' },
  { label: '换背景', text: '把图1的主体放进图2的场景中，光影与透视自然融合，边缘过渡真实' },
  { label: '换服装', text: '让图1的人物穿上图2中的服装，保持人物面部特征与姿势不变' },
  { label: '风格迁移', text: '参考图2的配色与光影氛围，重绘图1的内容，保持画面主体一致' },
  { label: '多图组图', text: '参考图1的角色与图2的场景，生成一组同一角色的连续画面，风格统一' }
]

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
    mode?: 't2i' | 'fusion'
    refFile?: File
    /** 多素材（历史复现时从素材留档还原） */
    refs?: Array<{ file: File; role?: RefRole; source?: RefImage['source'] }>
    negative?: string
    size?: string
    model?: string
    seed?: number
  }
  onDistill: (data: ArrayBuffer, name: string) => void
  onHealthStale: () => void
  onGenerated: () => void
  onOpenSettings: () => void
  /** 当前是否为可见页：常驻挂载（App 用 display 切换），需要靠它感知「从设置页回来」以刷新密钥状态 */
  visible?: boolean
}

export default function CreateView({ seed, onDistill, onHealthStale, onGenerated, onOpenSettings, visible = true }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [mode, setMode] = useState<'t2i' | 'fusion'>('t2i')
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [active, setActive] = useState<ActiveModel>(() => {
    const first = resolveModels(undefined)[0]
    return { provider: first?.provider ?? 'bailian', model: first?.model ?? 'qwen-image-3.0-pro' }
  })
  const [size, setSize] = useState(SIZES[0].value)
  const [seedNum, setSeedNum] = useState<number | null>(null)
  const [refItems, setRefItems] = useState<RefItem[]>([])
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  /** 组图模式（wan2.7 enable_sequential） */
  const [batchOn, setBatchOn] = useState(false)
  const [batchN, setBatchN] = useState(4)
  const [providerKeys, setProviderKeys] = useState<Record<string, boolean>>({})
  // 通用模型配置：内置模板 + 用户追加模型 + 自定义供应商，统一解析为可用模型目录
  const [mc, setMc] = useState<ModelConfig | undefined>()
  const catalog = useMemo(() => resolveModels(mc), [mc])
  const imageModels = useMemo(() => byCap(catalog, 'image'), [catalog])
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
  const [editOpen, setEditOpen] = useState(false)
  const [styleOpen, setStyleOpen] = useState(false)

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
    void Promise.all([window.api.getSettings(), window.api.modelConfigGet()])
      .then(([s, c]) => {
        setMc(c)
        const cat = resolveModels(c)
        if (s.size && SIZES.some((x) => x.value === s.size)) setSize(s.size)
        const am = s.activeModel as { provider?: string; model?: string } | undefined
        if (am?.provider && am?.model && cat.some((m) => m.provider === am.provider && m.model === am.model)) {
          setActive({ provider: am.provider, model: am.model })
        } else if (s.model && MODELS_LEGACY[s.model]) {
          setActive({ provider: 'bailian', model: s.model })
        }
        const pk = (s.providerKeys ?? {}) as Record<string, { configured?: boolean }>
        const flags: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(pk)) flags[k] = !!v?.configured
        setProviderKeys(flags)
      })
      .catch(() => undefined)
  }, [])

  /**
   * 密钥状态刷新：本组件常驻不卸载（App 用 display 切页），只在 mount 读一次会导致
   * 「首次去设置页配好密钥 → 回到创作页，生成按钮仍是禁用」的死锁。切回本页时重读。
   */
  const refreshProviderKeys = useCallback((): void => {
    void window.api
      .getSettings()
      .then((s) => {
        const pk = (s.providerKeys ?? {}) as Record<string, { configured?: boolean }>
        const flags: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(pk)) flags[k] = !!v?.configured
        setProviderKeys(flags)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!visible) return
    refreshProviderKeys()
  }, [visible, refreshProviderKeys])

  // 跨视图流转（从灵感库/历史带提示词或底图过来）
  useEffect(() => {
    if (!seed.ts) return
    if (seed.prompt !== undefined) setPrompt(seed.prompt)
    if (seed.mode) setMode(seed.mode)
    const seedRefs = seed.refs
    if (seedRefs?.length) {
      // 复现：整盘替换素材（先释放旧缩略图的 objectURL，避免内存泄漏）
      setRefItems((old) => {
        for (const r of old) URL.revokeObjectURL(r.preview)
        return seedRefs.map((r) => ({
          id: crypto.randomUUID(),
          file: r.file,
          preview: URL.createObjectURL(r.file),
          role: r.role ?? 'ref',
          source: r.source ?? ('history' as const)
        }))
      })
    } else if (seed.refFile) {
      applyRef(seed.refFile)
    }
    if (seed.negative !== undefined) setNegative(seed.negative)
    if (seed.size && SIZES.some((s) => s.value === seed.size)) setSize(seed.size)
    if (seed.seed !== undefined) setSeedNum(seed.seed)
    if (seed.model) {
      // 复现必须连模型一起回填，否则结果与历史记录不符
      const hit = catalog.find((m) => m.model === seed.model)
      if (hit) setActive({ provider: hit.provider, model: hit.model })
      else message.warning(`历史记录的模型 ${seed.model} 不在当前模型列表，已保留当前选择`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed.ts])

  useEffect(() => {
    if (!busy) return
    const start = Date.now()
    setElapsed(0)
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [busy])

  /** 多素材融合：素材上限由所选模型能力决定（wan2.7=9 / qwen-image-3.x=3 / 其他=1） */
  const maxRefs = refLimit(active.model)

  function addRef(f: File, source: RefItem['source'] = 'upload'): void {
    setRefItems((old) => {
      if (old.length >= maxRefs) {
        message.warning(`当前模型最多支持 ${maxRefs} 张素材，请换用支持更多素材的模型`)
        return old
      }
      return [...old, { id: crypto.randomUUID(), file: f, preview: URL.createObjectURL(f), role: 'ref', source }]
    })
  }

  function removeRef(id: string): void {
    setRefItems((old) => {
      const hit = old.find((r) => r.id === id)
      if (hit) URL.revokeObjectURL(hit.preview)
      return old.filter((r) => r.id !== id)
    })
  }

  /** 拖拽排序：数组顺序就是「图1/图2/图3」，提示词里的引用跟着变 */
  function moveRef(from: number, to: number): void {
    setRefItems((old) => {
      if (from === to || from < 0 || to < 0 || from >= old.length || to >= old.length) return old
      const next = [...old]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  function setRefRole(id: string, role: RefRole): void {
    setRefItems((old) => old.map((r) => (r.id === id ? { ...r, role } : r)))
  }

  /** 把「图N」引用插进提示词（主进程按数组顺序对应，无需额外协议） */
  function insertRefToken(order: number): void {
    setPrompt((p) => {
      const token = `图${order}`
      if (!p) return token
      return /\s$/.test(p) ? p + token : `${p} ${token}`
    })
  }

  /** 兼容旧入口：灵感库/历史带过来的底图直接进素材托盘 */
  function applyRef(f: File): void {
    addRef(f, 'history')
  }

  function saveSettings(provider: string, model: string, size: string): void {
    window.api
      .setSettings({ activeModel: { provider, model }, size })
      .then(() => touchActiveModel())
      .catch(() => undefined)
  }

  const provider = active.provider
  const needKey = !providerKeys[provider]
  // 素材融合目前仅百炼侧支持（DashScope 原生 / OpenAI 兼容两条协议都已接入多图）
  const i2iUnsupported = mode === 'fusion' && provider !== 'bailian'
  /** 组图能力：wan2.7 系支持 enable_sequential（与主进程 imageCapability 的协议判定一致） */
  const canBatch = provider === 'bailian' && active.model.toLowerCase().startsWith('wan2.')
  /** 成本预估：取模型目录里的单价（形如 ¥0.2 / $0.04），组图按最大张数计 */
  const estimate = (() => {
    const price = imageModels.find((m) => m.model === active.model)?.price ?? ''
    const hit = price.match(/([¥$])\s*([\d.]+)/)
    if (!hit) return ''
    const qty = batchOn ? batchN : 1
    return `约 ${hit[1]}${(Number(hit[2]) * qty).toFixed(2)}${batchOn ? `（最多 ${qty} 张）` : ''}`
  })()

  /** seedOverride：0 = 让主进程随机种子；不传 = 沿用当前种子输入 */
  async function doGenerate(seedOverride?: number): Promise<void> {
    if (busy) return
    const p = prompt.trim()
    if (!p) {
      message.warning('请先输入画面描述')
      return
    }
    if (mode === 'fusion' && refItems.length === 0) {
      message.warning('素材融合模式：请先添加至少一张素材')
      return
    }
    setBusy(true)
    setErr('')
    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setStages([])
    try {
      const [w, h] = size.split('x').map(Number)
      const refs: RefImage[] =
        mode === 'fusion'
          ? await Promise.all(
              refItems.map(async (r) => ({
                name: r.file.name,
                data: (await r.file.arrayBuffer()) as ArrayBuffer,
                role: r.role,
                source: r.source
              }))
            )
          : []
      const opts: GenOpts = {
        prompt: p,
        negative: negative.trim() || undefined,
        w,
        h,
        seed: seedOverride ?? seedNum ?? 0,
        model: active.model,
        provider,
        runId,
        parent: mode === 'fusion' ? parentName : undefined,
        refs: refs.length ? refs : undefined,
        // 组图：仅 wan2.7 系支持；n 为最大张数
        n: batchOn ? batchN : undefined,
        sequential: batchOn || undefined
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
    // 必须显式传 0（主进程随机）：setSeedNum(null) 要下次渲染才生效，本闭包里还是旧种子
    await doGenerate(0)
  }

  /** 套用内置风格：已有描述时拼接（保留用户的主体描述），否则直接填入 */
  function pickStyle(s: StyleEntry): void {
    setPrompt((p) => (p.trim() ? `${p.trim()}\n\n${s.prompt}` : s.prompt))
  }

  /** 图像编辑完成：结果接在当前图后面（版本链），作品目录与历史都能看到 */
  function onEditDone(r: GenResult): void {
    setResult(r)
    if (r.seed > 0) setSeedNum(r.seed)
    void window.api
      .imageChain(r.file)
      .then((items) => setChain({ items, idx: items.length - 1 }))
      .catch(() => undefined)
    onHealthStale()
    onGenerated()
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
    let offAgent: (() => void) | undefined
    try {
      offAgent = window.api.onAgentProgress((e) => {
        if (e.runId !== runId) return
        if (e.stage === 'plan') {
          setAgentSteps([{ label: 'AI 规划中', done: false }])
        } else if (e.stage === 'step') {
          setAgentSteps((old) => [...old.map((s) => ({ ...s, done: true })), { label: `${e.index ?? ''} ${e.label ?? ''}`.trim(), done: false }])
        } else if (e.stage === 'done') {
          setAgentSteps((old) => old.map((s) => ({ ...s, done: true })))
        }
      })
      const r = await window.api.agentRun({
        runId,
        goal,
        baseName: result?.file,
        model: active.model,
        provider,
        // 素材托盘交给 Agent：它可以用 images=[1,2] 引用图1/图2
        refs: refItems.length
          ? await Promise.all(
              refItems.map(async (it) => ({
                name: it.file.name,
                data: (await it.file.arrayBuffer()) as ArrayBuffer,
                role: it.role
              }))
            )
          : undefined
      })
      if (r.last) {
        setResult({ file: r.last.file, url: r.last.url, elapsed: 0, seed: 0, model: active.model })
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
      offAgent?.() // 无论成败都要解绑，否则失败一次泄漏一个监听器
      setAgentBusy(false)
    }
  }

  async function useAsRef(): Promise<void> {
    if (!result) return
    try {
      const f = await mediaUrlToFile(result.url, result.file)
      setMode('fusion')
      setParentName(result.file)
      applyRef(f)
      message.success('已加入素材托盘，描述要怎么融合')
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
    <Row gutter={20} wrap={false} className="create-row">
      {/* 左：控制面板 */}
      <Col flex="420px" className="create-side">
        <Card
          title={
            <Segmented
              block
              value={mode}
              onChange={(v) => setMode(v as 't2i' | 'fusion')}
              options={[
                { value: 't2i', label: '文生图' },
                { value: 'fusion', label: '素材融合' }
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
              message={`未配置 ${providerLabel(provider, mc)} 的 API Key`}
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
                  onClick={() => setActive({ provider: 'bailian', model: providerDef('bailian')?.models[0]?.model ?? 'wan2.7-image' })}
                >
                  切回百炼
                </Button>
              }
            />
          )}
          {mode === 'fusion' && (
            <div className="ref-tray">
              <div className="ref-tray-head">
                <Typography.Text className="field-label" style={{ margin: 0 }}>
                  融合素材
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  拖拽排序即「图1/图2」· 当前模型最多 {maxRefs} 张 · 已用 {refItems.length}
                </Typography.Text>
              </div>
              <div className="ref-tray-list">
                {refItems.map((r, i) => (
                  <div
                    key={r.id}
                    className={`ref-item${dragIdx === i ? ' dragging' : ''}`}
                    draggable={!busy}
                    onDragStart={() => setDragIdx(i)}
                    onDragEnd={() => setDragIdx(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragIdx !== null) moveRef(dragIdx, i)
                      setDragIdx(null)
                    }}
                  >
                    <span className="ref-order">图{i + 1}</span>
                    <img src={r.preview} alt={`素材${i + 1}`} />
                    <div className="ref-item-bar">
                      <Select
                        size="small"
                        variant="borderless"
                        value={r.role}
                        onChange={(v) => setRefRole(r.id, v as RefRole)}
                        options={ROLE_OPTS}
                        popupMatchSelectWidth={90}
                      />
                      <Tooltip title="删除">
                        <Button
                          type="text"
                          size="small"
                          className="ref-del"
                          icon={<DeleteOutlined />}
                          onClick={() => removeRef(r.id)}
                        />
                      </Tooltip>
                    </div>
                  </div>
                ))}
                {refItems.length < maxRefs && (
                  <Upload
                    accept="image/*"
                    multiple
                    showUploadList={false}
                    disabled={busy}
                    beforeUpload={(f) => {
                      addRef(f, 'upload')
                      return false
                    }}
                  >
                    <div className="ref-add">
                      <PlusOutlined style={{ fontSize: 20 }} />
                      <span>添加素材</span>
                    </div>
                  </Upload>
                )}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                可在提示词里用「图1/图2」指代素材；素材会随作品留档，历史记录一键复现
              </Typography.Text>
            </div>
          )}

          <div className="field-label-row">
            <Typography.Text className="field-label" style={{ margin: 0 }}>
              画面描述
              {mode === 'fusion' && refItems.length > 0 && (
                <span className="ref-tokens">
                  {refItems.map((r, i) => (
                    <Tag key={r.id} className="ref-token" onClick={() => insertRefToken(i + 1)}>
                      图{i + 1}
                    </Tag>
                  ))}
                </span>
              )}
            </Typography.Text>
            <Tooltip title="内置风格与提示词库（手绘风格 / 商业模板 / 实战提示词）">
              <Button size="small" type="text" className="style-lib-btn" icon={<AppstoreOutlined />} onClick={() => setStyleOpen(true)}>
                风格库
              </Button>
            </Tooltip>
          </div>
          {mode === 'fusion' && (
            <div className="ref-templates">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                融合模板：
              </Typography.Text>
              {FUSION_TEMPLATES.map((t) => (
                <Tag key={t.label} className="ref-template" onClick={() => setPrompt(t.text)}>
                  {t.label}
                </Tag>
              ))}
            </div>
          )}
          <Input.TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={mode === 'fusion' ? '例：把图2的涂鸦喷绘在图1的汽车上，保持图1的光影' : '描述想要的画面，中英文均可，越具体越好'}
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
                  if (!catalog.some((c) => c.provider === p && c.model === m)) {
                    message.warning('该模型不在当前目录中')
                    return
                  }
                  setActive({ provider: p, model: m })
                  saveSettings(p, m, size)
                }}
                disabled={busy}
                style={{ width: '100%' }}
                options={imageModels.map((m) => ({
                  value: modelKey(m.provider, m.model),
                  label: `${m.label}（${m.price}/张）`
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

          {/* 组图：wan2.7 系支持 enable_sequential，一次产出同角色的连续画面 */}
          {canBatch && (
            <div className="batch-row">
              <Space size={8}>
                <Switch size="small" checked={batchOn} onChange={setBatchOn} disabled={busy} />
                <Typography.Text style={{ fontSize: 13 }}>组图模式</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  一次产出同一角色的连续画面
                </Typography.Text>
              </Space>
              {batchOn && (
                <Select
                  size="small"
                  value={batchN}
                  onChange={setBatchN}
                  disabled={busy}
                  style={{ width: 96 }}
                  options={[2, 4, 6, 8, 12].map((v) => ({ value: v, label: `最多 ${v} 张` }))}
                />
              )}
            </div>
          )}

          <Button
            type="primary"
            icon={<SendOutlined />}
            size="large"
            block
            loading={busy}
            disabled={needKey || i2iUnsupported}
            onClick={() => void doGenerate()}
            className="gen-btn"
          >
            {busy ? `生成中… ${elapsed}s` : batchOn ? `生成组图（最多 ${batchN} 张）` : '生成'}
          </Button>
          {busy && (
            <Button
              size="large"
              style={{ marginInlineStart: 8 }}
              onClick={() => runIdRef.current && void window.api.cancelRun(runIdRef.current)}
            >
              取消
            </Button>
          )}
          <Typography.Text type="secondary" className="tip-text">
            Ctrl + Enter 快速生成 · 出图约 30~60 秒{estimate ? ` · 预估 ${estimate}` : ''}
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
                {providerLabel(provider, mc)} {active.model} · 已用 {elapsed} 秒
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
              {result.files && result.files.length > 1 && (
                <div className="batch-strip">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    组图共 {result.files.length} 张（已全部存入历史）：
                  </Typography.Text>
                  {result.files.map((f, idx) => (
                    <Tooltip key={f.file} title="查看这一张">
                      <img
                        src={`${f.url}?w=160`}
                        alt={`第${idx + 1}张`}
                        className={`batch-thumb${f.file === result.file ? ' active' : ''}`}
                        onClick={() => {
                          setResult({ ...result, file: f.file, url: f.url })
                          void window.api
                            .imageChain(f.file)
                            .then((items) => setChain({ items, idx: items.length - 1 }))
                            .catch(() => undefined)
                        }}
                      />
                    </Tooltip>
                  ))}
                </div>
              )}
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
                </Space>                <Space size={4} wrap>
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
                  <Tooltip title="局部重绘 / 擦除物体 / 去水印 / 超分 / 扩图 / 上色">
                    <Button size="small" icon={<HighlightOutlined />} onClick={() => setEditOpen(true)}>
                      图像编辑
                    </Button>
                  </Tooltip>
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
        <ImageEditModal
          open={editOpen}
          src={result?.url ?? null}
          name={result?.file}
          onClose={() => setEditOpen(false)}
          onDone={onEditDone}
        />
        <StyleLibrary open={styleOpen} onClose={() => setStyleOpen(false)} onPick={pickStyle} />
      </Col>
    </Row>
  )
}
