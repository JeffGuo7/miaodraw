/**
 * 连线规则（纯函数，可 node --test 直跑）。
 *
 * 背景：画布此前允许任意节点相连，结果「连了但在生成时被静默忽略」，用户以为建立了数据依赖。
 * 这里按节点语义定义「谁可以喂给谁」，非法连线当场拒绝并给出原因。
 * 规则保持宽松（宁可放行也不误伤真实工作流）：只拦明显没有数据依赖的组合。
 */
import type { CanvasNodeData, CanvasNodeType } from './types'

export interface ConnectCheck {
  ok: boolean
  reason?: string
}

const LABEL: Record<CanvasNodeType, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  config: '配置',
  group: '分组',
  generate: '出图',
  plan: '计划'
}

/** 源类型 → 允许的目标类型 */
const ALLOWED: Record<CanvasNodeType, CanvasNodeType[]> = {
  text: ['generate', 'video'],
  image: ['generate', 'video'],
  audio: ['video'],
  config: ['generate', 'video'],
  // 出图产物可以继续作为下游生成的参考/首帧
  generate: ['generate', 'video'],
  video: [],
  group: [],
  plan: []
}

export function canConnect(from: CanvasNodeData, to: CanvasNodeData): ConnectCheck {
  if (from.id === to.id) return { ok: false, reason: '不能连到自己' }
  if (from.type === 'group' || to.type === 'group') return { ok: false, reason: '分组不参与连线' }
  if (from.type === 'plan' || to.type === 'plan') return { ok: false, reason: '计划卡不参与连线' }
  const allowed = ALLOWED[from.type] ?? []
  if (!allowed.includes(to.type)) {
    return { ok: false, reason: LABEL[from.type] + ' 不能连到 ' + LABEL[to.type] + '（没有数据依赖）' }
  }
  return { ok: true }
}
