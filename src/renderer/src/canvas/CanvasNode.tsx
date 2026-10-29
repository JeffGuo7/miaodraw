/**
 * 画布节点渲染 — 移植改造自 basketikun/infinite-canvas（MIT）
 * https://github.com/basketikun/infinite-canvas
 * 原组件为 canvas-node.tsx（体量大、耦合生成/存储服务），M0 先落节点壳：
 * 六类内建节点 + 选中/拖拽/缩放，内容渲染在 M2/M3 逐类接能力。
 */
import { memo, useState } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { Button, Input, Progress, Select, message } from 'antd'
import { PlayCircleOutlined } from '@ant-design/icons'

import type { CanvasNodeData } from './types'
import { NODE_SPECS } from './types'
import { canvasStore } from './store'
import { runGenerateNode } from './generation'
import { runVideoNode, DEFAULT_VIDEO_SPEC, VIDEO_DURATIONS, VIDEO_RATIOS, VIDEO_RESOLUTIONS, ratioLabel, estimateVideoCost, normalizeVideoSpec, canAutoRetry } from './videoGeneration'
import { hitTestConnectionTarget, sourcePortAnchor, snapEndpoint } from './connection-hit'
import { clientToWorld, invalidateCanvasRect } from './rect-cache'
import { beginPending, endPending, updatePending } from './pending-connection'
import PlanCard from './PlanCard'

interface CanvasNodeProps {
  node: CanvasNodeData
  selected: boolean
}

const MIN_W = 120
const MIN_H = 60

function CanvasNodeView({ node, selected }: CanvasNodeProps): JSX.Element {
  // 渲染打点（C1 验收：对话滚动/收发时画布节点渲染增量必须为 0）
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __canvasNodeRenders?: number }
    w.__canvasNodeRenders = (w.__canvasNodeRenders ?? 0) + 1
  }
  const [pending, setPending] = useState(false)

  /** 拖动（P0-1）：rAF 合并，每帧一次 emit；位置按「初始位置 + 增量」算，不累积漂移 */
  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    // Shift 点选：增删选中，不进入拖动
    if (e.shiftKey) {
      canvasStore.toggleSelection(node.id)
      return
    }
    const before = canvasStore.getState().selectedIds
    const movingIds = before.includes(node.id) && before.length > 1 ? before : [node.id]
    if (!before.includes(node.id)) canvasStore.select(node.id)
    // 多选拖动：记录所有被选节点的起点，按同一增量平移
    const all = canvasStore.getState().nodes
    const origins = movingIds
      .map((id) => {
        const n = all.find((x) => x.id === id)
        return n ? { id: n.id, x: n.x, y: n.y } : null
      })
      .filter((o): o is { id: string; x: number; y: number } => !!o)
    const start = { x: e.clientX, y: e.clientY }
    const k = canvasStore.getState().viewport.k || 1
    let delta = { x: 0, y: 0 }
    let frame: number | null = null

    const flush = (): void => {
      frame = null
      // 每帧提交：拖动过程中位置可见；多选时一次提交全部被拖节点
      canvasStore.moveNodes(origins, delta.x / k, delta.y / k)
    }
    const move = (ev: PointerEvent): void => {
      delta = { x: ev.clientX - start.x, y: ev.clientY - start.y }
      if (frame === null) frame = requestAnimationFrame(flush)
    }
    const up = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      flush() // 收尾：确保末帧位置落库
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /** 缩放（同源热路径） */
  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    canvasStore.select(node.id)
    const origin = { w: node.width, h: node.height }
    const start = { x: e.clientX, y: e.clientY }
    const k = canvasStore.getState().viewport.k || 1
    let next = { w: node.width, h: node.height }
    let frame: number | null = null

    const flush = (): void => {
      frame = null
      canvasStore.applyNodeResize(node.id, Math.max(MIN_W, Math.round(next.w)), Math.max(MIN_H, Math.round(next.h)))
    }
    const move = (ev: PointerEvent): void => {
      next = { w: origin.w + (ev.clientX - start.x) / k, h: origin.h + (ev.clientY - start.y) / k }
      if (frame === null) frame = requestAnimationFrame(flush)
    }
    const up = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      flush()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /**
   * 连线（P0-4 + P0-5）：
   * - 起点用源节点端口真实世界坐标；终点吸附近处目标端口
   * - 热路径只改 SVG 属性（pending-connection 直接写 DOM），不触发整卡重渲染
   * - 命中判定走纯几何 hitTestConnectionTarget（屏幕像素按 1/k 补偿）
   */
  const onPortPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // 手势开始先校准一次容器 rect：视图切换/窗口移动后缓存可能过期（热路径仍只做算术）
    invalidateCanvasRect()
    const from = sourcePortAnchor(node)
    beginPending(node.id, from)
    setPending(true)
    let frame: number | null = null
    let client = { x: e.clientX, y: e.clientY }

    const flush = (): void => {
      frame = null
      const vp = canvasStore.getState().viewport
      const world = clientToWorld(client.x, client.y, vp)
      const hit = hitTestConnectionTarget(canvasStore.getState().nodes, world, { scale: vp.k, excludeId: node.id })
      const end = snapEndpoint(world, hit)
      updatePending({ x: end.x, y: end.y }, hit.nodeId)
    }
    const move = (ev: PointerEvent): void => {
      client = { x: ev.clientX, y: ev.clientY }
      if (frame === null) frame = requestAnimationFrame(flush)
    }
    const finish = (commit: boolean, ev?: PointerEvent): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      if (commit && ev) {
        client = { x: ev.clientX, y: ev.clientY }
        invalidateCanvasRect() // 落点判定前校准一次
        flush()
        const vp = canvasStore.getState().viewport
        const world = clientToWorld(client.x, client.y, vp)
        const hit = hitTestConnectionTarget(canvasStore.getState().nodes, world, { scale: vp.k, excludeId: node.id })
        if (hit.nodeId) {
          canvasStore.addConnection(node.id, hit.nodeId)
        } else {
          message.info('没落到节点上，已取消连线')
        }
      }
      endPending()
      setPending(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
    const up = (ev: PointerEvent): void => finish(true, ev)
    const cancel = (): void => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  return (
    <div
      data-node-id={node.id}
      className={`ivc-node${selected ? ' ivc-node-selected' : ''}${node.type === 'group' ? ' ivc-node-group' : ''}${pending ? ' ivc-node-connecting' : ''}`}
      style={{ transform: `translate3d(${node.x}px, ${node.y}px, 0)`, width: node.width, height: node.height, zIndex: node.zIndex }}
      onPointerDown={() => canvasStore.select(node.id)}
    >
      <div className="ivc-node-header ivc-no-zoom" onPointerDown={onHeaderPointerDown}>
        <span className="ivc-node-dot" data-type={node.type} />
        <span className="ivc-node-title">{NODE_SPECS[node.type].title}</span>
        {selected && (
          <button
            className="ivc-node-del"
            title="删除节点"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => canvasStore.removeNode(node.id)}
          >
            ×
          </button>
        )}
      </div>
      <div className="ivc-node-body ivc-no-zoom">{renderBody(node)}</div>
      {selected && <div className="ivc-node-resize" onPointerDown={onResizePointerDown} />}
      {/* 连线端口（右侧中部）：拖到目标节点建立连线 */}
      <div
        className="ivc-node-port"
        title="拖到目标节点连线"
        onPointerDown={onPortPointerDown}
        data-port-from={node.id}
      />
    </div>
  )
}

