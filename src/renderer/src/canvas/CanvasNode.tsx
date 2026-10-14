/**
 * 画布节点渲染 — 移植改造自 basketikun/infinite-canvas（MIT）
 * https://github.com/basketikun/infinite-canvas
 * 原组件为 canvas-node.tsx（体量大、耦合生成/存储服务），M0 先落节点壳：
 * 六类内建节点 + 选中/拖拽/缩放，内容渲染在 M2/M3 逐类接能力。
 */
import { useRef } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'

import type { CanvasNodeData } from './types'
import { NODE_SPECS } from './types'
import { canvasStore } from './store'

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
      return <div className="ivc-placeholder">视频节点 · M3 接 Pixelle 管线</div>
    case 'audio':
      return <div className="ivc-placeholder">音频节点 · 待接入 TTS</div>
    case 'config':
      return <div className="ivc-placeholder">配置节点 · M2 接生成参数</div>
    case 'group':
      return <div className="ivc-placeholder">分组容器 · 拖入内容自动归组（后续）</div>
    default:
      return <div className="ivc-placeholder">未知节点</div>
  }
}

function ImageBody({ node }: { node: CanvasNodeData }): JSX.Element {
  const url = String(node.metadata.content ?? '')
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
