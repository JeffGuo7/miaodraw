/**
 * assets / asset_dependencies 两表 IndexedDB schema（M1 数据层）
 * 结构依据 docs/m1-migration-plan.md，参照 minimax-reference-pack 01 思路自写实现。
 * 原生 IndexedDB API，零新依赖。
 */
import type { ChatMessage, PlanEvent, PlanRecord, StageRecord } from '../../../shared/plan-types'
import type { VideoJobRecord } from '../../../main/video/jobs'

export interface AssetRecord {
  id: string
  path: string
  status: 'active' | 'missing'
  size: number
  mtime_ms: number
  quick_hash: string | null
  full_hash: string | null
  width: number | null
  height: number | null
  duration_ms: number | null
  mime_type: string | null
  name: string
  metadata: string | null // JSON：prompt/seed/model 等生成参数
  created_at: number
  updated_at: number
  migration_id: string | null
  // 缺失资产候选（行内合并 UI 用；active 行两列均 null）
  candidate_asset_id: string | null
  candidate_path: string | null
  /** v2：被哪个资产取代（重跑留档；未取代为 null） */
  superseded_by?: string | null
}

export interface AssetDependencyRecord {
  id?: number
  child_id: string
  parent_id: string | null
  role: 'reference' | 'derived' | 'group'
  input_index: number | null
  operation: string | null // 'i2i' | 'fusion' | 'upscale' | ...
  metadata: string | null
  created_at: number
}

export interface MigrationState {
  migrationId: string
  state: 'idle' | 'running' | 'done' | 'failed'
  doneAt?: number
  count?: number
  error?: string
}

const DB_NAME = 'miaodraw-canvas'
/** v2：plans/stages（O1）；v3：plan_events（B 批审计）；v4：messages（C1 对话面板）；v5：video_jobs（V1 视频作业幂等）
 *  注意：任务卡写的「DB_VERSION→3」按当时假设；B 批已把 plan_events 落在 v3，故 messages 顺延 v4、video_jobs 顺延 v5。
 *  v1→v2 的 superseded_by 回填与 assertAssetsMigrated() 一直保留、不短路。 */
const DB_VERSION = 5

export const SCHEMA_VERSION = DB_VERSION

let dbPromise: Promise<IDBDatabase> | null = null

export function openCanvasDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (event): void => {
        const db = req.result
        const oldVersion = event.oldVersion

        if (!db.objectStoreNames.contains('assets')) {
          const assets = db.createObjectStore('assets', { keyPath: 'id' })
          assets.createIndex('path', 'path', { unique: true })
          assets.createIndex('quick_hash', 'quick_hash')
          assets.createIndex('size_quick', ['size', 'quick_hash'])
          assets.createIndex('mime_type', 'mime_type')
          assets.createIndex('status_updated', ['status', 'updated_at'])
        }
        if (!db.objectStoreNames.contains('asset_dependencies')) {
          const deps = db.createObjectStore('asset_dependencies', { keyPath: 'id', autoIncrement: true })
          deps.createIndex('child_id', 'child_id')
          deps.createIndex('parent_id', 'parent_id')
          deps.createIndex('role', 'role')
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' })
        }

        // ── v2（编排 O1）──
        if (!db.objectStoreNames.contains('plans')) {
          const plans = db.createObjectStore('plans', { keyPath: 'id' })
          plans.createIndex('updated_at', 'updated_at')
          plans.createIndex('status', 'status')
        }
        if (!db.objectStoreNames.contains('stages')) {
          const stages = db.createObjectStore('stages', { keyPath: 'id' })
          stages.createIndex('plan_id', 'plan_id')
          stages.createIndex('plan_id_order', ['plan_id', 'order'])
          stages.createIndex('status', 'status')
        }
        // ── v3（B 批）：append-only 审计事件 ──
        if (!db.objectStoreNames.contains('plan_events')) {
          const events = db.createObjectStore('plan_events', { keyPath: 'id', autoIncrement: true })
          events.createIndex('plan_id', 'plan_id')
          events.createIndex('created_at', 'created_at')
        }
        // ── v4（C1）：对话消息（按 plan_id 索引，created_at 排序） ──
        if (!db.objectStoreNames.contains('messages')) {
          const messages = db.createObjectStore('messages', { keyPath: 'id' })
          messages.createIndex('plan_id', 'plan_id')
          messages.createIndex('created_at', 'created_at')
        }
        // ── v5（V1 视频管线）：作业表（job key = plan_id|stage_id|work_item_id，天然幂等） ──
        if (!db.objectStoreNames.contains('video_jobs')) {
          const jobs = db.createObjectStore('video_jobs', { keyPath: 'id' })
          jobs.createIndex('plan_id', 'plan_id')
          jobs.createIndex('stage_id', 'stage_id')
          jobs.createIndex('plan_stage', ['plan_id', 'stage_id'])
          jobs.createIndex('status', 'status')
        }

        // 旧资产补 superseded_by=null（重跑留档字段），并做迁移断言
        if (oldVersion > 0 && oldVersion < 2) {
          const store = req.transaction ? req.transaction.objectStore('assets') : null
          if (store) {
            let migrated = 0
            const cursorReq = store.openCursor()
            cursorReq.onsuccess = (e) => {
              const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
              if (!cursor) {
                console.info(`[canvas-db] v1→v2 迁移完成：回填 superseded_by ${migrated} 条`)
                return
              }
              const rec = cursor.value as Record<string, unknown>
              if (rec.superseded_by === undefined) {
                rec.superseded_by = null
                cursor.update(rec)
                migrated++
              }
              cursor.continue()
            }
          }
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    })
  }
  return dbPromise
}

