/**
 * 视频生产节点服务（V1）：**直连百炼**（提交 → 轮询 → 下载 → 落盘），零 Pixelle 依赖。
 *
 * 成本护栏（fail-closed）：
 * 1) 提交前弹确认卡：模型 / 档位 / 时长 / 预估价（默认最短 2 秒 + 720P + 关 prompt_extend）
 * 2) 预估价超过硬上限 → 直接拒绝（主进程也会再拦一次）
 * 3) 同一节点连续失败 2 次后停止自动重试，必须人工确认后再跑
 * 4) 记账：产物 assets 与 sidecar 都记 model/duration/预估价，便于事后对账
 *
 * 产物入库 assets（path=videos/<file>，role=derived 血统边，source=bailian-video）。
 */
import { createElement } from 'react'
import { Modal, message } from 'antd'

import { getAssetByPath, putAssetBatch, putDependencyBatch, type AssetDependencyRecord } from './db'
import { canvasStore } from './store'
import { checkVoBlacklist, checkVoDensity } from '../../../main/prompt-guards'
import {
  DEFAULT_VIDEO_SPEC,
  afterFailure,
  canAutoRetry,
  estimateVideoCost,
  normalizeVideoSpec,
  ratioLabel,
  type TaskState,
  type VideoSpecInput
} from '../../../main/video-protocol'

export {
  DEFAULT_VIDEO_SPEC,
  VIDEO_DURATIONS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  ratioLabel,
  estimateVideoCost,
  normalizeVideoSpec,
  canAutoRetry
} from '../../../main/video-protocol'

/** 状态 → 中文（进度条文案） */
const STATE_TEXT: Record<TaskState, string> = {
  pending: '排队中',
  running: '生成中',
  succeeded: '下载中',
  failed: '失败'
}

function newId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 节点元数据 → 规格（档位来自节点上的选择，非法值由 normalize 兜底到红线默认） */
function specOf(node: { metadata: Record<string, unknown> }, text: string): VideoSpecInput {
  return {
    prompt: text,
    model: DEFAULT_VIDEO_SPEC.model,
    resolution: node.metadata.resolution,
    ratio: node.metadata.ratio,
    duration: node.metadata.duration,
    promptExtend: false
  }
}

/** 成本确认卡：不确认不发请求（返回 false 表示用户取消） */
async function confirmCost(spec: ReturnType<typeof normalizeVideoSpec>, blocked: boolean): Promise<boolean> {
  const cost = estimateVideoCost(spec)
  const rows = [
    `模型：${spec.model}｜${ratioLabel(spec.ratio)}｜${spec.resolution}｜${spec.duration} 秒`,
    `预估费用：¥${cost.cny.toFixed(2)}${cost.verified ? '' : '（预估）'}`,
    `prompt 扩写：${spec.promptExtend ? '已开（可能额外计费）' : '关闭'}`
  ]
  if (blocked) rows.push('⚠️ 该节点已连续失败 2 次，成本护栏已阻止自动重试；确认要继续再试一次。')
  return new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: blocked ? '成本护栏：继续重试？' : '确认生成视频？',
      // 本文件是 .ts（无 JSX）：用 createElement 组装确认卡内容
      content: createElement(
        'div',
        { style: { fontSize: 12 } },
        rows.map((r) => createElement('div', { key: r }, r)),
        createElement('div', { style: { color: '#8c8c8c', marginTop: 6 } }, cost.note)
      ),
      okText: `确认生成（¥${cost.cny.toFixed(2)}）`,
      cancelText: '取消',
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  })
}

/** 产物入库 assets + 血统边（role=derived, operation=bailian-video, source=bailian-video） */
async function persistVideoAsset(args: {
  relPath: string
  prompt: string
  spec: { model: string; resolution: string; ratio: string; duration: number }
  taskId: string
  estimatedCny: number
  parents: Array<{ assetId?: string }>
}): Promise<string | undefined> {
  try {
    const now = Date.now()
    const existed = await getAssetByPath(args.relPath)
    let childId = existed?.id
    if (!childId) {
      const info = await window.api.canvasAssetInfo(args.relPath)
      const record = {
        id: newId(),
        path: args.relPath,
        status: 'active' as const,
        size: info.size,
        mtime_ms: info.mtimeMs,
        quick_hash: info.quickHash,
        full_hash: info.fullHash,
        width: info.width,
        height: info.height,
        duration_ms: args.spec.duration ? Math.round(args.spec.duration * 1000) : null,
        mime_type: info.mime,
        name: args.relPath.split('/').pop() ?? 'video.mp4',
        metadata: JSON.stringify({
          source: 'bailian-video',
          task_id: args.taskId,
          model: args.spec.model,
          resolution: args.spec.resolution,
          ratio: args.spec.ratio,
          duration_sec: args.spec.duration,
          estimated_cny: args.estimatedCny,
          prompt: args.prompt.slice(0, 500)
        }),
        created_at: now,
        updated_at: now,
        migration_id: null,
        superseded_by: null,
        candidate_asset_id: null,
        candidate_path: null
      }
      await putAssetBatch([record])
      childId = record.id
    }
    if (!childId) return undefined

    const deps: AssetDependencyRecord[] = []
    for (const p of args.parents) {
      if (!p.assetId) continue
      deps.push({
        child_id: childId,
        parent_id: p.assetId,
        role: 'derived',
        input_index: null,
        operation: 'bailian-video',
        metadata: JSON.stringify({ source: 'bailian-video', model: args.spec.model, duration_sec: args.spec.duration }),
        created_at: now
      })
    }
    if (deps.length) await putDependencyBatch(deps)
    return childId
  } catch (e) {
    // 入库失败不影响画布展示（对账机制后续补录）
    console.warn('[canvas] video asset persist failed', e)
    return undefined
  }
}

