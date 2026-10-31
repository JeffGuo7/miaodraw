/**
 * 画布文档持久化：自动保存 + 启动水合 + 清空重置。
 *
 * 为什么必须做：此前画布状态只活在 renderer 内存里，关掉应用重开只剩计划卡，
 * 用户画了半天的节点/连线全部消失——「无限画布」没有持久化就只是个演示。
 *
 * 三个防护：
 *   1. 800ms 防抖：拖动/连线不会每帧写库；页面隐藏、关闭前强制 flush。
 *   2. 水合只在内存为空时执行：避免异步加载把用户已经画上的内容覆盖掉。
 *   3. 保存期间 suspend：水合/重置/撤销恢复写入时不回写，避免自激。
 */
import { canvasStore, subscribeAny, subscribeGeometryChange } from './store'
import { clearCanvasDoc, loadCanvasDoc, saveCanvasDoc } from './db'
import { DEFAULT_CANVAS_DOC_ID, deserializeCanvasDocument, isCanvasDocumentEmpty, serializeCanvasDocument } from './canvas-doc'
import type { CanvasDocRecord } from './canvas-doc'

/** 保存状态事件：画布页据此显示"已保存 / 未保存"并给出失败提示 */
export const CANVAS_DOC_SAVED_EVENT = 'canvas-doc-saved'
export const CANVAS_DOC_SAVE_ERROR_EVENT = 'canvas-doc-save-error'

function emitDocEvent(name: string, detail: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {
    /* 非浏览器环境（单测）忽略 */
  }
}

/** 写库防抖：拖动结束后 800ms 落盘 */
const SAVE_DEBOUNCE_MS = 800

let timer: number | null = null
let detach: (() => void) | null = null
let suspended = 0
let lastSavedAt = 0

export interface SaveResult {
  saved: boolean
  nodes: number
  reason?: 'suspended' | 'empty' | 'error'
}

/** 暂停自动保存（水合/重置/撤销恢复期间用） */
export function suspendCanvasDocSave(): void {
  suspended++
}

export function resumeCanvasDocSave(): void {
  suspended = Math.max(0, suspended - 1)
}

function currentDocument(): { nodes: ReturnType<typeof canvasStore.getState>['nodes']; connections: ReturnType<typeof canvasStore.getState>['connections']; viewport: ReturnType<typeof canvasStore.getState>['viewport'] } {
  const st = canvasStore.getState()
  return { nodes: st.nodes, connections: st.connections, viewport: st.viewport }
}

/** 立即落盘（页面隐藏/关闭/手动保存用） */
export async function saveCanvasDocumentNow(): Promise<SaveResult> {
  if (suspended > 0) return { saved: false, nodes: 0, reason: 'suspended' }
  const doc = currentDocument()
  if (doc.nodes.length === 0 && doc.connections.length === 0) {
    // 空画布要删掉旧文档，否则「清空后重开又回来」比不保存更吓人
    try {
      await clearCanvasDoc(DEFAULT_CANVAS_DOC_ID)
    } catch (e) {
      console.warn('[canvas] 清空文档失败：', e)
    }
    return { saved: false, nodes: 0, reason: 'empty' }
  }
  try {
    const record = serializeCanvasDocument(doc, Date.now())
    await saveCanvasDoc(record as unknown as Record<string, unknown>)
    lastSavedAt = record.updated_at
    emitDocEvent('canvas-doc-saved', { at: lastSavedAt, nodes: record.nodes.length })
    return { saved: true, nodes: record.nodes.length }
  } catch (e) {
    // 写库失败不能只 console.warn：用户以为已保存，重开就没了
    const detail = e instanceof Error ? e.message : String(e)
    console.warn('[canvas] 保存画布文档失败：', e)
    emitDocEvent('canvas-doc-save-error', { detail })
    return { saved: false, nodes: 0, reason: 'error' }
  }
}

function scheduleSave(): void {
  if (suspended > 0) return
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    void saveCanvasDocumentNow()
  }, SAVE_DEBOUNCE_MS)
}

/** 挂载自动保存（画布页挂载时调用一次；返回卸载函数） */
export function attachCanvasDocPersistence(): () => void {
  if (detach) return detach
  const offAny = subscribeAny(scheduleSave)
  const offGeometry = subscribeGeometryChange(scheduleSave)
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      if (timer) {
        window.clearTimeout(timer)
        timer = null
      }
      void saveCanvasDocumentNow()
    }
  }
  const onBeforeUnload = (): void => {
    void saveCanvasDocumentNow()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('beforeunload', onBeforeUnload)
  detach = () => {
    offAny()
    offGeometry()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('beforeunload', onBeforeUnload)
    if (timer) {
      window.clearTimeout(timer)
      timer = null
    }
    detach = null
  }
  return detach
}

/**
 * 启动水合：把上次的文档读回内存。
 * 只在当前内存为空时执行（多标签/热重载时不覆盖用户正在编辑的内容）。
 */
export async function hydrateCanvasDocument(): Promise<{ restored: number } | null> {
  if (canvasStore.getState().nodes.length > 0) return null
  let raw: Record<string, unknown> | undefined
  try {
    raw = await loadCanvasDoc(DEFAULT_CANVAS_DOC_ID)
  } catch (e) {
    console.warn('[canvas] 读取画布文档失败：', e)
    return null
  }
  const doc = deserializeCanvasDocument(raw)
  if (!doc || isCanvasDocumentEmpty(doc)) return null
  suspendCanvasDocSave()
  try {
    canvasStore.restore({ nodes: doc.nodes, connections: doc.connections })
    canvasStore.setViewport(doc.viewport)
  } finally {
    resumeCanvasDocSave()
  }
  return { restored: doc.nodes.length }
}

/** 清空画布（用户主动重置）：删文档 + 清内存，不保留历史 */
export async function resetCanvasDocument(): Promise<void> {
  suspendCanvasDocSave()
  try {
    await clearCanvasDoc(DEFAULT_CANVAS_DOC_ID)
    canvasStore.restore({ nodes: [], connections: [] })
    canvasStore.setViewport({ x: 80, y: 80, k: 1 })
  } finally {
    resumeCanvasDocSave()
  }
}

/** 最近一次成功保存时间（调试/探针用） */
export function canvasDocSavedAt(): number {
  return lastSavedAt
}

export type { CanvasDocRecord }
