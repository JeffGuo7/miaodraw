/**
 * 画布状态存储 — 轻量自写（useSyncExternalStore），零新依赖。
 *
 * 订阅粒度（P1-10）：早期是「一个 store + 一个全局 listener」，任何一次拖动都会让整页重渲染。
 * 现在按维度拆通道：
 *   - 结构（增删/顺序）      → useNodeIds()
 *   - 单个节点内容/位置      → useNode(id) / useIsSelected(id)
 *   - 几何版本（位置/尺寸）  → useGeometryVersion()（连线层、小地图用）
 *   - 视口 / 选择 / 连线     → useViewport() / useSelection() / useConnections()
 * 拖动一个节点只会通知该节点的订阅者 + 几何版本订阅者，不再重建全部节点元素。
 */
import { useCallback, useSyncExternalStore } from 'react'

import type { CanvasConnection, CanvasNodeData, CanvasNodeType, ViewportTransform } from './types'
import { NODE_SPECS } from './types'

export interface CanvasState {
  nodes: CanvasNodeData[]
  /** 节点 id 列表（只在增删/顺序变化时替换，供结构订阅使用） */
  nodeIds: string[]
  connections: CanvasConnection[]
  viewport: ViewportTransform
  selectedIds: string[]
  /** 选中的连线（连线是一等对象：可选中、可删除；与节点选择互斥） */
  selectedConnectionId: string | null
  /** 几何版本号：任一节点位置/尺寸变化 +1（连线层与小地图据此重算） */
  geometryVersion: number
  zCounter: number
}

let state: CanvasState = {
  nodes: [],
  nodeIds: [],
  connections: [],
  viewport: { x: 80, y: 80, k: 1 },
  selectedIds: [],
  selectedConnectionId: null,
  geometryVersion: 0,
  zCounter: 1
}

export type CanvasKey = 'nodes' | 'viewport' | 'selection' | 'connections'

const listeners = new Set<(key: CanvasKey) => void>()
const nodeListeners = new Map<string, Set<() => void>>()
const geometryListeners = new Set<() => void>()

function emitKey(key: CanvasKey): void {
  for (const l of listeners) l(key)
}

function emitNode(id: string): void {
  nodeListeners.get(id)?.forEach((l) => l())
}

function emitGeometry(): void {
  for (const l of geometryListeners) l()
}

