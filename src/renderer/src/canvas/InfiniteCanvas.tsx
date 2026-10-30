/**
 * 画布引擎 — 移植自 basketikun/infinite-canvas（MIT）
 * https://github.com/basketikun/infinite-canvas
 * 原 src/components/canvas/infinite-canvas.tsx，适配 miaodraw（无 tailwind，样式走 canvas.css）。
 * 保留原作者信息与前端标识，此文件头部即署名。
 */
import React, { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

import type { ViewportTransform } from './types'
import { canvasStore } from './store'
import { attachCanvasRect, getCanvasRect } from './rect-cache'

export type CanvasTool = 'select' | 'pan'

interface InfiniteCanvasProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  viewport: ViewportTransform
  tool: CanvasTool
  onViewportChange: (vp: ViewportTransform) => void
  onCanvasMouseDown?: (e: React.PointerEvent<HTMLDivElement>) => void
  onCanvasDeselect?: () => void
  onCanvasDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void
  children: React.ReactNode
}

const MIN_SCALE = 0.05
const MAX_SCALE = 5

/**
 * 安全地捕获指针。
 * setPointerCapture 在「没有该 id 的活跃指针」时会抛 NotFoundError（合成事件、部分触控笔/远程桌面
 * 输入、指针已释放的竞态）。捕获失败不影响后续拖拽/框选逻辑，所以绝不能让它中断交互。
 */
function capturePointer(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId)
  } catch {
    // 忽略：没有捕获也能靠 window 上的 pointermove/pointerup 完成交互
  }
}

