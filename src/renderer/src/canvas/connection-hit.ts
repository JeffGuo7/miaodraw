/**
 * 连线命中判定（P0-5 → 体验重构）—— 纯几何、无 DOM 依赖，可按 1/k 补偿到屏幕恒定像素。
 *
 * 设计依据（参考 BeefTV 的连线控制器实测结论）：
 * - 只认「端口锚点为圆心的圆」，**不再**把节点包围盒/外扩矩形当作可连目标。
 *   旧实现里 inside(0) 档意味着「拖到节点身上」就直接成连，误连率极高（想连右边那张，
 *   结果落在左边卡片内部就连到了左边）。
 * - 半径按屏幕像素给（默认 44），命中面积与缩放无关。
 * - 重叠节点按层级从上往下取第一个命中的端口（与绘制顺序一致），避免连到被遮住的下层。
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

export interface HitResult {
  /** 命中的目标节点；未命中为 null */
  nodeId: string | null
  /** 命中的锚点（目标左侧中部），用于端点吸附 */
  anchor: { x: number; y: number } | null
  /** 是否进入「接近」范围（半径的 1.6 倍内），仅用于光标/提示，不参与成连 */
  isNear: boolean
}

/** 端口吸附半径（屏幕像素）。44px 约等于一个指尖/光标热区，比旧 18px 好按，又不会误吸邻卡。 */
export const DEFAULT_SNAP_RADIUS_PX = 44
/** 「接近」判定倍数：只做视觉提示，不建连 */
export const NEAR_RADIUS_FACTOR = 1.6

const EMPTY: HitResult = { nodeId: null, anchor: null, isNear: false }

/** 目标端锚点：节点左侧中部（连线落到下游时吸附到这里） */
export function portAnchor(node: HitTestNode): { x: number; y: number } {
  return { x: node.x, y: node.y + node.height / 2 }
}

/** 源端锚点：节点右侧中部（连线从上游端口拖出） */
export function sourcePortAnchor(node: HitTestNode): { x: number; y: number } {
  return { x: node.x + node.width, y: node.y + node.height / 2 }
}

/**
 * 命中测试：从层级最高的节点（数组末尾）往下找，第一个端口圆命中的即为目标。
 * 这样「明明指向上层那张卡」不会因为下层卡片端口更近而连错。
 */
export function hitTestConnectionTarget(nodes: HitTestNode[], world: { x: number; y: number }, opts: HitOptions): HitResult {
  const k = opts.scale > 0 ? opts.scale : 1
  const radius = (opts.radiusPx ?? DEFAULT_SNAP_RADIUS_PX) / k
  const nearRadius = radius * NEAR_RADIUS_FACTOR

  let near = false
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (opts.excludeId && node.id === opts.excludeId) continue
    const anchor = portAnchor(node)
    const distance = Math.hypot(world.x - anchor.x, world.y - anchor.y)
    if (distance <= radius) return { nodeId: node.id, anchor, isNear: true }
    if (distance <= nearRadius) near = true
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
