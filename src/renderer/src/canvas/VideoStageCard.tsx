/**
 * 视频阶段卡（V1 收尾）：把成片链路接进画布/计划卡闸门。
 *
 * 完整路径：预估（LLM 分镜 + 成本）→ 确认（一次性 confirmToken）→ 执行 → 进度 → 成片落卡，
 * 另给「续跑 / 取消」两个入口（续跑会先把 IndexedDB 里的作业回灌主进程，重启后也能接上）。
 *
 * 硬约束：付费前必须有凭证（主进程 fail-closed 校验）；预估只花一次 LLM，不发起付费出图/配音。
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Button, Progress, Tag, message } from 'antd'

import type { StageRecord } from './plan-types'

import { dropFilmToCanvas } from './videoGeneration'
import { loadVideoJobs } from './video-persistence'
import type { VideoJobRecord } from '../../../main/video/jobs'

interface Props {
  planId: string
  stage: StageRecord
  /** 用户需求原句（保真送进分镜） */
  brief: string
  defaultShotCount?: number
  defaultShotSeconds?: number
}

type Phase = 'idle' | 'planning' | 'estimate' | 'running' | 'done' | 'error'

interface EstimatePayload {
  narration: string
  shots: Array<{ workItemId: string; imagePrompt: string }>
  issues?: string[]
  blacklist?: string[]
  items: unknown[]
  estimatedCost: number
  shotCount: number
  unpriced: boolean
  budget?: { spent: number; remaining: number }
}

