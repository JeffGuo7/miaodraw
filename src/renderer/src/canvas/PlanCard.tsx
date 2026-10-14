/**
 * 计划卡（C2）—— 渲染在 `plan` 画布节点内部，阶段纵向列表 + 闸门按钮。
 * 约束：不新增节点类型（plan 是唯一新增类型）；阶段详情在卡内渲染，不落子节点。
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Button, Space, Tag, Tooltip } from 'antd'
import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'

import type { PlanRecord, StageRecord } from './plan-types'

import { actViaCard } from './plan-actions'

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

export default function PlanCard({ planId }: Props): JSX.Element {
  const [snap, setSnap] = useState<Snapshot | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const s = (await window.api.planAuthored(planId)) as Snapshot | { error?: string }
    if (s && 'plan' in s) setSnap(s as Snapshot)
  }, [planId])

  useEffect(() => {
    void refresh()
    const off = window.api.onPlanChanged((raw) => {
      const s = raw as Snapshot | undefined
      if (s?.plan?.id === planId) setSnap(s)
    })
    return off
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
  return (
    <div className="ivc-plancard" data-plan-id={planId} data-plan-status={plan.status}>
      <div className="ivc-plancard-head">
        <span className="ivc-plancard-title">{plan.title}</span>
        <Tag color={plan.status === 'done' ? 'green' : plan.status === 'cancelled' ? 'default' : 'blue'}>{plan.status}</Tag>
        <span className="ivc-plancard-progress">
          {doneCount}/{plan.stage_outline.length}
        </span>
      </div>
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
                    <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => void actViaCard(planId, stage, 'confirm_plan')}>
                      确认计划
                    </Button>
                  </Tooltip>
                </Space>
              )}
              {stage.waiting_reason === 'result_review' && (
                <Space size={4} className="ivc-plancard-actions">
                  <Button size="small" type="primary" onClick={() => void actViaCard(planId, stage, 'confirm_result')}>
                    通过
                  </Button>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => void actViaCard(planId, stage, 'retry')}>
                    重跑
                  </Button>
                </Space>
              )}
            </div>
          )
        })}
      </div>
      {plan.stage_outline.length > stages.length && (
        <div className="ivc-plancard-pending">
          未展开：{plan.stage_outline.slice(stages.length).map((o) => o.name).join(' / ')}
        </div>
      )}
    </div>
  )
}
