/**
 * 连线命中判定（P0-5）—— 纯几何、无 DOM 依赖，可按 1/k 补偿到屏幕恒定像素，单测见 connection-hit.test.mjs。
 *
 * 移植依据：上游 infinite-canvas `project.tsx` L655-689 `getConnectionDropTarget`
 * （世界坐标 → 节点包围盒比较；inside(0) > handle(1) > expanded(2) 三档优先级；
 * padding 与 handleRadius 均除以 scale，保证缩放后屏幕命中面积不变）。
 */

/** 画布级 SVG 的坐标偏移：SVG 本体定位在 (-OFF, -OFF)，世界坐标需 +OFF 才能落在视口内 */
export const CANVAS_SVG_OFFSET = 100000

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
  /** 端口命中半径（屏幕像素，默认 18） */
  handleRadiusPx?: number
  /** 包围盒外扩命中边界（屏幕像素，默认 24） */
  padPx?: number
  /** 排除的节点（源节点自身不能连自己） */
  excludeId?: string
}

export type HitPriority = 0 | 1 | 2

export interface HitResult {
  nodeId: string | null
  /** 0=包围盒内 1=端口圆内 2=外扩区；未命中为 null */
  priority: HitPriority | null
  /** 命中的锚点（目标左侧中部），用于端点吸附 */
  anchor: { x: number; y: number } | null
  /** 是否落在"接近"范围（外扩区内或端口附近），用于光标/高亮 */
  isNear: boolean
}

const EMPTY: HitResult = { nodeId: null, priority: null, anchor: null, isNear: false }

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

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

/**
 * 命中测试：优先级最高（数字最小）的候选；同优先级内取**层级更高**者（数组中靠后=后创建=在上层），
 * 层级无法区分（同一节点）时才比距离。重叠节点场景必须按层级选，否则会连到被遮住的下层节点。
 */
export function hitTestConnectionTarget(nodes: HitTestNode[], world: { x: number; y: number }, opts: HitOptions): HitResult {
  const k = opts.scale > 0 ? opts.scale : 1
  const handleRadius = (opts.handleRadiusPx ?? 18) / k
  const pad = (opts.padPx ?? 24) / k

  let best: HitResult = EMPTY
  let bestPriority: HitPriority | null = null
  let bestIndex = -1
  let bestDist = Number.POSITIVE_INFINITY

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (opts.excludeId && node.id === opts.excludeId) continue

    const anchor = portAnchor(node)
    const dAnchor = distance(world.x, world.y, anchor.x, anchor.y)

    let priority: HitPriority | null = null
    if (inside(node, world.x, world.y)) priority = 0
    else if (dAnchor <= handleRadius) priority = 1
    else if (
      world.x >= node.x - pad &&
      world.x <= node.x + node.width + pad &&
      world.y >= node.y - pad &&
      world.y <= node.y + node.height + pad
    ) {
      priority = 2
    }
    if (priority === null) continue

    const better =
      bestPriority === null ||
      priority < bestPriority ||
      (priority === bestPriority && (i > bestIndex || (i === bestIndex && dAnchor < bestDist)))
    if (better) {
      best = { nodeId: node.id, priority, anchor, isNear: true }
      bestPriority = priority
      bestIndex = i
      bestDist = dAnchor
    }
  }
  return best
}

/**
 * pending 线终点：命中目标时吸附到目标锚点（磁性手感），否则跟鼠标。
 */
export function snapEndpoint(world: { x: number; y: number }, hit: HitResult): { x: number; y: number; snapped: boolean } {
  if (hit.nodeId && hit.anchor) return { x: hit.anchor.x, y: hit.anchor.y, snapped: true }
  return { x: world.x, y: world.y, snapped: false }
}

/** 世界坐标 → 三次贝塞尔路径（与 ConnectionLayer 的既有曲线一致） */
export function connectionPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const mx = (from.x + to.x) / 2
  return `M ${from.x} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${to.x} ${to.y}`
}
