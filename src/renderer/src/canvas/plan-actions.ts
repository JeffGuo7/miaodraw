/**
 * 计划动作层（C2）—— 计划卡与对话的**同一条**确认路径。
 *
 * 硬约束（Jeff 批）：双向镜像去重用 `source_message_id` + `request_id`，且**去重判定先于写 plan_events**
 * （否则事件流出现幽灵记录）。这里先查镜像消息是否已存在，存在就直接返回，不再调 IPC。
 */
import type { StageRecord } from './plan-types'

import { appendMessage, getMessages } from './chat-store'

export type StageActionKind = 'confirm_plan' | 'confirm_result' | 'retry'

const MIRROR_PREFIX = 'mirror:'

/** 镜像消息的稳定 id：同 (plan, stage, action) 只应存在一条 */
export function mirrorId(planId: string, stageId: string, action: StageActionKind): string {
  return `${MIRROR_PREFIX}${planId}:${stageId}:${action}`
}

export function hasMirror(planId: string, stageId: string, action: StageActionKind): boolean {
  const id = mirrorId(planId, stageId, action)
  return getMessages(planId).some((m) => m.source_message_id === id || m.id === id)
}

function describe(stage: StageRecord, action: StageActionKind): string {
  const label = `第 ${stage.order} 阶段「${stage.name}」`
  if (action === 'confirm_plan') return `确认${label}的计划`
  if (action === 'confirm_result') return `确认${label}的结果`
  return `重试${label}`
}

export interface ActionOutcome {
  status: 'done' | 'skipped' | 'conflict' | 'error'
  detail?: string
}

/**
 * 计划卡按钮 → 等价消息 → 推进（actor=ui）。
 * 镜像消息带 source_message_id/request_id；重复点击直接返回 skipped，不产生新事件。
 */
export async function actViaCard(planId: string, stage: StageRecord, action: StageActionKind): Promise<ActionOutcome> {
  if (hasMirror(planId, stage.id, action)) return { status: 'skipped', detail: '该动作已处理过（镜像去重）' }
  const mid = mirrorId(planId, stage.id, action)
  // 先落镜像消息（带去重键），再调 IPC —— 去重判定已在上面完成
  await appendMessage({ planId, role: 'user', content: describe(stage, action), sourceMessageId: mid, requestId: mid })
  const res = (await window.api.planAdvance({ planId, stageId: stage.id, action, expectedRevision: stage.revision, actor: 'ui' })) as {
    ok?: boolean
    conflict?: boolean
    error?: string
  }
  if (res?.ok) return { status: 'done' }
  if (res?.conflict) {
    await appendMessage({ planId, role: 'system', content: '计划已更新（revision 变化），已为你刷新，请确认最新版本。' })
    return { status: 'conflict' }
  }
  await appendMessage({ planId, role: 'system', content: `操作失败：${res?.error ?? '未知原因'}` })
  return { status: 'error', detail: res?.error }
}

/** 聊天文本 → 动作（actor=chat）。C2 只处理确认/重试；其余交给 C3/C5 的增量分类 */
export function classifyChatAction(text: string): 'confirm' | 'retry' | null {
  const t = text.trim()
  if (/(重试|重跑|再做一次|打回|不通过)/.test(t)) return 'retry'
  if (/(确认|通过|可以|没问题|ok|OK|好的)/.test(t)) return 'confirm'
  return null
}

/** 按当前闸门把「确认」落到具体动作：计划确认 vs 结果确认（避免结果确认被误判为计划确认） */
export function resolveStageAction(text: string, stages: StageRecord[]): StageActionKind | null {
  const kind = classifyChatAction(text)
  if (!kind) return null
  if (kind === 'retry') return 'retry'
  if (stages.some((s) => s.status === 'waiting_user' && s.waiting_reason === 'plan_review')) return 'confirm_plan'
  if (stages.some((s) => s.status === 'waiting_user' && s.waiting_reason === 'result_review')) return 'confirm_result'
  return null
}

/**
 * 当前应处理的阶段：优先刚落 plan_review/result_review 的那个。
 * 聊天确认不带 stage id，因此按闸门类型挑目标阶段（不跨阶段批量确认）。
 */
export function pickGateStage(stages: StageRecord[], action: StageActionKind): StageRecord | null {
  const want: StageRecord['waiting_reason'] = action === 'confirm_plan' ? 'plan_review' : 'result_review'
  if (action === 'retry') {
    const active = stages.find((s) => s.status === 'doing' || s.status === 'blocked' || s.waiting_reason === 'result_review')
    return active ?? null
  }
  return stages.find((s) => s.status === 'waiting_user' && s.waiting_reason === want) ?? null
}

/** 聊天路径：确认/重试走同一条 IPC（actor=chat），并把用户原话落库 */
export async function actViaChat(planId: string, text: string, stages: StageRecord[]): Promise<ActionOutcome> {
  const action = resolveStageAction(text, stages)
  if (!action) return { status: 'skipped', detail: '非确认类消息或当前无闸门' }
  const stage = pickGateStage(stages, action)
  if (!stage) return { status: 'skipped', detail: '当前没有待确认的阶段' }
  const mid = mirrorId(planId, stage.id, action)
  await appendMessage({ planId, role: 'user', content: text, sourceMessageId: mid, requestId: mid })
  const res = (await window.api.planAdvance({ planId, stageId: stage.id, action, expectedRevision: stage.revision, actor: 'chat' })) as {
    ok?: boolean
    conflict?: boolean
    error?: string
  }
  if (res?.ok) {
    await appendMessage({ planId, role: 'agent', content: `已按你的确认推进「${stage.name}」` })
    return { status: 'done' }
  }
  if (res?.conflict) {
    await appendMessage({ planId, role: 'system', content: '计划刚刚被更新过，请再说一次确认（已刷新最新状态）。' })
    return { status: 'conflict' }
  }
  await appendMessage({ planId, role: 'system', content: `操作失败：${res?.error ?? '未知原因'}` })
  return { status: 'error', detail: res?.error }
}
