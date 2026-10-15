/**
 * 画布资产 IPC（M1 数据层）：为 outputs / refs 里的既有文件产出资产信息。
 * 只读不写：迁移与对账都是「建索引」，原文件零改动。
 */
import { nativeImage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 统一资产信息（渲染层建 assets 记录用） */
export interface CanvasAssetInfo {
  size: number
  mtimeMs: number
  quickHash: string
  fullHash: string
  width: number | null
  height: number | null
  mime: string
}

type HandleFn = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown) => void

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 校验相对路径：允许 outputs/<图片名>、refs/<hash><ext>、pixelle/<视频相对路径>（防路径构造） */
function resolveAssetFile(paths: { outputsPath: () => string; userDataPath: () => string; pixelleOutputPath: () => string }, rel: string): { abs: string; mime: string } | null {
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'))
  let base: string
  let name: string
  if (norm.startsWith('outputs/')) {
    base = paths.outputsPath()
    name = norm.slice('outputs/'.length)
  } else if (norm.startsWith('refs/')) {
    base = path.join(paths.userDataPath(), 'refs')
    name = norm.slice('refs/'.length)
  } else if (norm.startsWith('pixelle/')) {
    base = paths.pixelleOutputPath()
    name = norm.slice('pixelle/'.length)
  } else {
    return null
  }
  if (!name || name.includes('..') || name.includes('\\')) return null
  if (norm.startsWith('pixelle/')) {
    // pixelle 产物允许子目录（任务目录/final.mp4），逐段防穿越
    if (name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  } else if (name.includes('/')) {
    return null
  }
  const ext = path.extname(name).toLowerCase()
  const mime = MIME_BY_EXT[ext] ?? (ext === '.mp4' ? 'video/mp4' : '')
  if (!mime) return null
  return { abs: path.join(base, name), mime }
}

export function registerCanvasAssetHandlers(
  handle: HandleFn,
  paths: { outputsPath: () => string; userDataPath: () => string; pixelleOutputPath: () => string }
): void {
  handle('canvas:assetInfo', async (_e, rel: string): Promise<CanvasAssetInfo> => {
    const target = resolveAssetFile(paths, rel)
    if (!target) throw new Error('资产路径不合法')
    const st = await fsp.stat(target.abs)

    // pixelle 视频（可能上百 MB）：只读头部 4MB 做 quick_hash，不整读不算 full
    if (rel.startsWith('pixelle/')) {
      const fh = await fsp.open(target.abs, 'r')
      try {
        const head = Buffer.alloc(Math.min(4 * 1024 * 1024, st.size))
        await fh.read(head, 0, head.length, 0)
        const quickHash = crypto.createHash('sha256').update(head).digest('hex')
        return { size: st.size, mtimeMs: st.mtimeMs, quickHash, fullHash: quickHash, width: null, height: null, mime: target.mime }
      } finally {
        await fh.close()
      }
    }

    const buf = await fsp.readFile(target.abs)
    // quick_hash = 前 4MB，full_hash = 全量（两级指纹，M1 方案 §①）
    const quickHash = sha256(buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024)))
    const fullHash = sha256(buf)
    let width: number | null = null
    let height: number | null = null
    try {
      const img = nativeImage.createFromBuffer(buf)
      const sz = img.getSize()
      if (sz.width > 0 && sz.height > 0) {
        width = sz.width
        height = sz.height
      }
    } catch {
      // 非图片或解码失败：宽高留空
    }
    return { size: st.size, mtimeMs: st.mtimeMs, quickHash, fullHash, width, height, mime: target.mime }
  })
}
