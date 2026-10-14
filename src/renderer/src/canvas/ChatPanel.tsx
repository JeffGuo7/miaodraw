/**
 * 计划对话面板（C1）—— 画布级 overlay，**不新增画布节点类型**。
 *
 * 行为：
 * - 输入需求 → 落一条 user 消息 + 建计划（`plan:create` 立即返回 drafting，进度靠事件推进）
 * - 订阅 plan:changed（按 planId），阶段就绪时落一条 agent 消息（只记一次，避免刷屏）
 * - 只渲染最近 50 条；输入框聚焦时画布快捷键已被 isFormTarget 排除
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Button, Empty, Input, Spin, Tag, Typography } from 'antd'
import { CloseOutlined, MessageOutlined, SendOutlined } from '@ant-design/icons'

import type { ChatMessage, StageRecord } from './plan-types'

import { appendMessage, loadMessages, setLastCreateResult, useChatMessages } from './chat-store'

interface Props {
  open: boolean
  onClose: () => void
}

interface PlanSnapshotLite {
  plan: { id: string; status: string; stage_outline: Array<{ id: string; order: number; name: string }> }
  stages: StageRecord[]
}

const ROLE_STYLE: Record<string, { bg: string; label: string }> = {
  user: { bg: '#e6f4ff', label: '我' },
  agent: { bg: '#f6ffed', label: '助手' },
  tool: { bg: '#fff7e6', label: '执行' },
  system: { bg: '#fafafa', label: '系统' }
}

export default function ChatPanel({ open, onClose }: Props): JSX.Element | null {
  const [planId, setPlanId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const messages = useChatMessages(planId)
  const listRef = useRef<HTMLDivElement | null>(null)
  const notedStages = useRef<Set<string>>(new Set())

  // 订阅计划变更（按 planId；只影响本面板，不触发画布重渲染）
  useEffect(() => {
    if (!planId) return
    const off = window.api.onPlanChanged((raw) => {
      const snap = raw as PlanSnapshotLite | undefined
      if (!snap?.plan?.id || snap.plan.id !== planId) return
      for (const stage of snap.stages ?? []) {
        const key = `${snap.plan.id}:${stage.id}:${stage.status}:${stage.waiting_reason}`
        if (notedStages.current.has(key)) continue
        notedStages.current.add(key)
        if (stage.waiting_reason === 'plan_review') {
          void appendMessage({ planId, role: 'agent', content: `阶段「${stage.name}」已就绪，待确认（可改提示词后执行）` })
        } else if (stage.waiting_reason === 'result_review') {
          void appendMessage({ planId, role: 'agent', content: `阶段「${stage.name}」已执行完，待验收结果` })
        } else if (stage.status === 'done') {
          void appendMessage({ planId, role: 'tool', content: `阶段「${stage.name}」已完成` })
        }
      }
    })
    return off
  }, [planId])

  // 打开时载入历史（重启恢复）
  useEffect(() => {
    if (!open) return
    void (async () => {
      if (!planId) return
      await loadMessages(planId)
    })()
  }, [open, planId])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages])

  const send = useCallback(async (): Promise<void> => {
    const content = text.trim()
    if (!content || busy) return
    setText('')
    setBusy(true)
    try {
      if (!planId) {
        // 首条消息：立即落 user 行 + 建计划（plan:create 同步返回 drafting，不阻塞输入）
        const created = (await window.api.planCreate({ prompt: content, canvasContext: { pixelleReady: true } })) as {
          kind?: string
          planId?: string
          status?: string
        }
        setLastCreateResult(created)
        if (created.kind === 'plan' && created.planId) {
          setPlanId(created.planId)
          await appendMessage({ planId: created.planId, role: 'user', content })
          await appendMessage({ planId: created.planId, role: 'agent', content: '已开始规划，首个阶段就绪后会在这里提示你确认。' })
        } else {
          await appendMessage({ planId: null, role: 'system', content: '这个需求不需要建流程，已按直连出图处理。' })
        }
      } else {
        // 已有计划：C2 会接 plan:chat 三档分类；C1 只落消息
        await appendMessage({ planId, role: 'user', content })
      }
    } catch (e) {
      await appendMessage({ planId, role: 'system', content: `发送失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(false)
    }
  }, [busy, planId, text])

  if (!open) return null

  return (
    <div className="ivc-chatpanel ivc-no-zoom" data-testid="chat-panel">
      <div className="ivc-chat-header">
        <MessageOutlined />
        <span className="ivc-chat-title">计划对话</span>
        {planId ? <Tag color="blue">计划 {planId.slice(-4)}</Tag> : <Tag>未建计划</Tag>}
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
      </div>
      <div className="ivc-chat-list" ref={listRef} data-testid="chat-list">
        {messages.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="说一句你的需求，我来搭流程" />
        ) : (
          messages.slice(-50).map((m: ChatMessage) => {
            const style = ROLE_STYLE[m.role] ?? ROLE_STYLE.system
            return (
              <div key={m.id} className="ivc-chat-msg" data-role={m.role} style={{ background: style.bg }}>
                <Typography.Text type="secondary" className="ivc-chat-role">
                  {style.label}
                </Typography.Text>
                <div className="ivc-chat-content">{m.content}</div>
              </div>
            )
          })
        )}
      </div>
      <div className="ivc-chat-input">
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="说说想要什么（Enter 发送 / Shift+Enter 换行）"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={busy}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <Button type="primary" icon={busy ? <Spin size="small" /> : <SendOutlined />} onClick={() => void send()} disabled={busy || !text.trim()}>
          发送
        </Button>
      </div>
    </div>
  )
}
