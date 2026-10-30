/**
 * 视口适配（fit view / focus）—— 纯函数，可 node --test 直跑。
 *
 * 参考 Excalidraw 的 zoomToFit / React Flow 的 fitView / 上游 infinite-canvas 的 focusViewportForNode：
 * 统一约定：把给定世界矩形放进容器（留 padding），并夹到合理缩放区间。
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Viewport { x: number; y: number; k: number }
export interface Size { width: number; height: number }

export const MIN_K = 0.05
export const MAX_K = 5

function clampK(k: number): number {
  return Math.min(Math.max(k, MIN_K), MAX_K)
}

/** 把所有节点包围盒适配进容器（空列表返回 null，调用方保持原视口） */
export function fitView(nodes: Rect[], size: Size, padding = 80): Viewport | null {
  if (!nodes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)
  const availW = Math.max(40, size.width - padding * 2)
  const availH = Math.max(40, size.height - padding * 2)
  const k = clampK(Math.min(availW / w, availH / h))
  // 居中：容器中心对准包围盒中心
  return { x: size.width / 2 - ((minX + maxX) / 2) * k, y: size.height / 2 - ((minY + maxY) / 2) * k, k }
}

/** 聚焦单个节点：让节点占据视口约 ratio 的比例（默认 60%） */
export function focusNode(node: Rect, size: Size, ratio = 0.6, padding = 40): Viewport | null {
  if (!node || node.width <= 0 || node.height <= 0) return null
  const target = Math.max(0.1, Math.min(1, ratio))
  const availW = Math.max(40, size.width * target - padding)
  const availH = Math.max(40, size.height * target - padding)
  const k = clampK(Math.min(availW / node.width, availH / node.height))
  return { x: size.width / 2 - (node.x + node.width / 2) * k, y: size.height / 2 - (node.y + node.height / 2) * k, k }
}