function subscribeKey(key: CanvasKey) {
  return (cb: () => void): (() => void) => {
    const l = (changed: CanvasKey): void => {
      if (changed === key) cb()
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
}

function subscribeNode(id: string) {
  return (cb: () => void): (() => void) => {
    const set = nodeListeners.get(id) ?? new Set<() => void>()
    set.add(cb)
    nodeListeners.set(id, set)
    return () => {
      set.delete(cb)
    }
  }
}

function subscribeGeometry(cb: () => void): () => void {
  geometryListeners.add(cb)
  return () => {
    geometryListeners.delete(cb)
  }
}

/** 替换单个节点对象：只通知该节点的订阅者；位置/尺寸变化额外通知几何订阅者 */
function patchNode(id: string, patch: Partial<Omit<CanvasNodeData, 'id'>>): CanvasNodeData | null {
  const idx = state.nodes.findIndex((n) => n.id === id)
  if (idx < 0) return null
  const next = { ...state.nodes[idx], ...patch }
  const nodes = state.nodes.slice()
  nodes[idx] = next
  state = { ...state, nodes }
  emitNode(id)
  if (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined) {
    state = { ...state, geometryVersion: state.geometryVersion + 1 }
    emitGeometry()
  }
  return next
}

export const canvasStore = {
  getState: (): CanvasState => state,

  setViewport(vp: ViewportTransform): void {
    state = { ...state, viewport: vp }
    emitKey('viewport')
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
    state = { ...state, nodes: [...state.nodes, node], nodeIds: [...state.nodeIds, id], selectedIds: [id], zCounter: state.zCounter + 1, geometryVersion: state.geometryVersion + 1 }
    emitKey('nodes')
    emitKey('selection')
    emitGeometry()
    return id
  },

  updateNode(id: string, patch: Partial<Omit<CanvasNodeData, 'id'>>): void {
    patchNode(id, patch)
  },

  /** 拖动热路径：rAF 内每帧一次，只通知被拖节点 + 几何层 */
  applyNodeMove(id: string, x: number, y: number): void {
    patchNode(id, { x, y })
  },

  /** 缩放热路径：同源 */
  applyNodeResize(id: string, width: number, height: number): void {
    patchNode(id, { width, height })
  },

  /** 全量通知（载入/撤销等一次性变更后使用） */
  commit(): void {
    state = { ...state, geometryVersion: state.geometryVersion + 1 }
    for (const key of ['nodes', 'viewport', 'selection', 'connections'] as CanvasKey[]) emitKey(key)
    emitGeometry()
    for (const id of state.nodeIds) emitNode(id)
  },

  /**
   * 选中即置顶（Excalidraw/Figma 的通用直觉）：此前只加 zCounter 却不改节点 zIndex，
   * 选中后节点仍在底层，被别的节点盖住且点不到。
   */
  select(id: string | null): void {
    if (!id) {
      state = { ...state, selectedIds: [] }
      emitKey('selection')
      return
    }
    const z = state.zCounter + 1
    state = { ...state, zCounter: z, selectedIds: [id], selectedConnectionId: null }
    patchNode(id, { zIndex: z })
    emitKey('selection')
  },

  /** 选中连线（与节点选择互斥） */
  selectConnection(id: string | null): void {
    state = { ...state, selectedConnectionId: id, selectedIds: [] }
    emitKey('selection')
  },

  removeNode(id: string): void {
    state = {
      ...state,
      nodes: state.nodes.filter((n) => n.id !== id),
      nodeIds: state.nodeIds.filter((n) => n !== id),
      connections: state.connections.filter((c) => c.from !== id && c.to !== id),
      selectedIds: state.selectedIds.filter((s) => s !== id),
      geometryVersion: state.geometryVersion + 1
    }
    emitKey('nodes')
    emitKey('selection')
    emitKey('connections')
    emitGeometry()
  },

  addConnection(from: string, to: string): void {
    if (from === to) return
    if (state.connections.some((c) => c.from === from && c.to === to)) return
    state = {
      ...state,
      connections: [...state.connections, { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, from, to }],
      geometryVersion: state.geometryVersion + 1
    }
    emitKey('connections')
    emitGeometry()
  },

  removeConnection(id: string): void {
    state = {
      ...state,
      connections: state.connections.filter((c) => c.id !== id),
      selectedConnectionId: state.selectedConnectionId === id ? null : state.selectedConnectionId,
      geometryVersion: state.geometryVersion + 1
    }
    emitKey('connections')
    emitKey('selection')
    emitGeometry()
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

// ---------- 细粒度订阅 hooks ----------

export function useNodeIds(): readonly string[] {
  return useSyncExternalStore(subscribeKey('nodes'), () => state.nodeIds)
}

export function useNode(id: string): CanvasNodeData | undefined {
  const subscribe = useCallback((cb: () => void) => subscribeNode(id)(cb), [id])
  const snapshot = useCallback(() => state.nodes.find((n) => n.id === id), [id])
  return useSyncExternalStore(subscribe, snapshot)
}

export function useIsSelected(id: string): boolean {
  const snapshot = useCallback(() => state.selectedIds.includes(id), [id])
  return useSyncExternalStore(subscribeKey('selection'), snapshot)
}

export function useSelection(): readonly string[] {
  return useSyncExternalStore(subscribeKey('selection'), () => state.selectedIds)
}

export function useSelectedConnection(): string | null {
  return useSyncExternalStore(subscribeKey('selection'), () => state.selectedConnectionId)
}

export function useViewport(): ViewportTransform {
  return useSyncExternalStore(subscribeKey('viewport'), () => state.viewport)
}

export function useConnections(): readonly CanvasConnection[] {
  return useSyncExternalStore(subscribeKey('connections'), () => state.connections)
}

export function useGeometryVersion(): number {
  return useSyncExternalStore(subscribeGeometry, () => state.geometryVersion)
}
