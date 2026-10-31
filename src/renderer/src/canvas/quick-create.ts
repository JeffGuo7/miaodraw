/**
 * 快速创建请求总线 —— 端口点击 / 空白落点 / 双击空白 都汇流到这里。
 *
 * 为什么用总线而不是 props：创建菜单是「屏幕空间」浮层（拍在 CanvasWorkbench 上），
 * 请求源却在世界空间里（CanvasNode 的端口、画布空白）。用模块级总线可以避免
 * 把回调一路透传进 memo 化的 CanvasNode，也不会因为回调身份变化引发重渲染。
 */

export interface QuickCreateRequest {
  /** 世界坐标落点（新节点左上角会围绕它避让） */
  world: { x: number; y: number }
  /** 从端口点开时记录源节点，选中类型后自动连线回源 */
  sourceNodeId: string | null
  /** 屏幕坐标（相对画布容器），用于定位菜单 */
  screen: { x: number; y: number }
  /** 触发方式，仅用于探针/日志区分 */
  origin: 'port' | 'canvas' | 'double-click' | 'shortcut'
}

const listeners = new Set<(req: QuickCreateRequest) => void>()
let pending: QuickCreateRequest | null = null

export function requestQuickCreate(req: QuickCreateRequest): void {
  pending = req
  listeners.forEach((l) => l(req))
}

export function subscribeQuickCreate(listener: (req: QuickCreateRequest) => void): () => void {
  listeners.add(listener)
  if (pending) listener(pending)
  return () => listeners.delete(listener)
}

/** 创建菜单关闭后清掉待处理请求，避免下次挂载重复弹出 */
export function clearQuickCreate(): void {
  pending = null
}
