/**
 * 闸门审阅卡（C3）—— 渲染在**聊天消息流内**，锚定到 plan_id + stage_id 对应的消息之后。
 *
 * 能力：
 * - 默认折叠（阶段名 + 检查项摘要 + 产物数），展开后逐条显示 work_item 的 prompt / 有序 refs / execution_locks
 * - plan_review：行内编辑 prompt → `plan:patchStage({expectedRevision})`
 *   冲突时卡片置 `data-conflict="true"` 且**保留草稿**（不静默丢弃）
 * - result_review：展示产物节点/资产 + 通过 / 打回
 */
import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { App as AntdApp, Button, Input, Space, Tag, Typography } from 'antd'
import { DownOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'

import type { StageRecord } from '../../../shared/plan-types'

import { actViaCard } from './plan-actions'

interface Props {
  planId: string
  stage: StageRecord
  onStageChanged?: (stage: StageRecord) => void
}

export default function StageReviewCard({ planId, stage, onStageChanged }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [expanded, setExpanded] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)

  // 阶段对象更新（revision 变化）时清冲突标记；草稿保留给用户继续提交
  useEffect(() => {
    setConflict(false)
  }, [stage.revision])

  const initialDrafts = useMemo(() => {
    const out: Record<string, string> = {}
    for (const item of stage.work_items) out[item.id] = item.prompt ?? ''
    return out
  }, [stage.work_items])

  const isPlanGate = stage.waiting_reason === 'plan_review'
  const isResultGate = stage.waiting_reason === 'result_review'
  const dirty = Object.entries(initialDrafts).some(([id, v]) => (drafts[id] ?? v) !== v)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const items = stage.work_items.map((w) => ({ ...w, prompt: drafts[w.id] ?? w.prompt }))
      const res = (await window.api.planPatchStage({
        planId,
        stageId: stage.id,
        patch: { work_items: items },
        expectedRevision: stage.revision
      })) as { ok?: boolean; conflict?: boolean; revision?: number; stage?: StageRecord; error?: string }
      if (res?.ok) {
        setConflict(false)
        if (res.stage) onStageChanged?.(res.stage)
      } else if (res?.conflict) {
        setConflict(true) // 保留草稿，提示用户刷新
      }
    } finally {
      setSaving(false)
    }
  }

  /** 统一动作入口：失败/冲突/重复都要有可见反馈 */
  const runAction = async (action: 'confirm_plan' | 'confirm_result' | 'retry'): Promise<void> => {
    const out = await actViaCard(planId, stage, action)
    if (out.status === 'error') message.error(out.detail ?? '操作失败')
    else if (out.status === 'conflict') message.warning('计划已更新，请按最新版本重新确认')
    else if (out.status === 'skipped') message.info(out.detail ?? '该动作已处理')
  }

  const products = stage.work_items.filter((w) => w.output_node_id || w.output_asset_id)

  return (
    <div
      className="ivc-reviewcard"
      data-review-stage={stage.id}
      data-conflict={conflict ? 'true' : 'false'}
      data-review-kind={stage.waiting_reason ?? 'none'}
    >
      <div className="ivc-reviewcard-head" onClick={() => setExpanded((v) => !v)}>
        {expanded ? <DownOutlined /> : <RightOutlined />}
        <span className="ivc-reviewcard-title">
          阶段 {stage.order}「{stage.name}」
        </span>
        <Tag color={isPlanGate ? 'gold' : 'blue'}>{isPlanGate ? '待确认计划' : isResultGate ? '待验收结果' : '待处理'}</Tag>
        <span className="ivc-reviewcard-meta">
          {stage.work_items.length} 项 · 产物 {products.length}
        </span>
      </div>

      {(stage.review.after_execution.length > 0 || stage.review.before_execution.length > 0) && (
        <div className="ivc-reviewcard-checks">
          {[...stage.review.before_execution, ...stage.review.after_execution].map((c) => (
            <div key={c} className="ivc-reviewcard-check">
              · {c}
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="ivc-reviewcard-body">
          {Object.keys(stage.execution_locks ?? {}).length > 0 && (
            <div className="ivc-reviewcard-locks" data-locks={JSON.stringify(stage.execution_locks)}>
              锁项：
              {Object.entries(stage.execution_locks).map(([k, v]) => `${k}=${String(v)}`).join(' / ')}
            </div>
          )}
          {stage.work_items.map((w) => (
            <div key={w.id} className="ivc-reviewcard-item" data-item-id={w.id}>
              <div className="ivc-reviewcard-item-head">
                <Typography.Text strong>{w.name}</Typography.Text>
                <Tag>{w.modality}</Tag>
                {w.refs.length > 0 && <span className="ivc-reviewcard-refs">refs: {w.refs.join(', ')}</span>}
              </div>
              {isPlanGate ? (
                <Input.TextArea
                  className="ivc-reviewcard-prompt"
                  value={drafts[w.id] ?? w.prompt}
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  onChange={(e) => setDrafts((d) => ({ ...d, [w.id]: e.target.value }))}
                />
              ) : (
                <div className="ivc-reviewcard-prompt-readonly">{w.prompt || '（无提示词）'}</div>
              )}
              {(w.output_node_id || w.output_asset_id) && (
                <div className="ivc-reviewcard-product">
                  产物：{w.output_node_id ?? ''} {w.output_asset_id ? `· 资产 ${w.output_asset_id.slice(0, 10)}` : ''}
                </div>
              )}
            </div>
          ))}

          {conflict && (
            <div className="ivc-reviewcard-conflict" data-conflict-notice="true">
              计划已更新（revision 变化），你的草稿仍保留 —— 请重新载入最新版本后再提交。
            </div>
          )}

          <Space size={6} className="ivc-reviewcard-actions">
            {isPlanGate && (
              <>
                <Button size="small" type="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
                  保存提示词
                </Button>
                <Button size="small" onClick={() => void runAction('confirm_plan')}>
                  确认计划并执行
                </Button>
              </>
            )}
            {isResultGate && (
              <>
                <Button size="small" type="primary" onClick={() => void runAction('confirm_result')}>
                  通过
                </Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void runAction('retry')}>
                  打回重跑
                </Button>
              </>
            )}
          </Space>
        </div>
      )}
    </div>
  )
}