/**
 * miaodraw 画布工作台 — 类型定义
 *
 * 画布引擎与节点系统移植自 basketikun/infinite-canvas（MIT License）
 * https://github.com/basketikun/infinite-canvas — 保留原作者信息与前端标识。
 */

export type ViewportTransform = { x: number; y: number; k: number }

export type CanvasNodeType = 'text' | 'image' | 'video' | 'audio' | 'config' | 'group'

export interface CanvasNodeData {
  id: string
  type: CanvasNodeType
  x: number
  y: number
  width: number
  height: number
  /** 生成参数 / 内容等元数据（M2 起接资产表） */
  metadata: Record<string, unknown>
  zIndex: number
}

/** 节点尺寸与初始元数据规格（对应 infinite-canvas 的 NODE_SPECS） */
export const NODE_SPECS: Record<CanvasNodeType, { width: number; height: number; title: string; metadata: Record<string, unknown> }> = {
  text: { width: 260, height: 120, title: '文本', metadata: { content: '' } },
  image: { width: 320, height: 320, title: '图片', metadata: { content: '', prompt: '' } },
  video: { width: 360, height: 240, title: '视频', metadata: { content: '', taskId: '' } },
  audio: { width: 300, height: 90, title: '音频', metadata: { content: '' } },
  config: { width: 280, height: 220, title: '配置', metadata: {} },
  group: { width: 480, height: 360, title: '分组', metadata: {} }
}
