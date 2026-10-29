/**
 * 画布撤销/重做（history）—— 快照式，零依赖。
 *
 * 设计取舍（对照 Excalidraw history.ts / tldraw diffs+marks / 上游 infinite-canvas past/future）：
 * - 用「整体快照」而不是 diff：画布节点规模小（<200），快照成本可控，换来实现与调试成本极低
 * - 变更检测靠 store 数组引用：任何 mutation 都会换新数组，引用比较即知是否有变化
 * - 250ms 防抖合并：连续拖动/打字算一次操作（一次交互 = 一条 undo）
 * - 上限 50 条，超出丢最旧；undo/redo 期间用 restoring 标记避免把恢复动作再记录进去
 */
import { canvasStore, subscribeAny } from './store'
import type { CanvasConnection, CanvasNodeData } from './types'

interface Snapshot {
  nodes: CanvasNodeData[]
  connections: CanvasConnection[]
}

const LIMIT = 50
const MERGE_MS = 250

let past: Snapshot[] = []
let future: Snapshot[] = []
let baseline: Snapshot | null = null
let lastNodes: CanvasNodeData[] | null = null
let lastConnections: CanvasConnection[] | null = null
let timer: number | null = null
let restoring = false
let started = false

const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

function snap(): Snapshot {
  const s = canvasStore.getState()
  return {
    nodes: s.nodes.map((n) => ({ ...n, metadata: { ...n.metadata } })),
    connections: s.connections.map((c) => ({ ...c }))
  }
}

function track(): void {
  const s = canvasStore.getState()
  lastNodes = s.nodes
  lastConnections = s.connections
}

function commit(): void {
  if (timer) {
    window.clearTimeout(timer)
    timer = null
  }
  const s = canvasStore.getState()
  if (s.nodes === lastNodes && s.connections === lastConnections) return
  if (baseline) {
    past.push(baseline)
    if (past.length > LIMIT) past.shift()
  }
  future = []
  baseline = snap()
  track()
  emit()
}

function schedule(): void {
  if (restoring) return
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    commit()
  }, MERGE_MS)
}

function apply(snapshot: Snapshot): void {
  restoring = true
  canvasStore.restore(snapshot)
  baseline = snap()
  track()
  restoring = false
  emit()
}

export function attachHistory(): () => void {
  if (started) return () => undefined
  started = true
  baseline = snap()
  track()
  const off = subscribeAny(schedule)
  return () => {
    off()
    if (timer) window.clearTimeout(timer)
    started = false
  }
}

export function undo(): boolean {
  commit() // 先把未提交的变更落进 past，避免丢掉最后一步
  const target = past.pop()
  if (!target) return false
  future.push(snap())
  apply(target)
  return true
}

export function redo(): boolean {
  const target = future.pop()
  if (!target) return false
  past.push(snap())
  apply(target)
  return true
}

export function canUndo(): boolean {
  return past.length > 0
}

export function canRedo(): boolean {
  return future.length > 0
}

export function subscribeHistory(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function historyDepth(): { past: number; future: number } {
  return { past: past.length, future: future.length }
}