/** 迁移断言：所有资产记录都必须有 superseded_by 字段（v2 不变式）
 *  v2 之前由生成链路写入的行没有该字段（onupgradeneeded 的 v1→v2 回填只覆盖升级那一刻的旧行），
 *  这里做一次**幂等回填**再断言：不回降 DB 版本、不删库，仍未修好才抛错（fail-closed）。 */
export async function assertAssetsMigrated(): Promise<{ total: number; missing: number; repaired: number }> {
  const all = await tx<AssetRecord[]>('assets', 'readonly', (s) => s.getAll())
  const missing = all.filter((a) => (a as unknown as Record<string, unknown>).superseded_by === undefined)
  if (missing.length > 0) {
    const db = await openCanvasDB()
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('assets', 'readwrite')
      const store = t.objectStore('assets')
      for (const rec of missing) store.put({ ...(rec as unknown as Record<string, unknown>), superseded_by: null } as unknown as AssetRecord)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error ?? new Error('superseded_by 回填失败'))
    })
  }
  const after = await tx<AssetRecord[]>('assets', 'readonly', (s) => s.getAll())
  const stillMissing = after.filter((a) => (a as unknown as Record<string, unknown>).superseded_by === undefined).length
  if (stillMissing > 0) throw new Error(`资产表迁移不全：${stillMissing}/${after.length} 条缺 superseded_by`)
  return { total: after.length, missing: 0, repaired: missing.length }
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openCanvasDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
      })
  )
}

// ---------- meta ----------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await tx<{ key: string; value: T } | undefined>('meta', 'readonly', (s) => s.get(key))
  return row?.value
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await tx('meta', 'readwrite', (s) => s.put({ key, value }))
}

// ---------- assets ----------

export async function getAssetByPath(path: string): Promise<AssetRecord | undefined> {
  const row = await tx<AssetRecord | undefined>('assets', 'readonly', (s) => s.index('path').get(path))
  return row ?? undefined
}

export async function putAssetBatch(records: AssetRecord[]): Promise<void> {
  const db = await openCanvasDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('assets', 'readwrite')
    const store = t.objectStore('assets')
    records.forEach((r) => store.put(r))
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('IndexedDB batch failed'))
    t.onabort = () => reject(t.error ?? new Error('IndexedDB batch aborted'))
  })
}

/** 按 migrationId 删除上批半成品（失败重跑前清理） */
export async function deleteAssetsByMigration(migrationId: string): Promise<number> {
  const db = await openCanvasDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction('assets', 'readwrite')
    const store = t.objectStore('assets')
    const req = store.openCursor()
    let deleted = 0
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const rec = cursor.value as AssetRecord
      if (rec.migration_id === migrationId) {
        cursor.delete()
        deleted++
      }
      cursor.continue()
    }
    t.oncomplete = () => resolve(deleted)
    t.onerror = () => reject(t.error ?? new Error('IndexedDB cursor failed'))
  })
}

export async function countAssets(): Promise<number> {
  return tx<number>('assets', 'readonly', (s) => s.count())
}

export async function putDependencyBatch(records: AssetDependencyRecord[]): Promise<void> {
  const db = await openCanvasDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('asset_dependencies', 'readwrite')
    const store = t.objectStore('asset_dependencies')
    records.forEach((r) => store.add(r))
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('IndexedDB deps batch failed'))
    t.onabort = () => reject(t.error ?? new Error('IndexedDB deps batch aborted'))
  })
}