function renderBody(node: CanvasNodeData): JSX.Element {
  switch (node.type) {
    case 'text':
      return (
        <textarea
          className="ivc-textarea"
          placeholder="输入文本…"
          value={String(node.metadata.content ?? '')}
          onChange={(e) => canvasStore.updateNode(node.id, { metadata: { ...node.metadata, content: e.target.value } })}
        />
      )
    case 'image':
      return <ImageBody node={node} />
    case 'video':
      return <VideoBody node={node} />
    case 'audio':
      return <div className="ivc-placeholder">音频节点 · 待接入 TTS</div>
    case 'config':
      return <div className="ivc-placeholder">配置节点 · 备用</div>
    case 'generate':
      return <GenerateBody node={node} />
    case 'group':
      return <div className="ivc-placeholder">分组容器 · 拖入内容自动归组（后续）</div>
    case 'plan':
      return String(node.metadata.planId ?? '') ? <PlanCard planId={String(node.metadata.planId)} /> : <div className="ivc-placeholder">计划卡（未绑定计划）</div>
    default:
      return <div className="ivc-placeholder">未知节点</div>
  }
}

function ImageBody({ node }: { node: CanvasNodeData }): JSX.Element {  const url = String(node.metadata.content ?? '')
  if (url) return <img className="ivc-img" src={url} alt="" draggable={false} />
  return (
    <label className="ivc-placeholder ivc-upload">
      <input
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (!f) return
          const reader = new FileReader()
          reader.onload = () => canvasStore.updateNode(node.id, { metadata: { ...node.metadata, content: String(reader.result) } })
          reader.readAsDataURL(f)
        }}
      />
      点击或拖入图片
    </label>
  )
}

const SIZE_OPTIONS = ['1024x1024', '768x1024', '1024x768', '720x1280', '1280x720']

/** 出图节点主体：提示词 + 尺寸 + 生成（连线进来的图片卡即参考图） */
function GenerateBody({ node }: { node: CanvasNodeData }): JSX.Element {
  const running = Boolean(node.metadata.running)
  const upstream = canvasStore.upstreamOf(node.id).filter((n) => n.type === 'image' && n.metadata.content)
  return (
    <div className="ivc-gen">
      <Input.TextArea
        className="ivc-gen-prompt"
        placeholder="描述想要的画面…"
        value={String(node.metadata.prompt ?? '')}
        disabled={running}
        onChange={(e) => canvasStore.updateNode(node.id, { metadata: { ...node.metadata, prompt: e.target.value } })}
      />
      {upstream.length > 0 && <div className="ivc-gen-refs">参考图 ×{upstream.length}（i2i）</div>}
      <div className="ivc-gen-row">
        <Select
          size="small"
          style={{ flex: 1 }}
          value={String(node.metadata.size ?? '1024x1024')}
          disabled={running}
          options={SIZE_OPTIONS.map((s) => ({ value: s, label: s }))}
          onChange={(v) => canvasStore.updateNode(node.id, { metadata: { ...node.metadata, size: v } })}
        />
        <Button
          size="small"
          type="primary"
          icon={<PlayCircleOutlined />}
          loading={running}
          onClick={() => void runGenerateNode(node.id)}
        >
          生成
        </Button>
      </div>
      {node.metadata.error ? <div className="ivc-gen-error">{String(node.metadata.error)}</div> : null}
    </div>
  )
}

