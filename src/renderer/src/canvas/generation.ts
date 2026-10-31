/**
 * 出图节点生成服务（M2）：复用 miaodraw 现有百炼生成链路（window.api.generate IPC），
 * 产物落画布 + 自动入库 assets + 记录血统边（role=reference, operation=i2i|fusion）。
 */
import { message } from 'antd'

import type { RefImage, RefRole } from '../types'

import { getAssetByPath, putAssetBatch, putDependencyBatch, type AssetDependencyRecord } from './db'
import { canvasStore } from './store'
import { NODE_SPECS } from './types'

interface ActiveModel {
  provider: string
  model: string
}

/** 读取用户当前激活模型（设置里的 activeModel），退回百炼默认 */
async function resolveActiveModel(): Promise<ActiveModel> {
  try {
    const s = (await window.api.getSettings()) as { activeModel?: { provider?: string; model?: string }; model?: string }
    if (s.activeModel?.provider && s.activeModel?.model) return { provider: s.activeModel.provider, model: s.activeModel.model }
    if (s.model) return { provider: 'bailian', model: s.model }
  } catch {
    // 走默认
  }
  // 省钱档：兜底默认走最便宜的打样模型（用户设置里显式选了别的仍以设置为准）
  return { provider: 'bailian', model: 'z-image-turbo' }
}

