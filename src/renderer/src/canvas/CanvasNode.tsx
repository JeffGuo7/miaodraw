/**
 * 画布节点渲染 — 移植改造自 basketikun/infinite-canvas（MIT）
 * https://github.com/basketikun/infinite-canvas
 * 原组件为 canvas-node.tsx（体量大、耦合生成/存储服务），M0 先落节点壳：
 * 六类内建节点 + 选中/拖拽/缩放，内容渲染在 M2/M3 逐类接能力。
 */
import { useRef, useState } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { Button, Input, Select, message } from 'antd'
import { PlayCircleOutlined } from '@ant-design/icons'

import type { CanvasNodeData } from './types'
import { NODE_SPECS } from './types'
import { canvasStore } from './store'
import { runGenerateNode } from './generation'

interface CanvasNodeProps {
  node: CanvasNodeData
  selected: boolean
  scale: number
}

const MIN_W = 120
const MIN_H = 60

export function CanvasNode({ node, selected, scale }: CanvasNodeProps): JSX.Element {
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; ow: number; oh: number } | null>(null)
  const [pendingFrom, setPendingFrom] = useState<{ x: number; y: number } | null>(null)

  /** 从右侧连线端口拖出 → 落到目标节点上建立连线 */
  const onPortPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const worldStart = { x: node.x + node.width, y: node.y + node.height / 2 }
    setPendingFrom(worldStart)
    let last = worldStart
    const move = (ev: PointerEvent): void => {
      const st = canvasStore.getState().viewport
      last = {
        x: (ev.clientX - (containerLeft() ?? 0) - st.x) / st.k,
        y: (ev.clientY - (containerTop() ?? 0) - st.y) / st.k
      }
      setPendingFrom({ ...last })
    }
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setPendingFrom(null)
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const targetEl = el?.closest('[data-node-id]')
      const targetId = targetEl?.getAttribute('data-node-id')
      if (targetId && targetId !== node.id) {
        canvasStore.addConnection(node.id, targetId)
        message.success('已连线：上游内容将作为下游输入')
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    canvasStore.select(node.id)
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: node.x, oy: node.y }
    const move = (ev: PointerEvent): void => {
      if (!dragRef.current) return
      canvasStore.moveNodeSilent(node.id, {
        x: Math.round(dragRef.current.ox + (ev.clientX - dragRef.current.startX) / scale),
        y: Math.round(dragRef.current.oy + (ev.clientY - dragRef.current.startY) / scale)
      })
    }
    const up = (): void => {
      dragRef.current = null
      canvasStore.commit()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    canvasStore.select(node.id)
    resizeRef.current = { startX: e.clientX, startY: e.clientY, ow: node.width, oh: node.height }
    const move = (ev: PointerEvent): void => {
      if (!resizeRef.current) return
      canvasStore.moveNodeSilent(node.id, {
        width: Math.max(MIN_W, Math.round(resizeRef.current.ow + (ev.clientX - resizeRef.current.startX) / scale)),
        height: Math.max(MIN_H, Math.round(resizeRef.current.oh + (ev.clientY - resizeRef.current.startY) / scale))
      })
    }
    const up = (): void => {
      resizeRef.current = null
      canvasStore.commit()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      data-node-id={node.id}
      className={`ivc-node${selected ? ' ivc-node-selected' : ''}${node.type === 'group' ? ' ivc-node-group' : ''}`}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height, zIndex: node.zIndex }}
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
      {pendingFrom && <PendingLine from={worldOrigin()} to={pendingFrom} />}
    </div>
  )
}

function containerLeft(): number | null {
  return document.querySelector<HTMLElement>('.ivc-root')?.getBoundingClientRect().left ?? null
}
function containerTop(): number | null {
  return document.querySelector<HTMLElement>('.ivc-root')?.getBoundingClientRect().top ?? null
}
function worldOrigin(): { x: number; y: number } {
  return { x: 0, y: 0 }
}

/** 拖拽中的临时连线（世界坐标层内的绝对定位线段，随节点层一起缩放） */
function PendingLine({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }): JSX.Element {
  const x1 = Math.min(from.x, to.x)
  const y1 = Math.min(from.y, to.y)
  const w = Math.abs(to.x - from.x) || 1
  const h = Math.abs(to.y - from.y) || 1
  return (
    <svg className="ivc-pending-line" style={{ left: x1, top: y1, width: w, height: h }}>
      <line
        x1={from.x <= to.x ? 0 : w}
        y1={from.y <= to.y ? 0 : h}
        x2={from.x <= to.x ? w : 0}
        y2={from.y <= to.y ? h : 0}
        stroke="#4096ff"
        strokeWidth={2}
        strokeDasharray="6 4"
      />
    </svg>
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
      return <div className="ivc-placeholder">视频节点 · M3 接 Pixelle 管线</div>
    case 'audio':
      return <div className="ivc-placeholder">音频节点 · 待接入 TTS</div>
    case 'config':
      return <div className="ivc-placeholder">配置节点 · 备用</div>
    case 'generate':
      return <GenerateBody node={node} />
    case 'group':
      return <div className="ivc-placeholder">分组容器 · 拖入内容自动归组（后续）</div>
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
