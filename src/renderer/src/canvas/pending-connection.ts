/**
 * pending 连线（P0-4）—— 拖动连线时的橡皮筋。
 *
 * 关键：拖动过程中**不走 React 重渲染**（每次 pointermove 触发整卡重渲染是原有卡顿来源），
 * 而是由 ConnectionLayer 注册 SVG 元素引用，这里直接改 `d` 属性（每帧一次 rAF 提交）。
 * React 只在 begin/end（挂载与卸载）时重渲染一次。
 */
import { connectionPath } from './connection-hit'

export interface PendingState {
  active: boolean
  fromNodeId: string
  /** 起点：源节点端口锚点（世界坐标） */
  from: { x: number; y: number }
  /** 终点：鼠标或吸附后的目标锚点（世界坐标） */
  to: { x: number; y: number }
  targetId: string | null
}

let state: PendingState | null = null
const listeners = new Set<() => void>()

let pathEl: SVGPathElement | null = null
let dotEl: SVGCircleElement | null = null
let highlightedId: string | null = null

function emit(): void {
  listeners.forEach((l) => l())
}

export function subscribePending(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function getPending(): PendingState | null {
  return state
}

/** ConnectionLayer 挂载时注册 SVG 元素，供热路径直接写属性 */
export function registerPendingElements(path: SVGPathElement | null, dot: SVGCircleElement | null): void {
  pathEl = path
  dotEl = dot
  if (state) paint(state)
}

function paint(s: PendingState): void {
  if (pathEl) pathEl.setAttribute('d', connectionPath(s.from, s.to))
  if (dotEl) {
    dotEl.setAttribute('cx', String(s.to.x))
    dotEl.setAttribute('cy', String(s.to.y))
  }
}

function setHighlight(targetId: string | null): void {
  if (highlightedId === targetId) return
  if (highlightedId) {
    document.querySelector(`[data-node-id="${highlightedId}"]`)?.classList.remove('ivc-node-drop')
  }
  highlightedId = targetId
  if (targetId) {
    document.querySelector(`[data-node-id="${targetId}"]`)?.classList.add('ivc-node-drop')
  }
}

export function beginPending(fromNodeId: string, from: { x: number; y: number }): void {
  state = { active: true, fromNodeId, from, to: { ...from }, targetId: null }
  emit() // React 挂载 pending path
}

/** 热路径：每帧调用，直接改 DOM，不触发 React */
export function updatePending(to: { x: number; y: number }, targetId: string | null): void {
  if (!state) return
  state = { ...state, to, targetId }
  paint(state)
  setHighlight(targetId)
}

export function endPending(): void {
  if (!state) return
  setHighlight(null)
  state = null
  emit() // React 卸载 pending path
}
