/**
 * 连线命中判定 —— 纯几何、无 DOM 依赖，按 1/k 补偿到屏幕恒定像素。
 *
 * 交互事实（用户反馈驱动）：只认「端口圆」时，绝大多数人会**从端口拖到目标卡片身上**松手，
 * 结果什么都没发生 → 看起来"画布不能连线"。所以命中改成两级：
 *   1) 端口圆优先（44px 屏幕半径，磁性吸附到目标左侧中部锚点）
 *   2) 否则目标节点**包围盒内任意位置**都算命中（松手在卡片上就成连，符合直觉）
 * 两级都按层级从上往下取第一个命中，重叠卡片不会连到被遮住的那张。
 */

export interface HitTestNode {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface HitOptions {
  /** 当前视口缩放 k */
  scale: number
  /** 端口吸附半径（屏幕像素，默认 44） */
  radiusPx?: number
  /** 排除的节点（源节点自身不能连自己） */
  excludeId?: string
}

/** port=落在端口圆内（吸附锚点）；body=落在卡片身上（吸附到锚点但允许任意落点） */
export type HitVia = 'port' | 'body'

export interface HitResult {
  /** 命中的目标节点；未命中为 null */
  nodeId: string | null
  /** 命中的锚点（目标左侧中部），用于端点吸附 */
  anchor: { x: number; y: number } | null
  /** 是否进入「接近」范围（端口半径的 1.6 倍内），仅用于光标/提示 */
  isNear: boolean
  /** 命中方式；未命中为 null */
  via: HitVia | null
}

/** 端口吸附半径（屏幕像素） */
export const DEFAULT_SNAP_RADIUS_PX = 44
/** 「接近」判定倍数：只做视觉提示，不建连 */
export const NEAR_RADIUS_FACTOR = 1.6

const EMPTY: HitResult = { nodeId: null, anchor: null, isNear: false, via: null }

/** 目标端锚点：节点左侧中部（连线落到下游时吸附到这里） */
export function portAnchor(node: HitTestNode): { x: number; y: number } {
  return { x: node.x, y: node.y + node.height / 2 }
}

/** 源端锚点：节点右侧中部（连线从上游端口拖出） */
export function sourcePortAnchor(node: HitTestNode): { x: number; y: number } {
  return { x: node.x + node.width, y: node.y + node.height / 2 }
}

function inside(node: HitTestNode, x: number, y: number): boolean {
  return x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height
}

/**
 * 命中测试：两轮扫描（先端口圆、再卡片包围盒），每轮都从层级最高往下找。
 * 先扫完所有节点的端口，是为了让「明明指向端口」时不被上层卡片的身位抢走。
 */
export function hitTestConnectionTarget(nodes: HitTestNode[], world: { x: number; y: number }, opts: HitOptions): HitResult {
  const k = opts.scale > 0 ? opts.scale : 1
  const radius = (opts.radiusPx ?? DEFAULT_SNAP_RADIUS_PX) / k
  const nearRadius = radius * NEAR_RADIUS_FACTOR

  // 第 1 轮：端口圆
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (opts.excludeId && node.id === opts.excludeId) continue
    const anchor = portAnchor(node)
    if (Math.hypot(world.x - anchor.x, world.y - anchor.y) <= radius) {
      return { nodeId: node.id, anchor, isNear: true, via: 'port' }
    }
  }

  // 第 2 轮：卡片身上任意位置（用户直觉：拖到卡片上松手 = 连上）
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (opts.excludeId && node.id === opts.excludeId) continue
    if (inside(node, world.x, world.y)) {
      return { nodeId: node.id, anchor: portAnchor(node), isNear: true, via: 'body' }
    }
  }

  // 兜底：只判「接近」，用于光标提示
  let near = false
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (opts.excludeId && node.id === opts.excludeId) continue
    const anchor = portAnchor(node)
    if (Math.hypot(world.x - anchor.x, world.y - anchor.y) <= nearRadius) {
      near = true
      break
    }
  }
  return near ? { ...EMPTY, isNear: true } : EMPTY
}

/**
 * pending 线终点：命中目标时吸附到目标锚点（磁性手感），否则跟鼠标。
 */
export function snapEndpoint(world: { x: number; y: number }, hit: HitResult): { x: number; y: number; snapped: boolean } {
  if (hit.nodeId && hit.anchor) return { x: hit.anchor.x, y: hit.anchor.y, snapped: true }
  return { x: world.x, y: world.y, snapped: false }
}

/**
 * 世界坐标 → 三次贝塞尔路径。
 * 控制点按水平距离的 1.5 倍留出弧度下限，避免短连线被压成一条折线。
 */
export function connectionPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const curvature = Math.max(Math.abs(to.x - from.x) * 0.5, 50)
  const c1 = { x: from.x + curvature, y: from.y }
  const c2 = { x: to.x - curvature, y: to.y }
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`
}
