/**
 * 计划卡（C2）—— 渲染在 `plan` 画布节点内部，阶段纵向列表 + 闸门按钮。
 * 约束：不新增节点类型（plan 是唯一新增类型）；阶段详情在卡内渲染，不落子节点。
 *
 * C6：空态（drafting 骨架）／异常态（>60s 无进展 → 重试）／事件缺口全量重拉。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { App as AntdApp, Button, Space, Tag, Tooltip } from 'antd'
import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'

import type { PlanRecord, StageRecord } from '../../../shared/plan-types'

import { actViaCard } from './plan-actions'
import { appendMessage } from './chat-store'
import { isPlanStale, needsFullRefresh } from './plan-recover'
import VideoStageCard from './VideoStageCard'

interface Props {
  planId: string
}

interface Snapshot {
  plan: PlanRecord
  stages: StageRecord[]
}

const STATUS_TEXT: Record<string, { text: string; color: string }> = {
  pending: { text: '未展开', color: 'default' },
  waiting_user: { text: '待确认', color: 'gold' },
  doing: { text: '执行中', color: 'blue' },
  done: { text: '已完成', color: 'green' },
  blocked: { text: '受阻', color: 'red' }
}

// ── 探针钩子（沿用 __canvasChat 的做法）：只用于端到端断言「丢一次事件 → 全量重拉」 ──
interface RecoverHook {
  dropNext: (planId: string) => void
  shouldDrop: (planId: string) => boolean
  noteDrop: (planId: string) => void
  noteRefresh: (planId: string, detail: string) => void
  stats: (planId: string) => { dropped: number; refreshes: number; reasons: string[] }
}

function recoverHook(): RecoverHook | undefined {
  return (window as unknown as { __planRecover?: RecoverHook }).__planRecover
}

if (typeof window !== 'undefined') {
  const dropped = new Map<string, number>()
  const refreshes = new Map<string, number>()
  const reasons = new Map<string, string[]>()
  const pending = new Set<string>()
  const hook: RecoverHook = {
    dropNext: (planId) => pending.add(planId),
    shouldDrop: (planId) => pending.has(planId),
    noteDrop: (planId) => {
      pending.delete(planId)
      dropped.set(planId, (dropped.get(planId) ?? 0) + 1)
    },
    noteRefresh: (planId, detail) => {
      refreshes.set(planId, (refreshes.get(planId) ?? 0) + 1)
      reasons.set(planId, [...(reasons.get(planId) ?? []), detail].slice(-10))
    },
    stats: (planId) => ({ dropped: dropped.get(planId) ?? 0, refreshes: refreshes.get(planId) ?? 0, reasons: reasons.get(planId) ?? [] })
  }
  ;(window as unknown as { __planRecover?: RecoverHook }).__planRecover = hook
}

export default function PlanCard({ planId }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [nowTick, setNowTick] = useState(0)
  const lastRevisionRef = useRef<number | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const s = (await window.api.planAuthored(planId)) as Snapshot | { error?: string }
    if (s && 'plan' in s) {
      lastRevisionRef.current = s.plan.revision
      setSnap(s)
    }
  }, [planId])

  /** 事件缺口 → 全量重拉（200ms 防抖 + 同时只允许一次，避免重拉风暴） */
  const scheduleFullRefresh = useCallback((): void => {
    if (refreshTimerRef.current) return
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void refresh()
    }, 200)
  }, [refresh])

  useEffect(() => {
    void refresh()
    const off = window.api.onPlanChanged((raw) => {
      const s = raw as Snapshot | undefined
      if (!s?.plan?.id || s.plan.id !== planId) return
      // 探针：模拟「这一次推送丢了」（只影响本卡片，不动主进程真相源）
      const hook = recoverHook()
      if (hook?.shouldDrop?.(planId)) {
        hook.noteDrop(planId)
        return
      }
      // revision 跳变 / 缺 stages → 本地会长期落后于真相源，必须重拉
      if (needsFullRefresh(lastRevisionRef.current, s)) {
        hook?.noteRefresh(planId, `${lastRevisionRef.current}->${s.plan.revision}${Array.isArray(s.stages) ? '' : '/no-stages'}`)
        scheduleFullRefresh()
        return
      }
      lastRevisionRef.current = s.plan.revision
      setSnap(s)
    })
    return () => {
      off()
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [planId, refresh, scheduleFullRefresh])

  /** 统一动作入口：把失败/冲突/重复显式告诉用户（此前返回值被丢弃，表现为「点了没反应」） */
  const runAction = useCallback(
    async (stage: StageRecord, action: 'confirm_plan' | 'confirm_result' | 'retry'): Promise<void> => {
      const out = await actViaCard(planId, stage, action)
      if (out.status === 'error') message.error(out.detail ?? '操作失败')
      else if (out.status === 'conflict') message.warning('计划已更新，请按最新版本重新确认')
      else if (out.status === 'skipped') message.info(out.detail ?? '该动作已处理')
    },
    [planId, message]
  )

  const draftEmpty = snap?.plan.status === 'drafting' && (snap?.stages.length ?? 0) === 0
  // 只有停在 drafting 且零物化时才需要按秒重算 stale，其他状态不用每 5 秒重渲染
  useEffect(() => {
    if (!draftEmpty) return
    const t = setInterval(() => setNowTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [draftEmpty])

  const retryPlanning = useCallback(async (): Promise<void> => {
    setRetrying(true)
    try {
      const res = (await window.api.planAuthorStage({ planId })) as { ok?: boolean; error?: string }
      if (res?.ok) {
        await refresh()
        await appendMessage({ planId, role: 'system', content: '已重新开始规划，首个阶段就绪后会在这里提示你确认。' })
      } else {
        await appendMessage({ planId, role: 'system', content: `重新规划失败：${res?.error ?? '未知原因'}` })
      }
    } finally {
      setRetrying(false)
    }
  }, [planId, refresh])

  if (!snap) {
    return (
      <div className="ivc-plancard" data-plan-id={planId} data-empty="true">
        载入计划…
      </div>
    )
  }

  const { plan, stages } = snap
  const doneCount = stages.filter((s) => s.status === 'done').length
  void nowTick
  const stale = isPlanStale(plan, stages)
  return (
    <div className="ivc-plancard" data-plan-id={planId} data-plan-status={plan.status} data-stale={stale ? 'true' : 'false'}>
      <div className="ivc-plancard-head">
        <span className="ivc-plancard-title">{plan.title}</span>
        <Tag color={plan.status === 'done' ? 'green' : plan.status === 'cancelled' ? 'default' : 'blue'}>{plan.status}</Tag>
        <Tooltip title="自动推进：无需人工确认即可过闸门；遇到 blocked 会自动转回手动">
          <Button
            size="small"
            type={plan.auto_advance ? 'primary' : 'default'}
            className="ivc-plancard-auto"
            data-auto={plan.auto_advance ? 'on' : 'off'}
            onClick={async () => {
              const next = !plan.auto_advance
              const res = (await window.api.planSetAutoAdvance({ planId, enabled: next, expectedRevision: plan.revision })) as { ok?: boolean }
              await appendMessage({
                planId,
                role: 'system',
                content: next ? '已开启自动推进：闸门将自动通过，遇到阻塞会立即转回手动。' : '已关闭自动推进。'
              })
              if (!res?.ok) await appendMessage({ planId, role: 'system', content: '自动推进开关切换失败（计划可能已更新），已刷新。' })
              void refresh()
            }}
          >
            ⚡ {plan.auto_advance ? '自动推进中' : '自动'}
          </Button>
        </Tooltip>
        <span className="ivc-plancard-progress">
          {doneCount}/{plan.stage_outline.length}
        </span>
      </div>
      {stale && (
        <div className="ivc-plancard-stale" data-stale-block="true">
          <span>规划中断：超过 60 秒没有进展。</span>
          <Button size="small" type="primary" loading={retrying} data-stale-retry="true" onClick={() => void retryPlanning()}>
            重试
          </Button>
        </div>
      )}
      {draftEmpty && !stale && (
        <div className="ivc-plancard-skeleton" data-skeleton="true">
          规划中… 正在拆解需求
        </div>
      )}
      <div className="ivc-plancard-stages">
        {stages.map((stage) => {
          const st = STATUS_TEXT[stage.status] ?? STATUS_TEXT.pending
          const frozen = stage.status === 'done'
          return (
            <div key={stage.id} className="ivc-plancard-stage" data-stage-id={stage.id} data-frozen={frozen ? 'true' : 'false'} data-status={stage.status}>
              <div className="ivc-plancard-stage-head">
                <span className="ivc-plancard-order">{stage.order}</span>
                <span className="ivc-plancard-name">{stage.name}</span>
                <Tag color={st.color}>{st.text}</Tag>
              </div>
              {stage.waiting_reason === 'plan_review' && (
                <Space size={4} className="ivc-plancard-actions">
                  <Tooltip title="生成一条等价消息并推进（与聊天确认同路）">
                    <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => void runAction(stage, 'confirm_plan')}>
                      确认计划
                    </Button>
                  </Tooltip>
                </Space>
              )}
              {stage.waiting_reason === 'result_review' && (
                <Space size={4} className="ivc-plancard-actions">
                  <Button size="small" type="primary" onClick={() => void runAction(stage, 'confirm_result')}>
                    通过
                  </Button>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => void runAction(stage, 'retry')}>
                    重跑
                  </Button>
                </Space>
              )}
              {/* V1：成片阶段（work_items 含 video）挂「预估 → 确认 → 执行 → 进度 → 落卡」面板 */}
              {stage.work_items.some((w) => w.modality === 'video') && !frozen && (
                <VideoStageCard planId={planId} stage={stage} brief={plan.prompt} />
              )}
            </div>
          )
        })}
      </div>
      {plan.stage_outline.length > stages.length && !stale && (
        <div className="ivc-plancard-pending">
          未展开：{plan.stage_outline.slice(stages.length).map((o) => o.name).join(' / ')}
        </div>
      )}
    </div>
  )
}