// ---------- plans / stages（编排 O1：plan 是真相源，画布节点只是视图） ----------

export async function putPlan(plan: PlanRecord): Promise<void> {
  await tx('plans', 'readwrite', (s) => s.put(plan))
}

export async function getPlan(id: string): Promise<PlanRecord | undefined> {
  return (await tx<PlanRecord | undefined>('plans', 'readonly', (s) => s.get(id))) ?? undefined
}

/** 计划列表：按 updated_at 倒序（索引 plans.updated_at） */
export async function listPlans(limit = 50): Promise<PlanRecord[]> {
  const db = await openCanvasDB()
  return new Promise((resolve, reject) => {
    const out: PlanRecord[] = []
    const t = db.transaction('plans', 'readonly')
    const req = t.objectStore('plans').index('updated_at').openCursor(null, 'prev')
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || out.length >= limit) return resolve(out)
      out.push(cursor.value as PlanRecord)
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('plans list failed'))
  })
}

/** 某计划的全部阶段：按 (plan_id, order) 复合索引升序 */
export async function listStagesByPlan(planId: string): Promise<StageRecord[]> {
  const db = await openCanvasDB()
  return new Promise((resolve, reject) => {
    const out: StageRecord[] = []
    const t = db.transaction('stages', 'readonly')
    const req = t.objectStore('stages').index('plan_id_order').openCursor(IDBKeyRange.bound([planId, 0], [planId, Number.MAX_SAFE_INTEGER]))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return resolve(out)
      out.push(cursor.value as StageRecord)
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('stages list failed'))
  })
}

export async function putStageBatch(stages: StageRecord[]): Promise<void> {
  const db = await openCanvasDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('stages', 'readwrite')
    const store = t.objectStore('stages')
    stages.forEach((s) => store.put(s))
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('stages put failed'))
    t.onabort = () => reject(t.error ?? new Error('stages put aborted'))
  })
}



// ---------- plan_events（B 批：append-only 审计） ----------

export async function appendPlanEvent(event: PlanEvent): Promise<void> {
  const db = await openCanvasDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('plan_events', 'readwrite')
    const { id: _ignored, ...rest } = event
    t.objectStore('plan_events').add(rest)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('plan event append failed'))
  })
}

// ---------- messages（C1：对话面板，按 plan_id 索引） ----------

export async function putMessage(message: ChatMessage): Promise<void> {
  await tx('messages', 'readwrite', (s) => s.put(message))
}

/** 删除一条消息（镜像失败回滚用，避免去重键永久占位） */
export async function deleteMessage(id: string): Promise<void> {
  await tx('messages', 'readwrite', (s) => s.delete(id))
}

/** 取某计划的消息（按 created_at 升序，只取最近 limit 条） */
export async function listMessagesByPlan(planId: string, limit = 50): Promise<ChatMessage[]> {
  const db = await openCanvasDB()
  return new Promise((resolve, reject) => {
    const all: ChatMessage[] = []
    const t = db.transaction('messages', 'readonly')
    const req = t.objectStore('messages').index('plan_id').openCursor(IDBKeyRange.only(planId))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve(all.sort((a, b) => a.created_at - b.created_at).slice(-limit))
        return
      }
      all.push(cursor.value as ChatMessage)
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('messages list failed'))
  })
}

/** 全部消息里仍存在的 plan_id（重启恢复单计划面板用） */
// ── v5：视频作业（job key = plan_id|stage_id|work_item_id，put 覆盖即幂等） ──

/** 单条作业落盘（重复调用不产生第二条） */
export async function putVideoJob(job: VideoJobRecord): Promise<void> {
  const db = await openCanvasDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('video_jobs', 'readwrite')
    t.objectStore('video_jobs').put(job)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('video_jobs put failed'))
  })
}

/** 某计划（可限定阶段）的全部作业：按 shot_index / work_item_id 升序 */
export async function listVideoJobs(planId: string, stageId?: string): Promise<VideoJobRecord[]> {
  const db = await openCanvasDB()
  return new Promise((resolve, reject) => {
    const out: VideoJobRecord[] = []
    const t = db.transaction('video_jobs', 'readonly')
    const range = stageId ? IDBKeyRange.only([planId, stageId]) : IDBKeyRange.bound([planId, ''], [planId, '\uffff'])
    const req = t.objectStore('video_jobs').index('plan_stage').openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve(out.sort((a, b) => a.shot_index - b.shot_index || a.work_item_id.localeCompare(b.work_item_id)))
        return
      }
      out.push(cursor.value as VideoJobRecord)
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('video_jobs list failed'))
  })
}

