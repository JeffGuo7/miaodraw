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

import type { ChatMessage, StageRecord } from '../../../shared/plan-types'

import { appendMessage, loadMessages, setLastCreateResult, useChatMessages } from './chat-store'
import { actViaChat, detectFrozenTouch } from './plan-actions'
import StageReviewCard from './StageReviewCard'

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
  const [stages, setStages] = useState<StageRecord[]>([])
  const [frozenPrompt, setFrozenPrompt] = useState<{ stageId: string; stageName: string; text: string } | null>(null)
  const messages = useChatMessages(planId)
  const listRef = useRef<HTMLDivElement | null>(null)
  const notedStages = useRef<Set<string>>(new Set())

  // 订阅计划变更（按 planId；只影响本面板，不触发画布重渲染）
  useEffect(() => {
    if (!planId) return
    const off = window.api.onPlanChanged((raw) => {
      const snap = raw as PlanSnapshotLite | undefined
      if (!snap?.plan?.id || snap.plan.id !== planId) return
      setStages((snap.stages ?? []).slice())
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

  // 种一次当前计划快照：首阶段可能在面板订阅 plan:changed 之前就已物化，避免漏掉闸门状态
  useEffect(() => {
    if (!planId) return
    let alive = true
    void (async () => {
      const s = (await window.api.planAuthored(planId)) as PlanSnapshotLite | { error?: string }
      if (alive && s && 'plan' in s) setStages((s.stages ?? []).slice())
    })()
    return () => {
      alive = false
    }
  }, [planId])

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
        const created = (await window.api.planCreate({ prompt: content, canvasContext: { videoReady: true } })) as {
          kind?: string
          planId?: string
          status?: string
          capsule?: { route_kind?: string; reason?: string; question?: string; direct_action?: 'generate_image' | 'edit_image' }
        }
        setLastCreateResult(created)
        if (created.kind === 'plan' && created.planId) {
          setPlanId(created.planId)
          await appendMessage({ planId: created.planId, role: 'user', content })
          await appendMessage({ planId: created.planId, role: 'agent', content: '已开始规划，首个阶段就绪后会在这里提示你确认。' })
        } else if (created.kind === 'ask') {
          // ask = 信息不足，必须先提问。原实现统一回「已按直连出图处理」，
          // 结果 ask 分支既不出图也不提问，用户以为在跑其实什么都没发生。
          await appendMessage({
            planId: null,
            role: 'agent',
            content:
              created.capsule?.question ||
              created.capsule?.reason ||
              '这个需求还差一些信息。请补充：画面主体、用途、期望比例（或视频时长），我再帮你搭流程。'
          })
        } else {
          // direct = 单步动作，交给创作页执行；这里只如实说明，不谎称'已出图'
          const isEdit = created.capsule?.direct_action === 'edit_image'
          const reason = created.capsule?.reason ? '（' + created.capsule.reason + '）' : ''
          await appendMessage({
            planId: null,
            role: 'agent',
            content: '这个需求适合直连' + (isEdit ? '改图' : '出图') + '，不需要多阶段流程' + reason + '。请到「创作」页发起生成。'
          })
        }
      } else {
        // 已有计划：C2 起确认/重试类消息走与计划卡同一条 IPC（actor=chat）
        const stages = ((await window.api.planAuthored(planId)) as { stages?: StageRecord[] } | undefined)?.stages ?? []
        // C5：命中冻结阶段的修改请求 → 先出范围确认卡，**未确认前不落任何变更**
        const frozen = detectFrozenTouch(content, stages)
        if (frozen) {
          await appendMessage({ planId, role: 'user', content })
          await appendMessage({
            planId,
            role: 'system',
            content: `「${frozen.name}」已冻结（已完成）。改动它需要先选处理方式：从其后重排，或新建计划。`
          })
          setFrozenPrompt({ stageId: frozen.id, stageName: frozen.name, text: content })
          return
        }
        const outcome = await actViaChat(planId, content, stages)
        if (outcome.status === 'skipped') {
          await appendMessage({ planId, role: 'user', content })
          const dup = outcome.detail?.includes('已处理') || outcome.detail?.includes('正在处理')
          await appendMessage({
            planId,
            role: 'agent',
            content: dup
              ? '这条确认已经处理过了，稍等计划卡刷新即可。'
              : '收到。要改计划请指明阶段与改法（例如「把第 2 阶段的画面改成横屏」）；确认/通过类消息会在有闸门时生效。'
          })
        }
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
          messages.slice(-50).map((m: ChatMessage, i: number) => {
            const style = ROLE_STYLE[m.role] ?? ROLE_STYLE.system
            // C3：闸门审阅卡锚定在最后一条消息之后（按 plan_id + stage_id 注入，不新增节点）
            const gateStage = stages.find((s) => s.status === 'waiting_user') ?? null
            const isLast = i === messages.slice(-50).length - 1
            return (
              <div key={m.id}>
                <div className="ivc-chat-msg" data-role={m.role} style={{ background: style.bg }}>
                  <Typography.Text type="secondary" className="ivc-chat-role">
                    {style.label}
                  </Typography.Text>
                  <div className="ivc-chat-content">{m.content}</div>
                </div>
                {isLast && gateStage && planId && (
                  <StageReviewCard
                    planId={planId}
                    stage={gateStage}
                    onStageChanged={(s) => setStages((prev) => prev.map((x) => (x.id === s.id ? s : x)))}
                  />
                )}
              </div>
            )
          })
        )}
      </div>
      {frozenPrompt && planId && (
        <FrozenConfirmCard planId={planId} prompt={frozenPrompt} stages={stages} onDone={() => setFrozenPrompt(null)} />
      )}
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

/** C5：冻结区范围确认卡（未选定前不落任何变更） */
function FrozenConfirmCard({
  planId,
  prompt,
  stages,
  onDone
}: {
  planId: string
  prompt: { stageId: string; stageName: string; text: string }
  stages: StageRecord[]
  onDone: () => void
}): JSX.Element {
  const replanAfter = async (): Promise<void> => {
    const editable = stages.filter((s) => s.status !== 'done')
    const reqId = `fz-${Date.now()}`
    const res = (await window.api.planReplan({
      planId,
      requestId: reqId,
      preserveThroughStageId: prompt.stageId,
      ops: editable.length ? [{ kind: 'revise_stage', stage_id: editable[0].id, patch: { goal: prompt.text } }] : [],
      actor: 'chat',
      sourceMessageId: reqId
    })) as { ok?: boolean; error?: string }
    await appendMessage({
      planId,
      role: 'agent',
      content: res?.ok ? '已从冻结区之后重排（冻结阶段保持不变）。' : `重排失败：${res?.error ?? '未知原因'}`
    })
    onDone()
  }

  const newPlan = async (): Promise<void> => {
    const created = (await window.api.planCreate({ prompt: prompt.text, canvasContext: { videoReady: true } })) as { kind?: string }
    await appendMessage({
      planId,
      role: 'agent',
      content: created?.kind === 'plan' ? '已按新需求新建计划（原计划保持不动）。' : '这个需求不需要新建流程。'
    })
    onDone()
  }

  return (
    <div className="ivc-frozen-confirm" data-frozen-confirm="true">
      <div className="ivc-frozen-title">改动落在冻结区「{prompt.stageName}」</div>
      <div className="ivc-frozen-desc">选一个处理方式（未选定前不会改动计划）：</div>
      <div className="ivc-frozen-actions">
        <Button size="small" type="primary" onClick={() => void replanAfter()}>
          从其后重排
        </Button>
        <Button size="small" onClick={() => void newPlan()}>
          新建计划
        </Button>
        <Button size="small" type="text" onClick={onDone}>
          取消
        </Button>
      </div>
    </div>
  )
}