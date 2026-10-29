/**
 * 对话 store（C1）—— **独立于画布 store**，按 planId 选择器订阅。
 *
 * 硬约束（Jeff 批）：对话/计划刷新不得走全局 useCanvasState()，否则全画布跟着重渲染。
 * 这里用 useSyncExternalStore + 每 planId 独立快照，聊天收发只重渲染面板自身。
 */
import { useCallback, useSyncExternalStore } from 'react'

import type { ChatMessage, ChatRole } from '../../../shared/plan-types'

import { deleteMessage, listMessagesByPlan, putMessage } from './db'

/** 每个 planId 一份消息数组（含 null 键代表"尚未建计划"的草稿会话） */
const byPlan = new Map<string, ChatMessage[]>()
const listeners = new Map<string, Set<() => void>>()

/** 探针诊断用：最近一次 plan:create 结果（SHOT_PLAN_CHAT 断言 drafting） */
let lastCreateResult: unknown = null
export function setLastCreateResult(r: unknown): void {
  lastCreateResult = r
}
export function getLastCreateResult(): unknown {
  return lastCreateResult
}
function injectAnywhere(role: ChatRole, content: string): void {
  const keys = byPlan.size > 0 ? [...byPlan.keys()] : [DRAFT_KEY]
  for (const k of keys) {
    const msg: ChatMessage = { id: newId(), plan_id: k === DRAFT_KEY ? null : k, role, content, source_message_id: null, created_at: Date.now() }
    byPlan.set(k, [...(byPlan.get(k) ?? []), msg].slice(-50))
    emit(k)
  }
}

if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>
  w.__canvasChat = { getLastCreateResult, getMessages, messageCount }
  // 探针专用：模拟消息到达/发送（不落盘），用于「对话活动不得触发画布重渲染」断言
  w.__canvasChatInject = injectAnywhere
}

const DRAFT_KEY = '__draft__'

function keyOf(planId: string | null): string {
  return planId ?? DRAFT_KEY
}

function emit(key: string): void {
  listeners.get(key)?.forEach((l) => l())
}

export function subscribeChat(planId: string | null, cb: () => void): () => void {
  const key = keyOf(planId)
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key)?.add(cb)
  return () => {
    listeners.get(key)?.delete(cb)
  }
}

/** 稳定空数组：useSyncExternalStore 的 getSnapshot 必须返回同一引用，否则无限重渲染 */
const EMPTY: ChatMessage[] = []

/** 同步快照：同 key 返回同一引用，直到有新消息（useSyncExternalStore 要求） */
export function getMessages(planId: string | null): ChatMessage[] {
  return byPlan.get(keyOf(planId)) ?? EMPTY
}

export function messageCount(planId: string | null): number {
  return getMessages(planId).length
}

function newId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 追加一条消息：先落盘再通知（面板即时可见，重启可恢复） */
export async function appendMessage(input: {
  planId: string | null
  role: ChatRole
  content: string
  sourceMessageId?: string | null
  requestId?: string | null
}): Promise<ChatMessage> {
  const msg: ChatMessage = {
    id: newId(),
    plan_id: input.planId,
    role: input.role,
    content: input.content,
    source_message_id: input.sourceMessageId ?? null,
    request_id: input.requestId ?? null,
    created_at: Date.now()
  }
  const key = keyOf(input.planId)
  const next = [...(byPlan.get(key) ?? []), msg].slice(-50) // 只保留最近 50 条
  byPlan.set(key, next)
  emit(key)
  void putMessage(msg).catch((e) => console.warn('[chat] 消息落盘失败：', e instanceof Error ? e.message : e))
  return msg
}

/** 删除一条消息（镜像失败回滚用）：内存与 IndexedDB 同删，避免去重键永久占位 */
export async function removeMessage(planId: string | null, id: string): Promise<void> {
  const key = keyOf(planId)
  const cur = byPlan.get(key) ?? []
  const next = cur.filter((m) => m.id !== id)
  if (next.length === cur.length) return
  byPlan.set(key, next)
  emit(key)
  await deleteMessage(id).catch((e) => console.warn('[chat] 消息删除失败：', e instanceof Error ? e.message : e))
}

/**
 * 撤销镜像去重键（保留消息正文）：动作失败后如果留着 source_message_id，
 * 同阶段同动作会被永久判定为「已处理」，表现为按钮点了没反应。
 */
export async function detachMirror(planId: string | null, mirrorKey: string): Promise<void> {
  const key = keyOf(planId)
  const cur = byPlan.get(key) ?? []
  const idx = cur.findIndex((m) => m.source_message_id === mirrorKey)
  if (idx < 0) return
  const next = cur.slice()
  next[idx] = { ...next[idx], source_message_id: null }
  byPlan.set(key, next)
  emit(key)
  await putMessage(next[idx]).catch((e) => console.warn('[chat] 镜像回滚落盘失败：', e instanceof Error ? e.message : e))
}

/** 从 IndexedDB 载入某计划的历史（重启恢复；不覆盖已有内存态） */
export async function loadMessages(planId: string | null): Promise<ChatMessage[]> {
  const key = keyOf(planId)
  if ((byPlan.get(key)?.length ?? 0) > 0) return getMessages(planId)
  const rows = planId ? await listMessagesByPlan(planId, 50) : []
  byPlan.set(key, rows)
  emit(key)
  return rows
}

/** 面板订阅入口（按 planId 选择器；subscribe 用 useCallback 稳定身份） */
export function useChatMessages(planId: string | null): ChatMessage[] {
  const subscribe = useCallback((cb: () => void) => subscribeChat(planId, cb), [planId])
  const snapshot = useCallback(() => getMessages(planId), [planId])
  return useSyncExternalStore(subscribe, snapshot)
}

/** 测试/探针用：直接注入消息（不落盘），用于重渲染断言 */
/** 清空内存态（探针在用例间隔离用） */
