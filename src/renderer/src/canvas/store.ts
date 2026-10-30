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

/** 进程内剪贴板（Ctrl+C/V 用；系统剪贴板与跨窗口不在本期范围） */
let clipboard: { nodes: CanvasNodeData[]; connections: CanvasConnection[] } | null = null

/** 删除计划卡时的外部回调（Workbench 注入：同步取消主进程计划，避免重启后被 plan:restore 拉回来） */
let planDeleteHandler: ((planId: string) => void) | null = null

const listeners = new Set<(key: CanvasKey) => void>()
const nodeListeners = new Map<string, Set<() => void>>()
const geometryListeners = new Set<() => void>()
const anyListeners = new Set<() => void>()

function emitKey(key: CanvasKey): void {
  for (const l of listeners) l(key)
  for (const l of anyListeners) l()
}

/** 订阅「任意变更」（历史记录用：不关心具体通道） */
export function subscribeAny(cb: () => void): () => void {
  anyListeners.add(cb)
  return () => {
    anyListeners.delete(cb)
  }
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
    // 新建节点错位摆放：连点工具条时不再全部堆在视口中心（Excalidraw 同款 32px 步进）
    const slot = state.nodes.length % 15
    const stagger = { x: (slot % 5) * 32, y: Math.floor(slot / 5) * 32 }
    const centerX = -vp.x + vp.k > 0 ? (window.innerWidth / 2 - vp.x) / vp.k - spec.width / 2 : spec.width
    const centerY = (window.innerHeight / 2 - vp.y) / vp.k - spec.height / 2
    const x = at?.x ?? centerX + stagger.x
    const y = at?.y ?? centerY + stagger.y
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

  /**
   * 用快照整体替换画布内容（撤销/重做、载入工程）。
   * 会重建 nodeIds 并广播所有通道，保证订阅者（节点宿主、连线层、小地图）全部刷新。
   */
  restore(snapshot: { nodes: CanvasNodeData[]; connections: CanvasConnection[] }): void {
    const nodes = snapshot.nodes.map((n) => ({ ...n, metadata: { ...n.metadata } }))
    state = {
      ...state,
      nodes,
      nodeIds: nodes.map((n) => n.id),
      connections: snapshot.connections.map((c) => ({ ...c })),
      selectedIds: [],
      selectedConnectionId: null,
      geometryVersion: state.geometryVersion + 1
    }
    for (const key of ['nodes', 'selection', 'connections'] as CanvasKey[]) emitKey(key)
    emitGeometry()
    for (const id of state.nodeIds) emitNode(id)
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

  /** 批量选中（框选/全选用）；空数组即清空 */
  setSelection(ids: string[]): void {
    state = { ...state, selectedIds: [...new Set(ids)], selectedConnectionId: null }
    emitKey('selection')
  },

  /** Shift 点选：已选则移除，未选则追加并置顶 */
  toggleSelection(id: string): void {
    const has = state.selectedIds.includes(id)
    const ids = has ? state.selectedIds.filter((s) => s !== id) : [...state.selectedIds, id]
    state = { ...state, selectedIds: ids, selectedConnectionId: null }
    if (!has) {
      const z = state.zCounter + 1
      state = { ...state, zCounter: z }
      patchNode(id, { zIndex: z })
    }
    emitKey('selection')
  },

  /** 多选拖动热路径：按「起点坐标 + 本次增量」批量提交，一次通知几何层 */
  moveNodes(origins: Array<{ id: string; x: number; y: number }>, dx: number, dy: number): void {
    if (!origins.length) return
    const byId = new Map(origins.map((o) => [o.id, o]))
    const nodes = state.nodes.map((n) => {
      const o = byId.get(n.id)
      return o ? { ...n, x: Math.round(o.x + dx), y: Math.round(o.y + dy) } : n
    })
    state = { ...state, nodes, geometryVersion: state.geometryVersion + 1 }
    for (const o of origins) emitNode(o.id)
    emitGeometry()
  },

  /**
   * 复制选中节点（含选中节点之间的内部连线）。
   * 计划卡不参与复制：同一 plan 只能有一张卡，复制出来会变成两张卡指向同一个 plan。
   */
  copySelection(): number {
    const ids = new Set(state.selectedIds)
    const nodes = state.nodes.filter((n) => ids.has(n.id) && n.type !== 'plan')
    if (!nodes.length) return 0
    const nodeIds = new Set(nodes.map((n) => n.id))
    clipboard = {
      nodes: nodes.map((n) => ({ ...n, metadata: { ...n.metadata } })),
      connections: state.connections.filter((c) => nodeIds.has(c.from) && nodeIds.has(c.to)).map((c) => ({ ...c }))
    }
    return nodes.length
  },

  canPaste(): boolean {
    return Boolean(clipboard?.nodes.length)
  },

  /** 粘贴：新 id、整体偏移、保留内部连线，并选中新节点（一次操作 = 一条 undo） */
  paste(offset = 24): string[] {
    const src = clipboard
    if (!src?.nodes.length) return []
    const zBase = state.zCounter
    const idMap = new Map<string, string>()
    const stamp = Date.now().toString(36)
    const newNodes = src.nodes.map((n, i) => {
      const id = `n${stamp}${Math.random().toString(36).slice(2, 6)}${i}`
      idMap.set(n.id, id)
      return { ...n, id, x: n.x + offset, y: n.y + offset, zIndex: zBase + i + 1, metadata: { ...n.metadata } }
    })
    const newConns = src.connections.map((c, i) => ({
      id: `c${stamp}${Math.random().toString(36).slice(2, 6)}${i}`,
      from: idMap.get(c.from) as string,
      to: idMap.get(c.to) as string
    }))
    state = {
      ...state,
      nodes: [...state.nodes, ...newNodes],
      nodeIds: [...state.nodeIds, ...newNodes.map((n) => n.id)],
      connections: [...state.connections, ...newConns],
      selectedIds: newNodes.map((n) => n.id),
      selectedConnectionId: null,
      zCounter: zBase + newNodes.length + 1,
      geometryVersion: state.geometryVersion + 1
    }
    emitKey('nodes')
    emitKey('selection')
    if (newConns.length) emitKey('connections')
    emitGeometry()
    return newNodes.map((n) => n.id)
  },

  /** 复制副本（Ctrl+D）：克隆当前选中，不经过剪贴板 */
  duplicateSelection(): string[] {
    const n = canvasStore.copySelection()
    return n ? canvasStore.paste() : []
  },

  /** 选中连线（与节点选择互斥） */
  selectConnection(id: string | null): void {
    state = { ...state, selectedConnectionId: id, selectedIds: [] }
    emitKey('selection')
  },

  setPlanDeleteHandler(fn: ((planId: string) => void) | null): void {
    planDeleteHandler = fn
  },

  removeNode(id: string): void {
    const removed = state.nodes.find((n) => n.id === id)
    // 计划卡被删除 = 用户放弃该计划：必须同步取消，否则重启恢复（plan:restore）会把它重新拉回来
    if (removed?.type === 'plan' && removed.metadata?.planId) planDeleteHandler?.(String(removed.metadata.planId))
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
