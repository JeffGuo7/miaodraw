import { app, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from './logger'

/**
 * 应用内更新（自研，不依赖 electron-updater）
 *
 * 为什么自研：npm 在本机解析 @oxlint/binding-* 可选依赖的元数据时必然失败（registry 脏数据 +
 * arborist dedupe bug），装不进 electron-updater；而更新这件事用 Electron 自带的 fetch/shell 就够了，
 * 自己实现还多了两个好处：① 能显示下载进度并可取消 ② 国内用户可换成自建更新源。
 *
 * 更新源优先级：
 *  1. 设置里的 updateFeed（形如 { "version": "0.2.0", "url": "https://…/miaodraw-setup-0.2.0.exe", "notes": "…" }）
 *  2. GitHub Releases（公开仓库，取 latest release 的 setup 资源）
 */

const REPO = 'JeffGuo7/miaodraw'
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`

export interface UpdateInfo {
  ok: boolean
  current: string
  latest?: string
  hasUpdate?: boolean
  notes?: string
  assetName?: string
  assetUrl?: string
  assetSize?: number
  source?: 'feed' | 'github'
  out?: string
}

export interface UpdateProgress {
  stage: 'checking' | 'download' | 'done' | 'error'
  percent?: number
  received?: number
  total?: number
  detail?: string
}

/** 版本号比较：仅取数字段，a > b 返回 1，相等 0，小于 -1（忽略 v 前缀与预发布后缀） */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string): number[] =>
    String(v || '')
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((s) => Number.parseInt(s, 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
  const x = nums(a)
  const y = nums(b)
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i++) {
    const p = x[i] ?? 0
    const q = y[i] ?? 0
    if (p > q) return 1
    if (p < q) return -1
  }
  return 0
}

let dlAbort: AbortController | null = null
const dlPath = (name: string): string => path.join(app.getPath('userData'), 'updates', name)

/** 检查更新：自定义 feed 优先，其次 GitHub Releases 的 latest */
export async function checkUpdate(feed?: string): Promise<UpdateInfo> {
  const current = app.getVersion()
  const feedUrl = (feed || '').trim()
  // 开发模式只允许自定义更新源（便于自测），GitHub 分支需要打包版才有意义
  if (!app.isPackaged && !feedUrl) {
    return { ok: false, current, out: '开发模式不检查 GitHub 更新（打包版才有效；可先用自定义更新源自测）' }
  }
  // 1) 自定义更新源
  if (feedUrl) {
    try {
      const r = await fetch(feedUrl, { headers: { 'User-Agent': 'miaodraw-updater' } })
      if (!r.ok) return { ok: false, current, out: `更新源返回 HTTP ${r.status}` }
      const j = (await r.json()) as { version?: string; url?: string; notes?: string }
      const latest = String(j.version || '').replace(/^v/i, '')
      if (!latest || !j.url) return { ok: false, current, out: '更新源数据缺少 version / url' }
      return {
        ok: true,
        current,
        latest,
        hasUpdate: compareVersions(latest, current) > 0,
        notes: j.notes,
        assetName: path.basename(new URL(j.url).pathname),
        assetUrl: j.url,
        source: 'feed'
      }
    } catch (e) {
      return { ok: false, current, out: `更新源请求失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  // 2) GitHub Releases
  try {
    const r = await fetch(RELEASES_API, {
      headers: { 'User-Agent': 'miaodraw-updater', Accept: 'application/vnd.github+json' }
    })
    if (r.status === 404) return { ok: true, current, hasUpdate: false, out: '仓库还没有发布任何 Release' }
    if (!r.ok) return { ok: false, current, out: `GitHub 返回 HTTP ${r.status}（国内网络可能需要自建更新源）` }
    const j = (await r.json()) as {
      tag_name?: string
      body?: string
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
    }
    const latest = String(j.tag_name || '').replace(/^v/i, '')
    const assets = j.assets ?? []
    const setup = assets.find((a) => /setup.*\.exe$/i.test(a.name || '')) ?? assets.find((a) => /\.exe$/i.test(a.name || ''))
    return {
      ok: true,
      current,
      latest,
      hasUpdate: !!latest && compareVersions(latest, current) > 0,
      notes: j.body?.slice(0, 2000),
      assetName: setup?.name,
      assetUrl: setup?.browser_download_url,
      assetSize: setup?.size,
      source: 'github'
    }
  } catch (e) {
    return { ok: false, current, out: `请求 GitHub 失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

export function cancelUpdateDownload(): boolean {
  if (!dlAbort) return false
  dlAbort.abort()
  dlAbort = null
  return true
}

/** 下载更新包：写 userData/updates/<name>，带进度回调；重复下载同一个文件会直接复用 */
export async function downloadUpdate(
  url: string,
  name: string,
  onProgress: (p: UpdateProgress) => void,
  expectSize?: number
): Promise<{ ok: boolean; file?: string; out?: string }> {
  if (!url) return { ok: false, out: '缺少下载地址' }
  const safeName = (name || 'miaodraw-setup.exe').replace(/[^\w.-]/g, '_')
  const abs = dlPath(safeName)
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    if (fs.existsSync(abs) && (!expectSize || fs.statSync(abs).size === expectSize)) {
      return { ok: true, file: abs }
    }
    dlAbort = new AbortController()
    const r = await fetch(url, { headers: { 'User-Agent': 'miaodraw-updater' }, signal: dlAbort.signal })
    if (!r.ok || !r.body) return { ok: false, out: `下载失败：HTTP ${r.status}` }
    const total = Number(r.headers.get('content-length') || expectSize || 0)
    const tmp = `${abs}.part`
    const fh = await fsp.open(tmp, 'w')
    let received = 0
    let lastTick = 0
    try {
      const reader = r.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        await fh.write(Buffer.from(value))
        received += value.byteLength
        const now = Date.now()
        if (now - lastTick > 300) {
          lastTick = now
          onProgress({
            stage: 'download',
            percent: total ? Math.floor((received / total) * 100) : undefined,
            received,
            total
          })
        }
      }
    } finally {
      await fh.close()
    }
    await fsp.rename(tmp, abs)
    onProgress({ stage: 'done', percent: 100, received, total })
    log('info', `update downloaded ${safeName} bytes=${received}`)
    return { ok: true, file: abs }
  } catch (e) {
    const aborted = dlAbort?.signal.aborted
    dlAbort = null
    return { ok: false, out: aborted ? '已取消下载' : `下载失败：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    dlAbort = null
  }
}

/** 启动安装包（NSIS 向导），由用户完成安装 */
export async function installUpdate(file: string): Promise<{ ok: boolean; out?: string }> {
  if (!file || !fs.existsSync(file)) return { ok: false, out: '安装包不存在，请重新下载' }
  const err = await shell.openPath(file)
  if (err) return { ok: false, out: `无法启动安装包：${err}` }
  return { ok: true }
}
