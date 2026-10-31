/**
 * 节点落位避让 —— 纯函数，可 node --test 直跑。
 *
 * 背景：新建节点原来按「32px 步进」错位，但一张卡片宽 320px，
 * 连点三次工具条就得到三张叠在一起的卡（点不到、看不出关系）。
 * 只做「向下堆」也不行：连开七张卡会排成一条跑出屏幕的长柱。
 *
 * 现在的策略是「先向右找空列，再换行」：
 *   候选顺序 = 第 0 行右移 0/1/2/3 列 → 第 1 行右移 0..3 列 → 第 2 行 …
 * 这样既保证新卡看得见，也天然形成左→右的构图（连线从右侧端口出、指向右侧下游）。
 */

export interface PlacementRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PlacementSize {
  width: number
  height: number
}

/** 卡片之间保留的呼吸间距（世界像素） */
export const PLACEMENT_GAP = 24
/** 同行卡片之间的额外间隔 */
const COLUMN_GAP = 72
/** 换行时的额外间隔 */
const ROW_GAP = 36
/** 第一轮向右最多找几列，再换行 */
const COLUMNS = 4
/** 最多扫描几行（超过就接受当前位置，避免病态场景死循环） */
const ROWS = 12

function overlaps(a: PlacementRect, b: PlacementRect): boolean {
  return (
    a.x < b.x + b.width + PLACEMENT_GAP &&
    a.x + a.width + PLACEMENT_GAP > b.x &&
    a.y < b.y + b.height + PLACEMENT_GAP &&
    a.y + a.height + PLACEMENT_GAP > b.y
  )
}

/**
 * 返回一个不与任何已有节点重叠的落点。
 * @param nodes 已有节点
 * @param size 新节点尺寸
 * @param x 期望 x（世界坐标）
 * @param y 期望 y（世界坐标）
 */
export function resolveNodePlacement(
  nodes: readonly PlacementRect[],
  size: PlacementSize,
  x: number,
  y: number
): { x: number; y: number } {
  const startX = Math.round(x)
  const startY = Math.round(y)
  const stepX = size.width + COLUMN_GAP
  const stepY = size.height + ROW_GAP
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const candidate = { x: startX + col * stepX, y: startY + row * stepY, width: size.width, height: size.height }
      if (!nodes.some((n) => overlaps(candidate, n))) return { x: candidate.x, y: candidate.y }
    }
  }
  return { x: startX, y: startY + ROWS * stepY }
}