export function InfiniteCanvas({
  containerRef,
  viewport,
  tool,
  onViewportChange,
  onCanvasMouseDown,
  onCanvasDeselect,
  onCanvasDoubleClick,
  onContextMenu,
  onDrop,
  children
}: InfiniteCanvasProps): JSX.Element {
  const panState = useRef({ isPanning: false, startX: 0, startY: 0, initialX: 0, initialY: 0, hasMoved: false, startedOnBackground: false })
  const scaleRef = useRef(viewport.k)
  const frameRef = useRef<number | null>(null)
  const nextViewportRef = useRef<ViewportTransform | null>(null)
  /** 滚轮累加：同一帧内多次 wheel 只提交一次，避免连续滚轮互相覆盖与整页多次重渲染 */
  const wheelRef = useRef<{ k: number; mx: number; my: number } | null>(null)
  const wheelRaf = useRef<number | null>(null)
  const [spacePressed, setSpacePressed] = useState(false)
  const [ctrlPressed, setCtrlPressed] = useState(false)
  const [panning, setPanning] = useState(false)

  useEffect(() => {
    scaleRef.current = viewport.k
  }, [viewport.k])

  // P0-3：容器 rect 由 ResizeObserver 缓存维护，拖动/连线热路径不再每帧查询 DOM
  useEffect(() => {
    attachCanvasRect(containerRef.current)
    return () => attachCanvasRect(null)
  }, [containerRef])

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      if (wheelRaf.current) cancelAnimationFrame(wheelRaf.current)
    },
    []
  )

  useEffect(() => {
    const isFormTarget = (t: EventTarget | null): boolean => {
      const el = t instanceof Element ? t : null
      return !!(el?.closest("input,textarea,select,[contenteditable='true']"))
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Control') setCtrlPressed(true)
      if (e.code !== 'Space') return
      if (isFormTarget(e.target)) return
      e.preventDefault()
      setSpacePressed(true)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        if (!isFormTarget(e.target)) e.preventDefault()
        setSpacePressed(false)
      }
      if (e.key === 'Control') setCtrlPressed(false)
    }
    const onBlur = (): void => {
      setSpacePressed(false)
      setCtrlPressed(false)
      panState.current.isPanning = false
      setPanning(false)
      document.body.style.cursor = ''
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const el = e.target instanceof Element ? e.target : null
    if (el?.closest('.ivc-no-zoom')) return

    // 读 store 最新视口（props 可能同帧过期）；deltaMode/ctrl 归一化参考 d3-zoom 的 defaultWheelDelta：
    // 触控板 pinch 表现为 ctrl+wheel 的小 delta，需要放大 10 倍才有等价手感。
    const vp = canvasStore.getState().viewport
    const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002
    const delta = -e.deltaY * unit * (e.ctrlKey ? 10 : 1)
    const prevK = wheelRef.current?.k ?? vp.k
    const nextK = Math.min(Math.max(prevK * Math.pow(2, delta), MIN_SCALE), MAX_SCALE)
    const rect = getCanvasRect()
    wheelRef.current = { k: nextK, mx: e.clientX - rect.left, my: e.clientY - rect.top }
    if (wheelRaf.current) return
    wheelRaf.current = requestAnimationFrame(() => {
      wheelRaf.current = null
      const pending = wheelRef.current
      wheelRef.current = null
      if (!pending) return
      const cur = canvasStore.getState().viewport
      if (pending.k === cur.k) return
      const worldX = (pending.mx - cur.x) / cur.k
      const worldY = (pending.my - cur.y) / cur.k
      onViewportChange({ x: pending.mx - worldX * pending.k, y: pending.my - worldY * pending.k, k: pending.k })
    })
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.target instanceof Element ? e.target : null
    if (el?.closest('.ivc-no-zoom')) return
    const isBackgroundClick = !el?.closest('[data-node-id],[data-connection-id]')
    const temporaryPan = e.ctrlKey || spacePressed
    const activeTool: CanvasTool = temporaryPan ? (tool === 'select' ? 'pan' : 'select') : tool
    const shouldPan = e.button === 1 || (e.button === 0 && activeTool === 'pan' && isBackgroundClick)

    if (shouldPan) {
      e.preventDefault()
      capturePointer(e.currentTarget, e.pointerId)
      panState.current = { isPanning: true, startX: e.clientX, startY: e.clientY, initialX: viewport.x, initialY: viewport.y, hasMoved: false, startedOnBackground: isBackgroundClick }
      setPanning(true)
      document.body.style.cursor = 'grabbing'
      return
    }

    if (e.button === 0 && isBackgroundClick) {
      e.preventDefault()
      capturePointer(e.currentTarget, e.pointerId)
      onCanvasMouseDown?.(e)
    }
  }

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = e.target instanceof Element ? e.target : null
    if (el?.closest('.ivc-no-zoom,[data-node-id],[data-connection-id]')) return
    onCanvasDoubleClick?.(e)
  }

  useEffect(() => {
    const onPointerMove = (e: PointerEvent): void => {
      if (!panState.current.isPanning) return
      const dx = e.clientX - panState.current.startX
      const dy = e.clientY - panState.current.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.current.hasMoved = true
      nextViewportRef.current = { x: panState.current.initialX + dx, y: panState.current.initialY + dy, k: scaleRef.current }
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        if (nextViewportRef.current) onViewportChange(nextViewportRef.current)
      })
    }
    const onPointerUp = (): void => {
      if (!panState.current.isPanning) return
      if (!panState.current.hasMoved && panState.current.startedOnBackground) onCanvasDeselect?.()
      panState.current.isPanning = false
      setPanning(false)
      document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [onCanvasDeselect, onViewportChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const preventWheel = (e: WheelEvent): void => {
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest('.ivc-no-zoom')) return
      e.preventDefault()
    }
    container.addEventListener('wheel', preventWheel, { passive: false })
    return () => container.removeEventListener('wheel', preventWheel)
  }, [containerRef])

  const temporaryPan = ctrlPressed || spacePressed
  const activeTool: CanvasTool = temporaryPan ? (tool === 'select' ? 'pan' : 'select') : tool
  const cursor = panning ? 'grabbing' : activeTool === 'pan' ? 'grab' : undefined

  return (
    <div
      ref={containerRef}
      className="ivc-root"
      style={{ cursor }}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
      onContextMenu={onContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <CanvasGrid viewport={viewport} />
      <div className="ivc-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}>
        {children}
      </div>
    </div>
  )
}

/** 点阵网格背景（对应原 CanvasGrid dots 模式） */
function CanvasGrid({ viewport }: { viewport: ViewportTransform }): JSX.Element {
  const gridSize = 48 * viewport.k
  const x = viewport.x % gridSize
  const y = viewport.y % gridSize
  const dotSize = viewport.k < 0.12 ? 0.8 : 1.15
  return (
    <div
      className="ivc-grid"
      style={{
        backgroundImage: `radial-gradient(circle, rgba(100,116,139,.55) ${dotSize}px, transparent ${dotSize + 0.2}px)`,
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${x}px ${y}px`
      }}
    />
  )
}

// re-export for workbench convenience
export { canvasStore }
