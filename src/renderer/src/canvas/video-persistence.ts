/**
 * 视频作业持久化（V1）：主进程算，渲染层落 IndexedDB（沿用 M1/O1 的既有方式）。
 *
 * 幂等：`video:job` 推的是全量作业记录，按 job key `put` 覆盖 —— 重复事件不产生第二条。
 * 重启续跑：`restoreVideoJobs()` 读回后可按 failed/running 续跑（executor 接入后使用）。
 */
import { listResumableVideoJobs, listVideoJobs, putVideoJob } from './db'
import type { VideoJobRecord } from '../../../main/video/jobs'

let attached = false
let unsubscribe: (() => void) | null = null

/** 订阅 video:job 并落盘；重复调用安全 */
export function attachVideoJobPersistence(): () => void {
  if (attached && unsubscribe) return unsubscribe
  attached = true
  const off = window.api.onVideoJob((raw) => {
    const job = raw as VideoJobRecord | undefined
    if (!job?.id) return
    void putVideoJob(job).catch((e) => console.warn('[video] 作业落盘失败：', e instanceof Error ? e.message : e))
  })
  unsubscribe = () => {
    off()
    attached = false
    unsubscribe = null
  }
  return unsubscribe
}

export async function loadVideoJobs(planId: string, stageId?: string): Promise<VideoJobRecord[]> {
  return listVideoJobs(planId, stageId)
}

/** 重启续跑入口：只返回 failed/running（done/skipped 一律跳过，硬规则 4） */
export async function loadResumableVideoJobs(planId?: string): Promise<VideoJobRecord[]> {
  return listResumableVideoJobs(planId)
}
