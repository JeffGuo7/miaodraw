/**
 * M1 历史数据迁移（docs/m1-migration-plan.md 的实现）：
 * 只建索引不搬文件；三道防重（meta 状态 / path 查重 / 常态对账）；
 * 失败按 migrationId 清半成品重跑；50 条一批事务提交，可中断。
 */
import type { HistoryItem, SidecarRefInfo } from '../types'

import {
  deleteAssetsByMigration,
  getAssetByPath,
  getMeta,
  putAssetBatch,
  setMeta,
  type AssetDependencyRecord,
  type AssetRecord,
  type MigrationState
} from './db'

const META_KEY = 'outputs-migration'
const BATCH_SIZE = 50
const MIGRATION_ID = 'm_outputs_v1'

export interface MigrationProgress {
  phase: 'scanning' | 'indexing' | 'linking' | 'done' | 'aborted' | 'failed'
  done: number
  total: number
  error?: string
}

export type AbortFn = () => boolean

function newId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 建一条资产记录（调用方保证 info 已取回） */
function buildAsset(args: {
  relPath: string
  name: string
  info: { size: number; mtimeMs: number; quickHash: string; fullHash: string; width: number | null; height: number | null; mime: string }
  metadata: unknown
  now: number
}): AssetRecord {
  return {
    id: newId(),
    path: args.relPath,
    status: 'active',
    size: args.info.size,
    mtime_ms: args.info.mtimeMs,
    quick_hash: args.info.quickHash,
    full_hash: args.info.fullHash,
    width: args.info.width,
    height: args.info.height,
    duration_ms: null,
    mime_type: args.info.mime,
    name: args.name,
    metadata: args.metadata == null ? null : JSON.stringify(args.metadata),
    created_at: args.now,
    updated_at: args.now,
    migration_id: MIGRATION_ID,
    candidate_asset_id: null,
    candidate_path: null
  }
}

function refExt(ref: SidecarRefInfo): string {
  const m = ref.name?.match(/\.[a-z0-9]+$/i)
  return m ? m[0].toLowerCase() : '.png'
}

/**
 * 迁移 + 对账一体入口：
 * - meta 未 done → 完整迁移（清上批半成品 → 扫描 → 建索引 → 建血统边 → 标 done）
 * - meta 已 done → 仅对账（补录 outputs 新增文件）
 * 每个文件入索引前 path 查重，所以两种路径都幂等。
 */
export async function runMigration(onProgress: (p: MigrationProgress) => void, isAborted: AbortFn): Promise<void> {
  const prior = await getMeta<MigrationState>(META_KEY)
  const isFullMigration = prior?.state !== 'done'

  if (isFullMigration) {
    // 清上一批半成品（正常不存在，防御性执行）
    await deleteAssetsByMigration(MIGRATION_ID)
    await setMeta(META_KEY, { migrationId: MIGRATION_ID, state: 'running' } satisfies MigrationState)
  }

  try {
    onProgress({ phase: 'scanning', done: 0, total: 0 })
    const items: HistoryItem[] = await window.api.history()
    const total = items.length
    let done = 0
    let batch: AssetRecord[] = []

    // ---------- 素材留档（refs/）资产：按 hash 索引，供血统边反查 ----------
    const refAssetIds = new Map<string, string>() // refPath -> assetId

    const flush = async (): Promise<void> => {
      if (batch.length) {
        await putAssetBatch(batch)
        batch = []
      }
    }

    // 先把有 refs 的父素材入库（去重：同一 hash 只处理一次）
    const refSet = new Map<string, SidecarRefInfo>()
    for (const it of items) {
      for (const r of it.params?.refs ?? []) {
        if (r.hash && !refSet.has(r.hash)) refSet.set(r.hash, r)
      }
    }
    const refTotal = refSet.size
    let refDone = 0
    for (const [hash, ref] of refSet) {
      if (isAborted()) {
        onProgress({ phase: 'aborted', done, total: total + refTotal })
        return
      }
      const relPath = `refs/${hash}${refExt(ref)}`
      const existed = await getAssetByPath(relPath)
      if (!existed) {
        try {
          const info = await window.api.canvasAssetInfo(relPath)
          batch.push(
            buildAsset({
              relPath,
              name: ref.name || `${hash}${refExt(ref)}`,
              info,
              metadata: { kind: 'ref-archive', hash, role: ref.role ?? null },
              now: Date.now()
            })
          )
        } catch {
          // 留档文件已被清理：跳过，血统边 parent 置空
        }
      }
      refDone++
      if (batch.length >= BATCH_SIZE) await flush()
      onProgress({ phase: 'indexing', done: done + refDone, total: total + refTotal })
    }
    await flush()

    // ---------- 产物图（outputs/）资产 ----------
    for (const it of items) {
      if (isAborted()) {
        onProgress({ phase: 'aborted', done, total })
        return
      }
      const relPath = `outputs/${it.name}`
      done++
      const existed = await getAssetByPath(relPath)
      if (existed) continue
      try {
        const info = await window.api.canvasAssetInfo(relPath)
        batch.push(buildAsset({ relPath, name: it.name, info, metadata: it.params ?? null, now: Date.now() }))
      } catch {
        continue // 文件刚被删等情况：跳过
      }
      if (batch.length >= BATCH_SIZE) await flush()
      onProgress({ phase: 'indexing', done, total })
    }
    await flush()

    // ---------- 血统边：产物 → 参考素材 ----------
    onProgress({ phase: 'linking', done, total })
    if (isFullMigration) {
      const dbDeps: AssetDependencyRecord[] = []
      const now = Date.now()
      for (const it of items) {
        const refs = it.params?.refs ?? []
        if (!refs.length) continue
        const child = await getAssetByPath(`outputs/${it.name}`)
        if (!child) continue
        for (const r of refs) {
          if (!r.hash) continue
          const refPath = `refs/${r.hash}${refExt(r)}`
          let parentId = refAssetIds.get(refPath) ?? null
          if (!parentId) {
            const parent = await getAssetByPath(refPath)
            parentId = parent?.id ?? null
            refAssetIds.set(refPath, parentId ?? '')
          }
          if (!parentId) continue // 留档已清理：边挂不上，按方案 parent 可空但这里直接跳过半成品引用
          dbDeps.push({
            child_id: child.id,
            parent_id: parentId,
            role: 'reference',
            input_index: typeof r.order === 'number' ? r.order - 1 : null,
            operation: refs.length > 1 ? 'fusion' : 'i2i',
            metadata: JSON.stringify({ role: r.role ?? null, source: r.source ?? null }),
            created_at: now
          })
        }
      }
      if (dbDeps.length) await putDependencyBatch(dbDeps)
    }

    if (isFullMigration) {
      const state: MigrationState = { migrationId: MIGRATION_ID, state: 'done', doneAt: Date.now() }
      await setMeta(META_KEY, state)
    }
    onProgress({ phase: 'done', done, total })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isFullMigration) {
      await deleteAssetsByMigration(MIGRATION_ID)
      await setMeta(META_KEY, { migrationId: MIGRATION_ID, state: 'failed', error: msg } satisfies MigrationState)
    }
    onProgress({ phase: 'failed', done: 0, total: 0, error: msg })
  }
}

async function putDependencyBatch(records: AssetDependencyRecord[]): Promise<void> {
  const { openCanvasDB } = await import('./db')
  const db = await openCanvasDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('asset_dependencies', 'readwrite')
    const store = t.objectStore('asset_dependencies')
    records.forEach((r) => store.add(r))
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('IndexedDB deps batch failed'))
  })
}
