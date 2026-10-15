/**
 * 画布容器 rect 缓存（P0-3）—— 干掉拖动/连线路径上每帧的 document.querySelector + getBoundingClientRect。
 *
 * 由 InfiniteCanvas 在挂载时 attach；ResizeObserver + window resize/scroll 时失效重建。
 * 拖动/连线的热路径只做算术，不再读布局（避免强制同步 layout）。
 */

let cached: DOMRect | null = null
let target: HTMLElement | null = null
let observer: ResizeObserver | null = null
let listening = false

function measure(): DOMRect | null {
  if (!target) return null
  cached = target.getBoundingClientRect()
  return cached
}

function onWindowChange(): void {
  measure()
}

function ensureListeners(): void {
  if (listening) return
  listening = true
  window.addEventListener('resize', onWindowChange)
  window.addEventListener('scroll', onWindowChange, true)
}

function removeListeners(): void {
  if (!listening) return
  listening = false
  window.removeEventListener('resize', onWindowChange)
  window.removeEventListener('scroll', onWindowChange, true)
}

/** 挂载画布根元素（InfiniteCanvas 调用；传 null 表示卸载） */
export function attachCanvasRect(el: HTMLElement | null): void {
  observer?.disconnect()
  observer = null
  target = el
  if (!el) {
    cached = null
    removeListeners()
    return
  }
  measure()
  ensureListeners()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => measure())
    observer.observe(el)
  }
}

/** 取缓存的容器 rect（无缓存时测一次） */
export function getCanvasRect(): DOMRect {
  if (cached) return cached
  return measure() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

/** 手动失效（如窗口拖动结束后） */
export function invalidateCanvasRect(): void {
  measure()
}

/** 屏幕坐标 → 世界坐标（热路径，只做算术） */
export function clientToWorld(clientX: number, clientY: number, viewport: { x: number; y: number; k: number }): { x: number; y: number } {
  const rect = getCanvasRect()
  const k = viewport.k > 0 ? viewport.k : 1
  return { x: (clientX - rect.left - viewport.x) / k, y: (clientY - rect.top - viewport.y) / k }
}

/** 世界坐标 → 屏幕坐标（用于把 pending 线画在 DOM 层时定位） */
export function worldToClient(worldX: number, worldY: number, viewport: { x: number; y: number; k: number }): { x: number; y: number } {
  const rect = getCanvasRect()
  return { x: worldX * viewport.k + viewport.x + rect.left, y: worldY * viewport.k + viewport.y + rect.top }
}
