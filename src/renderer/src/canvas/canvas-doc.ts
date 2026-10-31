/**
 * 画布文档的序列化 / 反序列化 —— 纯函数，可 node --test 直跑。
 *
 * 画布要能跨重启保留，就必须把「文档」和「运行时瞬态」分开：
 *   - 文档：节点、连线、视口（用户看不见但决定看到什么）
 *   - 瞬态：running / progress / status（重启后一定不该是「还在跑」）
 * 另外节点里不能塞 base64 图：上传图片走 canvas:importImage 落盘，metadata 只留 media:// 短路径。
 * 这里做最后一道闸：历史上已经存进 data URL 的节点，超限内容在序列化时丢弃并打标记，
 * 保证文档永远是 KB~百 KB 级。
 */
import type { CanvasConnection, CanvasNodeData, CanvasNodeType, ViewportTransform } from './types'

/** 画布文档 schema 版本（结构变更时 +1，并在 deserialize 里做兼容分支） */
export const CANVAS_DOC_SCHEMA = 1
/** 单文档 id：当前产品只有一个无限画布，多画布时改成项目 id 即可 */
export const DEFAULT_CANVAS_DOC_ID = 'default'

/** 单节点内联内容的字符上限（data URL 才会命中；media:// 路径远小于它） */
export const MAX_INLINE_CONTENT_CHARS = 600_000

const NODE_TYPES: CanvasNodeType[] = ['text', 'image', 'video', 'audio', 'config', 'group', 'generate', 'plan']
/** 重启后必须清掉的瞬态字段 */
const VOLATILE_META_KEYS = ['running', 'progress', 'status', 'failCount', 'pending', 'submitting']

export interface CanvasDocRecord {
  id: string
  schema_version: number
  nodes: unknown[]
  connections: unknown[]
  viewport: unknown
  updated_at: number
}

export interface CanvasDocument {
  nodes: CanvasNodeData[]
  connections: CanvasConnection[]
  viewport: ViewportTransform
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

/** 序列化：剔除瞬态、丢弃超限内联内容、把节点压成可 JSON 的形状 */
export function serializeCanvasDocument(doc: CanvasDocument, now: number, id = DEFAULT_CANVAS_DOC_ID): CanvasDocRecord {
  const nodes = doc.nodes.map((n) => {
    const metadata: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(n.metadata ?? {})) {
      if (VOLATILE_META_KEYS.includes(k)) continue
      metadata[k] = v
    }
    const content = metadata.content
    if (typeof content === 'string' && content.startsWith('data:') && content.length > MAX_INLINE_CONTENT_CHARS) {
      // 不丢节点，只丢这张内联图；用户重新拖一次即可，卡片位置/连线都还在
      metadata.content = ''
      metadata.contentDropped = true
    }
    return {
      id: n.id,
      type: n.type,
      x: Math.round(n.x),
      y: Math.round(n.y),
      width: Math.round(n.width),
      height: Math.round(n.height),
      zIndex: n.zIndex,
      metadata
    }
  })
  return {
    id,
    schema_version: CANVAS_DOC_SCHEMA,
    nodes,
    connections: doc.connections.map((c) => ({ id: c.id, from: c.from, to: c.to })),
    viewport: { x: doc.viewport.x, y: doc.viewport.y, k: doc.viewport.k },
    updated_at: now
  }
}

/**
 * 反序列化：任何一条坏数据都不能让整张画布打不开。
 * 策略是「逐条校验 + 丢弃坏行」，而不是整体失败。
 */
export function deserializeCanvasDocument(raw: unknown): CanvasDocument | null {
  if (!raw || typeof raw !== 'object') return null
  const doc = raw as Partial<CanvasDocRecord>
  if (!Array.isArray(doc.nodes)) return null

  const seen = new Set<string>()
  const nodes: CanvasNodeData[] = []
  for (const item of doc.nodes) {
    if (!item || typeof item !== 'object') continue
    const n = item as Partial<CanvasNodeData>
    if (typeof n.id !== 'string' || !n.id || seen.has(n.id)) continue
    if (!NODE_TYPES.includes(n.type as CanvasNodeType)) continue
    if (!isFiniteNumber(n.x) || !isFiniteNumber(n.y)) continue
    if (!isFiniteNumber(n.width) || !isFiniteNumber(n.height)) continue
    seen.add(n.id)
    nodes.push({
      id: n.id,
      type: n.type as CanvasNodeType,
      x: Math.round(n.x),
      y: Math.round(n.y),
      width: Math.round(clamp(n.width, 80, 4000)),
      height: Math.round(clamp(n.height, 40, 4000)),
      metadata: n.metadata && typeof n.metadata === 'object' ? { ...(n.metadata as Record<string, unknown>) } : {},
      zIndex: isFiniteNumber(n.zIndex) ? n.zIndex : 1
    })
  }

  const conns: CanvasConnection[] = []
  const connSeen = new Set<string>()
  if (Array.isArray(doc.connections)) {
    for (const item of doc.connections) {
      if (!item || typeof item !== 'object') continue
      const c = item as Partial<CanvasConnection>
      if (typeof c.id !== 'string' || !c.id || connSeen.has(c.id)) continue
      if (typeof c.from !== 'string' || typeof c.to !== 'string') continue
      if (c.from === c.to || !seen.has(c.from) || !seen.has(c.to)) continue
      connSeen.add(c.id)
      conns.push({ id: c.id, from: c.from, to: c.to })
    }
  }

  const vp = (doc.viewport ?? {}) as Partial<ViewportTransform>
  const viewport: ViewportTransform = {
    x: isFiniteNumber(vp.x) ? vp.x : 80,
    y: isFiniteNumber(vp.y) ? vp.y : 80,
    k: isFiniteNumber(vp.k) ? clamp(vp.k, 0.05, 5) : 1
  }
  return { nodes, connections: conns, viewport }
}

/** 文档是否有内容（空文档不必写库，也避免覆盖已有内容） */
export function isCanvasDocumentEmpty(doc: CanvasDocument): boolean {
  return doc.nodes.length === 0 && doc.connections.length === 0
}
