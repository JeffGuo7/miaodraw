/**
 * assets / asset_dependencies 两表 IndexedDB schema（M1 数据层）
 * 结构依据 docs/m1-migration-plan.md，参照 minimax-reference-pack 01 思路自写实现。
 * 原生 IndexedDB API，零新依赖。
 */

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
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

export function openCanvasDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (): void => {
        const db = req.result
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
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    })
  }
  return dbPromise
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
