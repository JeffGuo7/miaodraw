/**
 * 路由（O1）—— 判断"这活儿要不要升格成流程"，纯函数、无 LLM（O3 再接 LLM 分类）。
 *
 * 设计稿 §4：image-only 的直接执行不建工程；多阶段/视频/成片类需求才升格。
 */
import type { RoutingCapsule, WorkflowId, WorkflowSpec } from '../../shared/plan-types'

import singleImage from './workflows/single-image.json' with { type: 'json' }
import imageToVideo from './workflows/image-to-video.json' with { type: 'json' }
import docToVideo from './workflows/doc-to-video.json' with { type: 'json' }

export const WORKFLOWS: WorkflowSpec[] = [singleImage, imageToVideo, docToVideo] as unknown as WorkflowSpec[]

export function getWorkflow(id: WorkflowId | string): WorkflowSpec | null {
  return WORKFLOWS.find((w) => w.id === id) ?? null
}

export interface RouteContext {
  /** 画布上是否已有可用的图片素材（决定图生视频是否可行） */
  hasImage?: boolean
  /** 是否已有文案素材 */
  hasText?: boolean
  /** Pixelle 后端子进程是否就绪（视频阶段不可用时降级） */
  pixelleReady?: boolean
}

/** 强流程信号：出现这些词就不要走 direct path */
const STRONG_WORKFLOW_HINTS = ['做成视频', '成片', '短视频', '配画面', '口播', '分镜', '文案变视频', '工作流']

function hit(text: string, words: string[]): number {
  return words.reduce((n, w) => (text.includes(w) ? n + 1 : n), 0)
}

/**
 * 纯规则路由（O1 骨架版）：命中强流程信号 → 选流程；否则直连出图。
 * O3 会把这里换成一次 LLM 分类，函数签名与返回结构保持不变。
 */
export function classify(prompt: string, ctx: RouteContext = {}): RoutingCapsule {
  const text = (prompt ?? '').trim()
  if (!text) return { route_kind: 'ask', workflow_id: null, reason: '需求为空', question: '想做什么？用一句话描述即可' }

  const strong = hit(text, STRONG_WORKFLOW_HINTS)
  const v2v = hit(text, imageToVideo.match.keywords)
  const d2v = hit(text, docToVideo.match.keywords)

  // 视频流程：先判断素材条件，条件不足就问用户，不猜
  if (strong > 0 || v2v > 0 || d2v > 0) {
    // 只有显式 false（已知不可用）才降级；未传（未知）按可用处理，执行前闸门再兜
    if (ctx.pixelleReady === false) {
      return {
        route_kind: 'workflow',
        workflow_id: 'single-image',
        reason: '视频链路当前不可用（Pixelle 未就绪），先按出图流程走，可在看板上修复后重开'
      }
    }
    if (v2v > 0 && ctx.hasImage) {
      return { route_kind: 'workflow', workflow_id: 'image-to-video', reason: '已有参考图且要求动起来 → 图生视频流程' }
    }
    if (v2v > 0 && !ctx.hasImage) {
      return { route_kind: 'ask', workflow_id: null, reason: '图生视频需要一张参考图', question: '先给我一张参考图（拖进画布或上传），或者改成纯文字生成' }
    }
    return { route_kind: 'workflow', workflow_id: 'doc-to-video', reason: '文案成片需求 → 文案成片流程' }
  }

  // 直连：单张出图不建工程（设计稿 §1 边界）
  return { route_kind: 'direct', workflow_id: null, reason: '单张出图，直接生成', direct_action: 'generate_image' }
}
