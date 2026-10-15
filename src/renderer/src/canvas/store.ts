/**
 * 画布状态存储 — 轻量自写（useSyncExternalStore），零新依赖。
 * 后续 M1 数据层升级时此模块是唯一改动点。
 */
import { useSyncExternalStore } from 'react'

import type { CanvasConnection, CanvasNodeData, CanvasNodeType, ViewportTransform } from './types'
import { NODE_SPECS } from './types'

export interface CanvasState {
  nodes: CanvasNodeData[]
  connections: CanvasConnection[]
  viewport: ViewportTransform
  selectedIds: string[]
  zCounter: number
}

let state: CanvasState = {
  nodes: [],
  connections: [],
  viewport: { x: 80, y: 80, k: 1 },
  selectedIds: [],
  zCounter: 1
}

const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

function set(patch: Partial<CanvasState>): void {
  state = { ...state, ...patch }
  emit()
}

export const canvasStore = {
  getState: (): CanvasState => state,

  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => listeners.delete(l)
  },

  setViewport(vp: ViewportTransform): void {
    set({ viewport: vp })
  },

  addNode(type: CanvasNodeType, at?: { x: number; y: number }): string {
    const spec = NODE_SPECS[type]
    const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const vp = state.viewport
    const x = at?.x ?? (-vp.x + vp.k > 0 ? (window.innerWidth / 2 - vp.x) / vp.k - spec.width / 2 : spec.width)
    const y = at?.y ?? (window.innerHeight / 2 - vp.y) / vp.k - spec.height / 2
    const node: CanvasNodeData = {
      id,
      type,
      x: Math.round(x),
      y: Math.round(y),
      width: spec.width,
      height: spec.height,
      metadata: JSON.parse(JSON.stringify(spec.metadata)),
      zIndex: state.zCounter + 1
    }
    set({ nodes: [...state.nodes, node], selectedIds: [id], zCounter: state.zCounter + 1 })
    return id
  },

  updateNode(id: string, patch: Partial<Omit<CanvasNodeData, 'id'>>): void {
    set({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })
  },

  /** 拖拽/缩放高频路径：静默更新（不发 store 通知，由调用方节流提交） */
  moveNodeSilent(id: string, patch: Partial<Pick<CanvasNodeData, 'x' | 'y' | 'width' | 'height'>>): void {
    state = { ...state, nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }
  },

  /**
   * 拖动热路径（P0-1）：rAF 内每帧调用一次，写完立即通知订阅者。
   * 位置按「初始位置 + 本次拖动增量」计算，避免累积漂移。
   */
  applyNodeMove(id: string, x: number, y: number): void {
    set({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) })
  },

  /** 缩放热路径（P0-1 同源）：每帧一次，立即通知 */
  applyNodeResize(id: string, width: number, height: number): void {
    set({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, width, height } : n)) })
  },

  commit(): void {
    emit()
  },

  select(id: string | null): void {
    set({ selectedIds: id ? [id] : [], zCounter: state.zCounter + (id ? 1 : 0) })
  },

  removeNode(id: string): void {
    set({
      nodes: state.nodes.filter((n) => n.id !== id),
      connections: state.connections.filter((c) => c.from !== id && c.to !== id),
      selectedIds: state.selectedIds.filter((s) => s !== id)
    })
  },

  addConnection(from: string, to: string): void {
    if (from === to) return
    if (state.connections.some((c) => c.from === from && c.to === to)) return
    set({ connections: [...state.connections, { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, from, to }] })
  },

  removeConnection(id: string): void {
    set({ connections: state.connections.filter((c) => c.id !== id) })
  },

  /** 某节点的上游输入节点（连线来源） */
  upstreamOf(id: string): CanvasNodeData[] {
    const byId = new Map(state.nodes.map((n) => [n.id, n]))
    return state.connections
      .filter((c) => c.to === id)
      .map((c) => byId.get(c.from))
      .filter((n): n is CanvasNodeData => !!n)
  }
}

export function useCanvasState(): CanvasState {
  return useSyncExternalStore(canvasStore.subscribe, canvasStore.getState)
}