/** 图片节点内容 → ArrayBuffer（media:// 走 imageRead IPC，dataURL 直接 fetch） */
async function loadBytes(content: string): Promise<ArrayBuffer> {
  if (content.startsWith('data:')) {
    const resp = await fetch(content)
    return resp.arrayBuffer()
  }
  const buf = await window.api.imageRead(content)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function guessExt(content: string): string {
  if (content.includes('image/webp') || /\.webp($|\?)/i.test(content)) return '.webp'
  if (/\.jpe?g($|\?)/i.test(content) || content.includes('image/jpeg')) return '.jpg'
  return '.png'
}

/** 生成完成后：产物 + 参考素材入库 assets，并写血统边 */
async function persistAssets(args: {
  resultFile: string
  seed: number
  model: string
  prompt: string
  refs: Array<{ hash?: string; name?: string; order?: number; role?: string }>
  childNodeId: string
}): Promise<void> {
  const now = Date.now()
  const childRel = `outputs/${args.resultFile}`
  try {
    const info = await window.api.canvasAssetInfo(childRel)
    await putAssetBatch([
      {
        id: newId(),
        path: childRel,
        status: 'active',
        size: info.size,
        mtime_ms: info.mtimeMs,
        quick_hash: info.quickHash,
        full_hash: info.fullHash,
        width: info.width,
        height: info.height,
        duration_ms: null,
        mime_type: info.mime,
        name: args.resultFile,
        metadata: JSON.stringify({ prompt: args.prompt, seed: args.seed, model: args.model }),
        created_at: now,
        updated_at: now,
        migration_id: null,
        superseded_by: null,
        candidate_asset_id: null,
        candidate_path: null
      }
    ])
    const child = await getAssetByPath(childRel)
    if (!child) return

    // 血统边：parent 素材资产按需入库（refs/ 留档由主进程 archiveRefs 生成）
    const deps: AssetDependencyRecord[] = []
    for (const r of args.refs) {
      if (!r.hash) continue
      const ext = r.name ? (r.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase() : '.png'
      const refRel = `refs/${r.hash}${ext}`
      let parent = await getAssetByPath(refRel)
      if (!parent) {
        try {
          const ri = await window.api.canvasAssetInfo(refRel)
          await putAssetBatch([
            {
              id: newId(),
              path: refRel,
              status: 'active',
              size: ri.size,
              mtime_ms: ri.mtimeMs,
              quick_hash: ri.quickHash,
              full_hash: ri.fullHash,
              width: ri.width,
              height: ri.height,
              duration_ms: null,
              mime_type: ri.mime,
              name: r.name || `${r.hash}${ext}`,
              metadata: JSON.stringify({ kind: 'ref-archive', hash: r.hash }),
              created_at: now,
              updated_at: now,
              migration_id: null,
              superseded_by: null,
              candidate_asset_id: null,
              candidate_path: null
            }
          ])
          parent = await getAssetByPath(refRel)
        } catch {
          continue // 留档缺失：跳过该边
        }
      }
      if (parent) {
        deps.push({ child_id: child.id, parent_id: parent.id, role: 'reference', input_index: (r.order ?? 1) - 1, operation: 'i2i', metadata: JSON.stringify({ role: r.role ?? null }), created_at: now })
      }
    }
    if (deps.length) await putDependencyBatch(deps)

    canvasStore.updateNode(args.childNodeId, { metadata: { ...canvasStore.getState().nodes.find((n) => n.id === args.childNodeId)?.metadata, assetId: child.id } })
  } catch (e) {
    // 资产入库失败不影响画布展示（对账机制后续会补录）
    console.warn('[canvas] asset persist failed', e)
  }
}

function newId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 出图节点主流程：收集连线参考图 → generate IPC → 产物图片卡落画布 → 资产入库 + 血统边。
 */
export async function runGenerateNode(genNodeId: string): Promise<void> {
  const state = canvasStore.getState()
  const node = state.nodes.find((n) => n.id === genNodeId)
  if (!node) return
  const prompt = String(node.metadata.prompt ?? '').trim()
  if (!prompt) {
    message.warning('先在出图节点里写提示词')
    return
  }

  const refNodes = canvasStore.upstreamOf(genNodeId).filter((n) => n.type === 'image' && n.metadata.content)
  // 记录 runId：生成要 30~60 秒，必须能取消（主进程按 runId 中断请求）
  const runId = newId()
  canvasStore.updateNode(genNodeId, { metadata: { ...node.metadata, running: true, error: null, runId } })

  try {
    const refs: RefImage[] = []
    const refRecords: Array<{ hash?: string; name?: string; order?: number; role?: string }> = []
    for (let i = 0; i < refNodes.length; i++) {
      const rn = refNodes[i]
      const content = String(rn.metadata.content)
      const data = await loadBytes(content)
      const name = `ref${i + 1}${guessExt(content)}`
      refs.push({ name, data, role: 'ref' as RefRole, source: 'upload' })
      refRecords.push({ name, order: i + 1 })
    }

    const active = await resolveActiveModel()
    const [w, h] = String(node.metadata.size ?? '1024x1024')
      .split('x')
      .map((v) => Number(v) || 1024)

    const result = await window.api.generate({
      prompt,
      w,
      h,
      model: active.model,
      provider: active.provider,
      refs: refs.length ? refs : undefined,
      parent: genNodeId,
      runId
    })

    // 产物图片卡：落在出图节点右侧
    const imgNodeId = canvasStore.addNode('image', { x: node.x + node.width + 60, y: node.y })
    canvasStore.updateNode(imgNodeId, {
      metadata: { content: result.url, prompt, seed: result.seed, model: result.model, sourceNode: genNodeId }
    })
    canvasStore.addConnection(genNodeId, imgNodeId)

    // refs 真实留档哈希：生成时主进程已把素材内容寻址写入 userData/refs，
    // sidecar 里带 hash；这里直接按顺序回填到 refRecords（hash 由 assetInfo/对账路径校验）。
    // 主进程 archiveRefs 的 hash 是 sha1(内容)，本地重新计算即可对上：
    const { refHashes } = await computeRefHashes(refs)
    refRecords.forEach((r, i) => {
      r.hash = refHashes[i]
    })

    void persistAssets({
      resultFile: result.file,
      seed: result.seed,
      model: result.model,
      prompt,
      refs: refRecords,
      childNodeId: imgNodeId
    })

    // elapsed 为毫秒（主进程 Date.now()-t0），此处换算成秒显示
    message.success(`生成完成，耗时 ${(result.elapsed / 1000).toFixed(1)} 秒`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    canvasStore.updateNode(genNodeId, { metadata: { ...canvasStore.getState().nodes.find((n) => n.id === genNodeId)?.metadata, error: msg } })
    message.error(`生成失败：${msg}`)
  } finally {
    const cur = canvasStore.getState().nodes.find((n) => n.id === genNodeId)
    if (cur) canvasStore.updateNode(genNodeId, { metadata: { ...cur.metadata, running: false, runId: '' } })
  }
}

async function computeRefHashes(refs: RefImage[]): Promise<{ refHashes: string[] }> {
  // 与主进程 archiveRefs 相同的内容寻址算法（sha1），保证血统边 parent 路径能对上 refs/ 留档
  const cryptoObj = globalThis.crypto
  const refHashes = await Promise.all(
    refs.map(async (r) => {
      // subtle.digest 在 Electron 渲染层可用；SHA-1 与主进程 createHash('sha1') 对齐
      const digest = await cryptoObj.subtle.digest('SHA-1', r.data)
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    })
  )
  return { refHashes }
}

export { NODE_SPECS }