/** 视频生产节点主体（M3）：有产物内容时是视频卡片，否则是生产者配置面板 */
function VideoBody({ node }: { node: CanvasNodeData }): JSX.Element {
  const content = String(node.metadata.content ?? '')
  if (content) {
    return (
      <div className="ivc-video-wrap">
        <video className="ivc-video" src={content} controls preload="metadata" />
      </div>
    )
  }
  const running = Boolean(node.metadata.running)
  const status = node.metadata.status ? String(node.metadata.status) : ''
  const progress = typeof node.metadata.progress === 'number' ? Math.round(node.metadata.progress * 100) : null
  const upstreamText = canvasStore.upstreamOf(node.id).filter((n) => n.type === 'text' && String(n.metadata.content ?? '').trim())

  // V1 成本护栏：档位来自节点，预估价实时显示；连续失败 2 次后需人工确认
  const duration = Number(node.metadata.duration ?? DEFAULT_VIDEO_SPEC.duration) || DEFAULT_VIDEO_SPEC.duration
  const ratio = String(node.metadata.ratio ?? DEFAULT_VIDEO_SPEC.ratio)
  const resolution = String(node.metadata.resolution ?? DEFAULT_VIDEO_SPEC.resolution)
  const failCount = Number(node.metadata.failCount ?? 0) || 0
  const estimate = estimateVideoCost(normalizeVideoSpec({ prompt: 'x', duration, ratio, resolution }))
  const guardBlocked = !canAutoRetry(failCount)

  return (
    <div className="ivc-gen">
      {upstreamText.length === 0 && (
        <Input.TextArea
          className="ivc-gen-prompt"
          placeholder="输入视频提示词（或连线一张文案卡）…"
          value={String(node.metadata.prompt ?? '')}
          disabled={running}
          onChange={(e) => canvasStore.updateNode(node.id, { metadata: { ...node.metadata, prompt: e.target.value } })}
        />
      )}
      {upstreamText.length > 0 && <div className="ivc-gen-refs">文案卡 ×{upstreamText.length}（已连线）</div>}
      <div className="ivc-video-opts">
        <Select
          size="small"
          value={duration}
          disabled={running}
          data-video-duration={duration}
          options={VIDEO_DURATIONS.map((d) => ({ value: d, label: `${d} 秒` }))}
          onChange={(v) => canvasStore.updateNode(node.id, { metadata: { ...node.metadata, duration: v } })}
        />
        <Select
          size="small"
          value={ratio}
          disabled={running}
          options={VIDEO_RATIOS.map((r) => ({ value: r, label: ratioLabel(r) }))}
          onChange={(v) => canvasStore.updateNode(node.id, { metadata: { ...node.metadata, ratio: v } })}
        />
        <Select
          size="small"
          value={resolution}
          disabled={running}
          options={VIDEO_RESOLUTIONS.map((q) => ({ value: q, label: q }))}
          onChange={(v) => canvasStore.updateNode(node.id, { metadata: { ...node.metadata, resolution: v } })}
        />
      </div>
      <div className="ivc-video-cost" data-video-cost={estimate.cny.toFixed(2)}>
        预估价 ¥{estimate.cny.toFixed(2)}（{duration} 秒 · {resolution}，以账单为准）
      </div>
      {guardBlocked && (
        <div className="ivc-gen-error" data-video-guard="blocked">
          已连续失败 {failCount} 次，成本护栏已停止自动重试（再点需人工确认）
        </div>
      )}
      <Button
        size="small"
        type="primary"
        icon={<PlayCircleOutlined />}
        loading={running}
        data-video-run="true"
        onClick={() => void runVideoNode(node.id)}
      >
        {running ? status || '生成中…' : node.metadata.error ? '重试' : '生成成片'}
      </Button>
      {running && <Progress size="small" percent={progress != null ? progress : undefined} status="active" format={() => status} />}
      {node.metadata.error ? <div className="ivc-gen-error">{String(node.metadata.error)}</div> : null}
      {node.metadata.taskId && !running ? <div className="ivc-gen-refs">任务 {String(node.metadata.taskId)}</div> : null}
    </div>
  )
}

/**
 * 节点级 memo：拖动/选中只重渲染受影响的节点。
 * 判定用节点对象引用——store 的 updateNode/applyNodeMove 只替换被改的那个节点对象，
 * 其余节点引用不变，因此可以跳过渲染（此前拖动一个节点会重建整张画布的所有节点）。
 */
export const CanvasNode = memo(CanvasNodeView)