/**
 * 视频生产节点主流程：收集文案 → 成本确认 → 直连百炼出片 → 视频卡落画布 + 入库 + 血统边。
 * 失败计数落在节点上：连续 2 次失败后必须人工确认（成本护栏）。
 */
export async function runVideoNode(nodeId: string): Promise<void> {
  const state = canvasStore.getState()
  const node = state.nodes.find((n) => n.id === nodeId)
  if (!node) return

  const upstream = canvasStore.upstreamOf(nodeId)
  const textNodes = upstream.filter((n) => n.type === 'text' && String(n.metadata.content ?? '').trim())
  const imageNodes = upstream.filter((n) => n.type === 'image' && n.metadata.content)
  const ownText = String(node.metadata.prompt ?? '').trim()
  const text = (textNodes.map((n) => String(n.metadata.content)).join('\n\n') || ownText).trim()
  if (!text) {
    message.warning('先连线一张文案卡（或在节点里写文案）')
    return
  }

  // 文案检查卡（P0）：黑名单硬拦 + 台词密度提示（中文 3-4 字/秒；超了拆段或删词）
  const blHits = checkVoBlacklist(text)
  const estSeconds = Math.max(2, Math.round(text.replace(/\s/g, '').length / 3.5))
  const density = checkVoDensity(text, estSeconds)
  if (blHits.length) {
    message.warning(`文案命中低质黑名单：${blHits.map((h) => h.kind).join('/')}（平台限流信号，建议改写后再出片）`)
  }
  if (density.over) {
    message.info(`台词密度偏高（约 ${estSeconds} 秒塞 ${density.chars} 字）：${density.advice}`)
  }

  const failCount = Number(node.metadata.failCount ?? 0) || 0
  const spec = normalizeVideoSpec(specOf(node, text))
  const cost = estimateVideoCost(spec)

  // 硬上限：预估价超限直接拒绝（主进程还会再拦一次）
  if (cost.overCap) {
    message.error(`预估 ¥${cost.cny.toFixed(2)} 超过单次上限，请把时长/分辨率调低后再试`)
    return
  }
  // 显式确认（连续失败 2 次后，确认文案升级为「成本护栏」）
  if (!(await confirmCost(spec, !canAutoRetry(failCount)))) return

  const patch = (p: Record<string, unknown>): void => {
    const cur = canvasStore.getState().nodes.find((n) => n.id === nodeId)
    if (cur) canvasStore.updateNode(nodeId, { metadata: { ...cur.metadata, ...p } })
  }

  const runId = `v${Date.now().toString(36)}`
  const offProgress = window.api.onVideoProgress((raw) => {
    const p = raw as { runId?: string; state?: TaskState; progress?: number; detail?: string } | undefined
    if (!p || p.runId !== runId) return
    patch({
      status: (p.state && STATE_TEXT[p.state]) || '生成中',
      progress: typeof p.progress === 'number' ? p.progress : 0,
      detail: p.detail ?? null
    })
  })

  patch({ running: true, status: '提交中', progress: 0, error: null, runId })
  const startedAt = Date.now()

  try {
    const res = await window.api.videoGenerate({ spec, runId })

    // 产物视频卡：落在视频节点右侧
    const videoNodeId = canvasStore.addNode('video', { x: node.x + node.width + 60, y: node.y })
    canvasStore.updateNode(videoNodeId, {
      metadata: {
        content: res.url,
        taskId: res.taskId,
        duration: res.durationSec,
        model: res.model,
        ratio: res.ratio,
        resolution: res.resolution,
        estimatedCny: res.estimatedCny,
        sizeBytes: res.sizeBytes,
        text: text.slice(0, 200),
        source: 'bailian-video'
      }
    })
    canvasStore.addConnection(nodeId, videoNodeId)

    const assetId = await persistVideoAsset({
      relPath: res.relPath,
      prompt: text,
      spec: { model: res.model, resolution: res.resolution, ratio: res.ratio, duration: res.durationSec },
      taskId: res.taskId,
      estimatedCny: res.estimatedCny,
      parents: imageNodes.map((n) => ({ assetId: n.metadata.assetId as string | undefined }))
    })
    if (assetId) canvasStore.updateNode(videoNodeId, { metadata: { ...videoNodeIdMetadata(videoNodeId), assetId } })

    // 成功 → 失败计数归零，并记下本次预估花费
    patch({ failCount: 0, estimatedCny: res.estimatedCny, taskId: res.taskId, status: 'done', progress: 1 })
    message.success(`成片完成（${res.durationSec} 秒，预估 ¥${res.estimatedCny.toFixed(2)}），耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const next = afterFailure(failCount)
    const blocked = !canAutoRetry(next)
    patch({ error: msg, failCount: next, blockedByCostGuard: blocked })
    message.error(blocked ? `视频生成失败：${msg}（已连续失败 ${next} 次，成本护栏已停止自动重试）` : `视频生成失败：${msg}`)
  } finally {
    offProgress()
    patch({ running: false })
  }
}

function videoNodeIdMetadata(nodeId: string): Record<string, unknown> {
  return canvasStore.getState().nodes.find((n) => n.id === nodeId)?.metadata ?? {}
}
