/**
 * 阶段作业规划（V1）：把「这一阶段要干的活」翻译成 video_jobs + 成本项。
 * **只预估不执行**（对应 IPC `video:plan`），纯函数可单测。
 *
 * 铁律：
 * - 每个 work_item 一条 job（job key = planId|stageId|workItemId），先规划后执行，执行前还要再查既有 job
 * - 付费项与非付费项分开：D 本地步骤（离屏/合成）不花钱，但同样要有 job 记录以便续跑
 */
import { createJob, type VideoJobRecord } from './jobs.ts'
import { estimateCost, type CostEstimate, type CostItem } from './cost.ts'

export const DEFAULT_IMAGE_MODEL = 'z-image-turbo'

export interface PlanShotInput {
  workItemId: string
  imagePrompt: string
  /** 画面时长（秒），默认 3 */
  seconds?: number
}

export interface PlanStageInput {
  planId: string
  stageId: string
  /** 阶段 revision：confirmToken 的绑定项 */
  revision: number
  shots: PlanShotInput[]
  /** 口播全文（TTS 计费按字符） */
  narration: string
  imageModel?: string
  withTts?: boolean
  withCompose?: boolean
  /** V4：需要离屏渲染帧 */
  needsFrames?: boolean
}

export interface StagePlan {
  jobs: VideoJobRecord[]
  items: CostItem[]
  estimate: CostEstimate
  shotCount: number
  /** 给 UI 的模型组合摘要 */
  modelMix: string[]
}

/** 规划该阶段的作业与成本（幂等：同输入同 job key） */
export function planStageJobs(input: PlanStageInput, now = Date.now()): StagePlan {
  const imageModel = input.imageModel || DEFAULT_IMAGE_MODEL
  const shots = input.shots ?? []
  const jobs: VideoJobRecord[] = []
  const items: CostItem[] = []
  const modelMix = new Set<string>()

  shots.forEach((shot, i) => {
    jobs.push(
      createJob(
        {
          planId: input.planId,
          stageId: input.stageId,
          workItemId: shot.workItemId,
          shotIndex: i,
          kind: 'image',
          provider: 'bailian',
          model: imageModel,
          paid: true,
          promptHash: String(shot.imagePrompt ?? '').slice(0, 200)
        },
        now
      )
    )
    modelMix.add(imageModel)
  })
  if (shots.length) items.push({ kind: 'image', price_key: imageModel, qty: shots.length })

  if (input.needsFrames) {
    for (const shot of shots) {
      jobs.push(
        createJob({ planId: input.planId, stageId: input.stageId, workItemId: `${shot.workItemId}__frame`, shotIndex: 0, kind: 'frame', paid: false }, now)
      )
    }
    items.push({ kind: 'frame', price_key: 'local-frame', qty: shots.length })
  }

  if (input.withTts !== false) {
    jobs.push(createJob({ planId: input.planId, stageId: input.stageId, workItemId: 'tts', shotIndex: 0, kind: 'tts', provider: 'bailian', model: 'qwen3-tts-flash', paid: true, promptHash: String(input.narration ?? '').slice(0, 200) }, now))
    items.push({ kind: 'tts', price_key: 'qwen3-tts-flash', chars: String(input.narration ?? '').length })
    modelMix.add('qwen3-tts-flash')
  }

  if (input.withCompose !== false) {
    jobs.push(createJob({ planId: input.planId, stageId: input.stageId, workItemId: 'compose', shotIndex: 0, kind: 'compose', paid: false }, now))
    items.push({ kind: 'compose', price_key: 'local-compose', qty: 1 })
  }

  return { jobs, items, estimate: estimateCost(items), shotCount: shots.length, modelMix: [...modelMix] }
}
