/**
 * assets / asset_dependencies 两表 IndexedDB schema（M1 数据层）
 * 结构依据 docs/m1-migration-plan.md，参照 minimax-reference-pack 01 思路自写实现。
 * 原生 IndexedDB API，零新依赖。
 */
import type { PlanEvent, PlanRecord, StageRecord } from './plan-types'

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
/** v2：plans/stages（编排 O1）；v3：plan_events（B 批审计） */
const DB_VERSION = 3

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

/** 迁移断言：所有资产记录都必须有 superseded_by 字段（v2 不变式） */
export async function assertAssetsMigrated(): Promise<{ total: number; missing: number }> {
  const all = await tx<AssetRecord[]>('assets', 'readonly', (s) => s.getAll())
  const missing = all.filter((a) => (a as unknown as Record<string, unknown>).superseded_by === undefined).length
  if (missing > 0) throw new Error(`资产表迁移不全：${missing}/${all.length} 条缺 superseded_by`)
  return { total: all.length, missing }
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

/** 删除计划及其阶段（不删产物资产，符合设计稿 §5） */
export async function deletePlanCascade(planId: string): Promise<{ stages: number }> {
  const stages = await listStagesByPlan(planId)
  const db = await openCanvasDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['plans', 'stages'], 'readwrite')
    t.objectStore('plans').delete(planId)
    const store = t.objectStore('stages')
    stages.forEach((s) => store.delete(s.id))
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('plan delete failed'))
  })
  return { stages: stages.length }
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

export async function listPlanEvents(planId: string, limit = 200): Promise<PlanEvent[]> {
  const db = await openCanvasDB()
  return new Promise((resolve, reject) => {
    const out: PlanEvent[] = []
    const t = db.transaction('plan_events', 'readonly')
    const req = t.objectStore('plan_events').index('plan_id').openCursor(IDBKeyRange.only(planId))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || out.length >= limit) return resolve(out)
      out.push(cursor.value as PlanEvent)
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('plan events list failed'))
  })
}
