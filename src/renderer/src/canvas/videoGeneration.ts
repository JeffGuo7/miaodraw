/**
 * 视频生产节点服务（M3）：文案卡/图片卡连线 → Pixelle FastAPI
 * POST /api/video/generate/async → 轮询 /api/tasks/{id} → 视频卡落画布
 * 产物入库 assets（path=pixelle/...，role=derived 血统边，source=pixelle）。
 */
import { message } from 'antd'

import { getAssetByPath, putAssetBatch, putDependencyBatch, type AssetDependencyRecord } from './db'
import { canvasStore } from './store'

export interface PixelleTaskResult {
  video_url?: string
  duration?: number
  file_size?: number
}

interface PixelleTask {
  task_id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress?: number
  detail?: string
  error?: string
  result?: PixelleTaskResult
}

const TEMPLATES = [
  { value: '1080x1920/image_default.html', label: '竖屏 1080×1920' },
  { value: '1920x1080/image_default.html', label: '横屏 1920×1080' }
]

export { TEMPLATES }

function newId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

async function proxy<T>(args: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
  const r = await window.api.pixelleProxy(args)
  if (r.status >= 400) {
    const detail = (r.json as { detail?: string })?.detail ?? `HTTP ${r.status}`
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return r.json as T
}

/** 产物入库 assets + 血统边（role=derived, source=pixelle） */
async function persistVideoAsset(args: {
  videoUrl: string
  durationSec: number
  text: string
  parents: Array<{ assetId?: string; relPath?: string }>
}): Promise<void> {
  try {
    // video_url 形如 {baseUrl}/api/files/<任务目录>/final.mp4 → 资产相对路径 pixelle/<...>
    const m = args.videoUrl.match(/\/api\/files\/(.+)$/)
    if (!m) return
    const relWithin = decodeURIComponent(m[1])
    const relPath = `pixelle/${relWithin}`
    const now = Date.now()
    const existed = await getAssetByPath(relPath)
    let childId = existed?.id
    if (!childId) {
      const info = await window.api.canvasAssetInfo(relPath)
      const record = {
        id: newId(),
        path: relPath,
        status: 'active' as const,
        size: info.size,
        mtime_ms: info.mtimeMs,
        quick_hash: info.quickHash,
        full_hash: info.fullHash,
        width: info.width,
        height: info.height,
        duration_ms: args.durationSec ? Math.round(args.durationSec * 1000) : null,
        mime_type: info.mime,
        name: relWithin.split('/').pop() ?? 'final.mp4',
        metadata: JSON.stringify({ source: 'pixelle', text: args.text.slice(0, 500) }),
        created_at: now,
        updated_at: now,
        migration_id: null,
        candidate_asset_id: null,
        candidate_path: null
      }
      await putAssetBatch([record])
      childId = record.id
    }
    if (!childId) return

    // 血统边：图片参考（source=pixelle 标注在 metadata）
    const deps: AssetDependencyRecord[] = []
    for (const p of args.parents) {
      let parentId = p.assetId ?? null
      if (!parentId && p.relPath) parentId = (await getAssetByPath(p.relPath))?.id ?? null
      if (!parentId) continue
      deps.push({
        child_id: childId,
        parent_id: parentId,
        role: 'derived',
        input_index: null,
        operation: 'pixelle-video',
        metadata: JSON.stringify({ source: 'pixelle' }),
        created_at: now
      })
    }
    if (deps.length) await putDependencyBatch(deps)
  } catch (e) {
    console.warn('[canvas] video asset persist failed', e)
  }
}

/**
 * 视频生产节点主流程（可重试：失败后再次调用即可）。
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

  const mode = node.metadata.mode === 'fixed' ? 'fixed' : 'generate'
  const template = String(node.metadata.template ?? TEMPLATES[0].value)
  const nScenes = Number(node.metadata.nScenes ?? 5) || 5

  const patch = (p: Record<string, unknown>): void => {
    const cur = canvasStore.getState().nodes.find((n) => n.id === nodeId)
    if (cur) canvasStore.updateNode(nodeId, { metadata: { ...cur.metadata, ...p } })
  }

  patch({ running: true, status: 'starting', progress: 0, error: null })
  const startedAt = Date.now()

  try {
    const { baseUrl } = await window.api.pixelleEnsure()
    patch({ status: 'submitting' })
    const submit = await proxy<{ task_id: string }>({
      method: 'POST',
      path: '/api/video/generate/async',
      body: {
        text,
        mode,
        n_scenes: mode === 'generate' ? nScenes : undefined,
        frame_template: template,
        // 参考图说明：Pixelle 媒体工作流侧自行生成画面；连线图片卡作为风格参照写入 prompt_prefix
        prompt_prefix: imageNodes.length ? String(imageNodes[0].metadata.prompt ?? '') || undefined : undefined
      }
    })
    const taskId = submit.task_id
    patch({ taskId })

    // 轮询任务（最长 30 分钟）
    const deadline = Date.now() + 30 * 60 * 1000
    for (;;) {
      if (Date.now() > deadline) throw new Error('生成超时（30 分钟）')
      await new Promise((r) => setTimeout(r, 3000))
      const task = await proxy<PixelleTask>({ method: 'GET', path: `/api/tasks/${taskId}` })
      patch({ status: task.status, progress: task.progress ?? undefined, detail: task.detail })
      if (task.status === 'completed' && task.result?.video_url) {
        const videoUrl = task.result.video_url.startsWith('http') ? task.result.video_url : `${baseUrl}${task.result.video_url}`
        const videoNodeId = canvasStore.addNode('video', { x: node.x + node.width + 60, y: node.y })
        canvasStore.updateNode(videoNodeId, {
          metadata: {
            content: videoUrl,
            taskId,
            duration: task.result.duration ?? null,
            text: text.slice(0, 200),
            source: 'pixelle'
          }
        })
        canvasStore.addConnection(nodeId, videoNodeId)

        void persistVideoAsset({
          videoUrl,
          durationSec: task.result.duration ?? 0,
          text,
          parents: imageNodes.map((n) => ({ assetId: n.metadata.assetId as string | undefined }))
        })

        message.success(`成片完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
        break
      }
      if (task.status === 'failed' || task.status === 'cancelled') {
        throw new Error(task.error || task.detail || `任务${task.status}`)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    patch({ error: msg })
    message.error(`视频生成失败：${msg}`)
  } finally {
    patch({ running: false })
  }
}
