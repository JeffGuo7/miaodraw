/**
 * 画布状态存储 — 轻量自写（useSyncExternalStore），零新依赖。
 * 后续 M1 数据层升级时此模块是唯一改动点。
 */
import { useSyncExternalStore } from 'react'

import type { CanvasNodeData, CanvasNodeType, ViewportTransform } from './types'
import { NODE_SPECS } from './types'

export interface CanvasState {
  nodes: CanvasNodeData[]
  viewport: ViewportTransform
  selectedIds: string[]
  zCounter: number
}

let state: CanvasState = {
  nodes: [],
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

  commit(): void {
    emit()
  },

  select(id: string | null): void {
    set({ selectedIds: id ? [id] : [], zCounter: state.zCounter + (id ? 1 : 0) })
  },

  removeNode(id: string): void {
    set({ nodes: state.nodes.filter((n) => n.id !== id), selectedIds: state.selectedIds.filter((s) => s !== id) })
  }
}

export function useCanvasState(): CanvasState {
  return useSyncExternalStore(canvasStore.subscribe, canvasStore.getState)
}
