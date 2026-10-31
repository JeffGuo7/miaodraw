/**
 * 画布引擎 — 移植自 basketikun/infinite-canvas（MIT）
 * https://github.com/basketikun/infinite-canvas
 * 原 src/components/canvas/infinite-canvas.tsx，适配 miaodraw（无 tailwind，样式走 canvas.css）。
 * 保留原作者信息与前端标识，此文件头部即署名。
 *
 * 本文件只负责「视口」：滚轮/平移/网格/指针路由。节点、连线、菜单都在外层。
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'

import type { ViewportTransform } from './types'
import { canvasStore } from './store'
import { attachCanvasRect, getCanvasRect } from './rect-cache'
import { getCanvasPrefs, subscribeCanvasPrefs, type CanvasBackgroundMode } from './canvas-prefs'
import { resolveWheelIntent, wheelDeltaToPixels, wheelZoomFactor, type WheelGesture } from './canvas-wheel'

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
 * 浮层白名单：AntD 的下拉/气泡/弹窗都通过 Portal 挂到 body，事件冒泡仍会经过画布容器。
 * 不排除的话，在下拉里滚轮会缩放画布、按下会开始平移画布（旧实现的真实 bug）。
 */
const OVERLAY_IGNORE_SELECTOR = [
  '.ivc-no-zoom',
  '.ant-modal-root',
  '.ant-popover',
  '.ant-dropdown',
  '.ant-select-dropdown',
  '.ant-picker-dropdown',
  '.ant-tooltip',
  '.ant-message'
].join(',')

function isOverlayTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null
  return Boolean(el?.closest(OVERLAY_IGNORE_SELECTOR))
}

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
  const vpRef = useRef(viewport)
  const pendingRef = useRef<ViewportTransform | null>(null)
  const frameRef = useRef<number | null>(null)
  const gestureRef = useRef<WheelGesture | null>(null)
  const [spacePressed, setSpacePressed] = useState(false)
  const [panning, setPanning] = useState(false)
  const prefs = useSyncExternalStore(subscribeCanvasPrefs, getCanvasPrefs)

  useEffect(() => {
    vpRef.current = viewport
  }, [viewport])

  // 容器 rect 由 ResizeObserver 缓存维护，拖动/连线热路径不再每帧查询 DOM
  useEffect(() => {
    attachCanvasRect(containerRef.current)
    return () => attachCanvasRect(null)
  }, [containerRef])

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  /** 同一帧只提交一次视口变更：连续滚轮/拖动不会互相覆盖，也不会让 React 每帧重渲染整棵树 */
  const scheduleViewport = (vp: ViewportTransform): void => {
    pendingRef.current = vp
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const next = pendingRef.current
      pendingRef.current = null
      if (next) onViewportChange(next)
    })
  }

  const currentViewport = (): ViewportTransform => pendingRef.current ?? vpRef.current

  useEffect(() => {
    const isFormTarget = (t: EventTarget | null): boolean => {
      const el = t instanceof Element ? t : null
      return !!(el?.closest("input,textarea,select,[contenteditable='true']"))
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      if (isFormTarget(e.target)) return
      // 空格已被别处消费（例如打开了浮层）就不再抢占
      e.preventDefault()
      setSpacePressed(true)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      if (!isFormTarget(e.target)) e.preventDefault()
      setSpacePressed(false)
    }
    const onBlur = (): void => {
      setSpacePressed(false)
      panState.current.isPanning = false
      setPanning(false)
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

  /** 滚轮：先判意图（缩放 / 平移），再按 1/k 反解锚点 */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent): void => {
      if (isOverlayTarget(e.target)) return
      // 画布内一律接管：既避免浏览器整页缩放，也避免触控板横向手势被当成「后退」
      e.preventDefault()
      const now = performance.now()
      const intent = resolveWheelIntent(e, gestureRef.current, now, prefs.wheelBehavior)
      gestureRef.current = { intent, at: now }
      const dx = wheelDeltaToPixels(e.deltaX, e.deltaMode)
      const dy = wheelDeltaToPixels(e.deltaY, e.deltaMode)
      const vp = currentViewport()

      if (intent === 'pan') {
        scheduleViewport({ x: vp.x - dx, y: vp.y - dy, k: vp.k })
        return
      }
      const rect = getCanvasRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const k = Math.min(Math.max(vp.k * wheelZoomFactor(dy, e.ctrlKey || e.metaKey), MIN_SCALE), MAX_SCALE)
      if (k === vp.k) return
      const worldX = (mx - vp.x) / vp.k
      const worldY = (my - vp.y) / vp.k
      scheduleViewport({ x: mx - worldX * k, y: my - worldY * k, k })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [containerRef, prefs.wheelBehavior])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (isOverlayTarget(e.target)) return
    const el = e.target instanceof Element ? e.target : null
    const isBackgroundClick = !el?.closest('[data-node-id],[data-connection-id]')
    // 中键永远是平移；空格临时切平移；工具选抓手时左键平移
    const shouldPan = e.button === 1 || (e.button === 0 && (spacePressed || (tool === 'pan' && isBackgroundClick)))

    if (shouldPan) {
      e.preventDefault()
      capturePointer(e.currentTarget, e.pointerId)
      const vp = canvasStore.getState().viewport
      panState.current = {
        isPanning: true,
        startX: e.clientX,
        startY: e.clientY,
        initialX: vp.x,
        initialY: vp.y,
        hasMoved: false,
        startedOnBackground: isBackgroundClick
      }
      setPanning(true)
      return
    }

    if (e.button === 0 && isBackgroundClick) {
      e.preventDefault()
      capturePointer(e.currentTarget, e.pointerId)
      onCanvasMouseDown?.(e)
    }
  }

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (isOverlayTarget(e.target)) return
    const el = e.target instanceof Element ? e.target : null
    if (el?.closest('[data-node-id],[data-connection-id]')) return
    onCanvasDoubleClick?.(e)
  }

  useEffect(() => {
    const onPointerMove = (e: PointerEvent): void => {
      if (!panState.current.isPanning) return
      const dx = e.clientX - panState.current.startX
      const dy = e.clientY - panState.current.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.current.hasMoved = true
      scheduleViewport({ x: panState.current.initialX + dx, y: panState.current.initialY + dy, k: vpRef.current.k })
    }
    const onPointerUp = (): void => {
      if (!panState.current.isPanning) return
      if (!panState.current.hasMoved && panState.current.startedOnBackground) onCanvasDeselect?.()
      panState.current.isPanning = false
      setPanning(false)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [onCanvasDeselect])

  const activeTool: CanvasTool = spacePressed ? (tool === 'select' ? 'pan' : 'select') : tool
  const rootClass = [
    'ivc-root',
    panning ? 'is-panning' : '',
    !panning && activeTool === 'pan' ? 'is-pan-tool' : '',
    panning ? 'is-interacting' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={containerRef}
      className={rootClass}
      data-ivc-tool={activeTool}
      data-ivc-panning={panning ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <CanvasGrid viewport={viewport} mode={prefs.backgroundMode} />
      <div
        className="ivc-world"
        style={{ transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k})` }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * 画布网格（点阵 / 线条 / 空白）。
 *
 * 间距策略：世界对齐 + 屏幕间距量化在 20–80px 之间。
 * 纯「随缩放线性变化」在 k=0.1 时会退化成 4.8px 的摩尔纹，纯「屏幕固定」又失去尺度感；
 * 量化取 32 世界像素的 2^n 倍，两个诉求都能满足。
 */
function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }): JSX.Element | null {
  if (mode === 'blank') return null
  const k = viewport.k > 0 ? viewport.k : 1
  let spacing = 32 * k
  while (spacing < 20) spacing *= 2
  while (spacing > 80) spacing /= 2
  const x = ((viewport.x % spacing) + spacing) % spacing
  const y = ((viewport.y % spacing) + spacing) % spacing
  const dot = k < 0.2 ? 0.9 : 1.2
  const backgroundImage =
    mode === 'lines'
      ? 'linear-gradient(var(--ivc-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--ivc-grid-line) 1px, transparent 1px)'
      : `radial-gradient(circle, var(--ivc-grid-dot) ${dot}px, transparent ${dot + 0.3}px)`
  return (
    <div
      className="ivc-grid"
      data-grid-mode={mode}
      style={{
        backgroundImage,
        backgroundSize: `${spacing}px ${spacing}px`,
        backgroundPosition: `${x}px ${y}px`
      }}
    />
  )
}

// re-export for workbench convenience
export { canvasStore }
