/**
 * 滚轮意图判定 —— 同一台机器上「鼠标滚轮」和「触控板双指」的 wheel 事件长得完全不同：
 * 触控板是小步长 + 高频，滚轮是整十步长（100/120）+ 稀疏。不做判定的结果就是
 * 「有人觉得滚轮该缩放，有人觉得该平移」，同一份软件在不同电脑上体验不一致。
 *
 * 判定规则（参考 BeefTV 的 canvas-wheel）：
 * 1. Ctrl/Meta + wheel（触控板捏合会被浏览器转成这个）→ 恒为缩放；
 * 2. Shift 或存在横向 delta → 平移（保住双指横滑/Shift 滚轮平移的肌肉记忆）；
 * 3. 用户在设置里显式选了 zoom / pan → 直接听用户的；
 * 4. auto：200ms 内沿用上一手势意图，避免一次手势被拆成缩放+平移来回跳；
 * 5. 行模式（Firefox 等）或整十步长 ≥40 → 认为是滚轮 → 缩放；否则小步长 → 触控板 → 平移。
 */

export type WheelBehavior = 'auto' | 'zoom' | 'pan'
export type WheelIntent = 'pan' | 'zoom'

export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export interface WheelGesture {
  intent: WheelIntent
  at: number
}

/** 同一手势的判定延续窗口（毫秒） */
const GESTURE_MEMORY_MS = 200
/** 整十步长阈值：小于它更可能是触控板小步长 */
const WHEEL_STEP_THRESHOLD = 40
const WHEEL_STEP_MODULUS = 20

/**
 * wheel 事件 Δ 归一化到「像素」：行模式 ×16，页模式 ×720（与 Chrome 的默认行高/页高一致）。
 * 不归一化会导致 Firefox/远程桌面下缩放一步跳 20 倍。
 */
export function wheelDeltaToPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16
  if (deltaMode === 2) return delta * 720
  return delta
}

export function resolveWheelIntent(
  event: WheelLike,
  previous: WheelGesture | null,
  now: number,
  behavior: WheelBehavior = 'auto'
): WheelIntent {
  if (event.ctrlKey || event.metaKey) return 'zoom'
  if (event.shiftKey || Math.abs(event.deltaX) > 0) return 'pan'
  if (behavior === 'zoom' || behavior === 'pan') return behavior
  if (previous && now - previous.at < GESTURE_MEMORY_MS) return previous.intent
  const magnitude = Math.abs(event.deltaY)
  const looksLikeWheel =
    event.deltaMode !== 0 || (magnitude >= WHEEL_STEP_THRESHOLD && magnitude % WHEEL_STEP_MODULUS === 0)
  return looksLikeWheel ? 'zoom' : 'pan'
}

/** 缩放因子：滚轮一步（Δ=100）约 1.16 倍，触控板捏合更细腻 */
export function wheelZoomFactor(deltaY: number, ctrlKey: boolean): number {
  const step = ctrlKey ? 24 : 72
  return Math.pow(1.1, -deltaY / step)
}
