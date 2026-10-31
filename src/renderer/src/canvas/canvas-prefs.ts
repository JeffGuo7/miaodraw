/**
 * 画布偏好（背景样式 / 滚轮行为 / 网格吸附）—— localStorage 持久化 + 订阅。
 *
 * 单独成文件的原因：这些是「怎么看画布」的偏好，不属于画布文档（store），也不属于主题 token，
 * 换项目不应该重置、导出文档也不该带上。
 */
import type { WheelBehavior } from './canvas-wheel'

export type CanvasBackgroundMode = 'dots' | 'lines' | 'blank'

export interface CanvasPrefs {
  backgroundMode: CanvasBackgroundMode
  wheelBehavior: WheelBehavior
  snapToGrid: boolean
}

const KEY = 'miaodraw:canvas-prefs:v1'

export const DEFAULT_CANVAS_PREFS: CanvasPrefs = {
  backgroundMode: 'dots',
  wheelBehavior: 'auto',
  snapToGrid: true
}

const listeners = new Set<() => void>()
let current: CanvasPrefs = read()

function read(): CanvasPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_CANVAS_PREFS }
    const parsed = JSON.parse(raw) as Partial<CanvasPrefs>
    return {
      backgroundMode:
        parsed.backgroundMode === 'lines' || parsed.backgroundMode === 'blank' ? parsed.backgroundMode : 'dots',
      wheelBehavior:
        parsed.wheelBehavior === 'zoom' || parsed.wheelBehavior === 'pan' ? parsed.wheelBehavior : 'auto',
      snapToGrid: parsed.snapToGrid !== false
    }
  } catch {
    return { ...DEFAULT_CANVAS_PREFS }
  }
}

export function getCanvasPrefs(): CanvasPrefs {
  return current
}

export function setCanvasPrefs(patch: Partial<CanvasPrefs>): void {
  const next = { ...current, ...patch }
  if (next.backgroundMode === current.backgroundMode && next.wheelBehavior === current.wheelBehavior && next.snapToGrid === current.snapToGrid) {
    return
  }
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // 隐私模式/配额满时忽略：偏好丢失不影响功能
  }
  listeners.forEach((l) => l())
}

export function subscribeCanvasPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
