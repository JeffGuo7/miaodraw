/**
 * 吸附对齐（snapping）—— 纯函数，可 node --test 直跑。
 *
 * 参考 Excalidraw（grid/objects/midpoint）、tldraw（bounds/handle/gap/grid）、Figma 的对齐线：
 * 拖动节点时，把它的左/中/右（或上/中/下）与其他节点的对应边比对，
 * 在阈值内取最近的一个产生位移修正，并返回应显示的对齐线。
 * 没有可对齐的邻居时退化为 8px 网格吸附；按住 Alt 由调用方关闭。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapGuide {
  axis: 'x' | 'y'
  /** 对齐线所在的世界坐标（x 轴时为竖线的 x，y 轴时为横线的 y） */
  world: number
  kind: 'edge' | 'center'
}

export interface SnapOptions {
  /** 吸附阈值（世界坐标单位，调用方通常传 6 / zoom） */
  threshold: number
  /** 网格兜底尺寸（世界坐标单位）；0 或省略表示不启用网格 */
  grid?: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

interface Candidate {
  world: number
  kind: 'edge' | 'center'
}

function axisBounds(r: Rect, axis: 'x' | 'y'): { start: number; size: number } {
  return axis === 'x' ? { start: r.x, size: r.width } : { start: r.y, size: r.height }
}

/** 一个矩形在某轴上的三个吸附点：起始边 / 中心 / 结束边 */
function pointsOf(r: Rect, axis: 'x' | 'y'): Candidate[] {
  const { start, size } = axisBounds(r, axis)
  return [
    { world: start, kind: 'edge' },
    { world: start + size / 2, kind: 'center' },
    { world: start + size, kind: 'edge' }
  ]
}

function snapAxis(moving: Rect, others: Rect[], axis: 'x' | 'y', threshold: number, grid: number): { delta: number; guide: SnapGuide | null } {
  const targets: Candidate[] = []
  for (const o of others) targets.push(...pointsOf(o, axis))
  let best: { delta: number; world: number; kind: 'edge' | 'center' } | null = null
  for (const p of pointsOf(moving, axis)) {
    for (const t of targets) {
      const delta = t.world - p.world
      if (Math.abs(delta) > threshold) continue
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, world: t.world, kind: t.kind }
    }
  }
  if (best) return { delta: best.delta, guide: { axis, world: best.world, kind: best.kind } }
  if (grid > 0) {
    const { start } = axisBounds(moving, axis)
    const delta = Math.round(start / grid) * grid - start
    if (Math.abs(delta) <= threshold) return { delta, guide: null }
  }
  return { delta: 0, guide: null }
}

export function computeSnap(moving: Rect, others: Rect[], opts: SnapOptions): SnapResult {
  const threshold = Math.max(0.5, opts.threshold || 0)
  const grid = opts.grid && opts.grid > 0 ? opts.grid : 0
  const x = snapAxis(moving, others, 'x', threshold, grid)
  const y = snapAxis(moving, others, 'y', threshold, grid)
  const guides: SnapGuide[] = []
  if (x.guide) guides.push(x.guide)
  if (y.guide) guides.push(y.guide)
  return { dx: x.delta, dy: y.delta, guides }
}