export default function VideoStageCard({ planId, stage, brief, defaultShotCount = 3, defaultShotSeconds = 3 }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [plan, setPlan] = useState<EstimatePayload | null>(null)
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null)
  const [finalRel, setFinalRel] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [jobs, setJobs] = useState<VideoJobRecord[]>([])

  const refreshJobs = useCallback(async (): Promise<void> => {
    try {
      const local = await loadVideoJobs(planId, stage.id)
      setJobs(local)
      // 重启续跑：有持久化作业才回灌主进程（幂等 put）；没有作业就不打扰主进程，避免抢主线程
      if (local.length) await window.api.videoResume({ planId, stageId: stage.id, jobs: local })
    } catch {
      // 首次没有作业，忽略
    }
  }, [planId, stage.id])

  useEffect(() => {
    // 延到空闲再拉作业：面板挂载不得影响画布拖拽手感（C1 硬约束：输入不阻塞画布）
    const t = setTimeout(() => void refreshJobs(), 400)
    return () => clearTimeout(t)
  }, [refreshJobs])

  // 阶段进度
  useEffect(() => {
    const off = window.api.onVideoStageProgress((raw) => {
      const p = raw as { planId?: string; stageId?: string; percent?: number; message?: string } | undefined
      if (!p || p.planId !== planId || p.stageId !== stage.id) return
      setProgress({ percent: Math.round((p.percent ?? 0) * 100), message: p.message ?? '' })
    })
    return off
  }, [planId, stage.id])

  const doPlan = useCallback(async (): Promise<void> => {
    setPhase('planning')
    setError('')
    try {
      const r = (await window.api.videoPlan({
        planId,
        stageId: stage.id,
        revision: stage.revision,
        brief,
        shotCount: defaultShotCount,
        shotSeconds: defaultShotSeconds,
        ratio: stage.execution_locks?.aspect_ratio ?? '9:16',
        resolution: stage.execution_locks?.resolution ?? '720P'
      })) as EstimatePayload
      setPlan(r)
      setPhase('estimate')
      if (r.blacklist?.length) message.warning(`文案命中低质黑名单：${r.blacklist.join('/')}（建议改写后再出片）`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [brief, defaultShotCount, defaultShotSeconds, planId, stage.execution_locks?.aspect_ratio, stage.execution_locks?.resolution, stage.id, stage.revision])

  const doConfirmRun = useCallback(async (): Promise<void> => {
    if (!plan) return
    setPhase('running')
    setProgress({ percent: 0, message: '提交' })
    try {
      // 用户确认 → 主进程签发一次性凭证（绑定 stage/revision/付费项哈希）
      const conf = (await window.api.videoConfirm({ planId, stageId: stage.id, revision: stage.revision, items: plan.items })) as { token?: unknown }
      const run = (await window.api.videoRun({
        planId,
        stageId: stage.id,
        revision: stage.revision,
        brief,
        shotCount: defaultShotCount,
        shotSeconds: defaultShotSeconds,
        ratio: stage.execution_locks?.aspect_ratio ?? '9:16',
        resolution: stage.execution_locks?.resolution ?? '720P',
        confirmToken: conf?.token,
        prepared: { narration: plan.narration, shots: plan.shots }
      })) as { ok?: boolean; code?: string; reason?: string; finalRelPath?: string; spentCny?: number; charges?: Array<{ cny: number }> }
      await refreshJobs()
      if (run?.ok && run.finalRelPath) {
        setFinalRel(run.finalRelPath)
        setPhase('done')
        const nodeId = await dropFilmToCanvas(run.finalRelPath, { plan_id: planId, stage_id: stage.id, spent_cny: run.spentCny ?? 0 })
        if (nodeId) message.success(`成片完成，已落画布（${run.finalRelPath}）`)
      } else {
        setError(`${run?.code ?? 'FAILED'}：${run?.reason ?? '执行失败'}`)
        setPhase('error')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [brief, defaultShotCount, defaultShotSeconds, plan, planId, refreshJobs, stage.execution_locks?.aspect_ratio, stage.execution_locks?.resolution, stage.id, stage.revision])

  const doCancel = useCallback(async (): Promise<void> => {
    await window.api.videoCancel({ planId, stageId: stage.id })
    setPhase('error')
    setError('已取消（后续付费步骤不再执行）')
  }, [planId, stage.id])

  const pending = jobs.filter((j) => j.status === 'failed' || j.status === 'running')
  const doneCount = jobs.filter((j) => j.status === 'done').length

  return (
    <div className="ivc-videostage" data-video-stage-panel="true" data-video-phase={phase} data-plan-id={planId} data-stage-id={stage.id}>
      <div className="ivc-videostage-head">
        <span>成片（V1：分镜图 + 配音 → ffmpeg）</span>
        <Tag color={phase === 'done' ? 'green' : phase === 'error' ? 'red' : 'blue'}>{phase}</Tag>
      </div>

      {phase === 'idle' && (
        <div className="ivc-videostage-actions">
          <Button size="small" type="primary" data-video-plan="true" onClick={() => void doPlan()}>
            预估成本
          </Button>
          {jobs.length > 0 && <span className="ivc-videostage-hint">已完成 {doneCount}/{jobs.length} 个作业</span>}
        </div>
      )}

      {phase === 'planning' && <div className="ivc-videostage-hint">正在生成分镜与预估…</div>}

      {phase === 'estimate' && plan && (
        <div data-video-estimate="true" data-video-cost={plan.estimatedCost.toFixed(2)}>
          <div className="ivc-videostage-hint">
            {plan.shotCount} 个镜头 · 预估 <b>¥{plan.estimatedCost.toFixed(2)}</b>
            {plan.unpriced ? '（含未收录价目，需显式接受按量计费）' : '（以百炼账单为准）'}
          </div>
          <div className="ivc-videostage-hint">口播：{(plan.narration || '（无）').slice(0, 40)}</div>
          {!!plan.issues?.length && <div className="ivc-videostage-warn">{plan.issues.join('；')}</div>}
          <div className="ivc-videostage-actions">
            <Button size="small" type="primary" data-video-confirm="true" onClick={() => void doConfirmRun()}>
              确认生成（¥{plan.estimatedCost.toFixed(2)}）
            </Button>
            <Button size="small" data-video-discard="true" onClick={() => setPhase('idle')}>
              取消
            </Button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div>
          <Progress size="small" percent={progress?.percent ?? 0} status="active" format={() => progress?.message ?? '执行中'} />
          <div className="ivc-videostage-actions">
            <Button size="small" danger data-video-cancel="true" onClick={() => void doCancel()}>
              取消执行
            </Button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div data-video-done="true" data-video-final={finalRel}>
          <div className="ivc-videostage-hint">成片：{finalRel}（已落画布）</div>
          <div className="ivc-videostage-actions">
            <Button size="small" data-video-replan="true" onClick={() => void doPlan()}>
              重新预估
            </Button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div data-video-error="true">
          <div className="ivc-videostage-warn">{error}</div>
          <div className="ivc-videostage-actions">
            <Button size="small" data-video-resume="true" disabled={!pending.length} onClick={() => void doPlan()}>
              续跑（{pending.length} 个未完成）
            </Button>
            <Button size="small" data-video-replan="true" onClick={() => void doPlan()}>
              重新预估
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
