import { app, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
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
  /** 期望的摘要：electron-builder 的 sha512（base64）或 GitHub 的 "sha256:<hex>"；缺省表示更新源未提供 */
  assetSha512?: string
  source?: 'feed' | 'github'
  out?: string
}

interface FileDigests {
  sha512hex: string
  sha512b64: string
  sha256hex: string
}

interface ExpectedDigest {
  algo: 'sha256' | 'sha512'
  kind: 'hex' | 'b64'
  value: string
}

/** 解析期望摘要：支持 "sha512-<b64>"、"sha256:<hex>"、以及 electron-builder latest.yml 的裸 base64 sha512 */
export function normalizeExpectedDigest(raw?: string): ExpectedDigest | null {
  const s = String(raw || '').trim()
  if (!s) return null
  const m = s.match(/^(sha256|sha512)[-:](.+)$/i)
  if (m) {
    const algo = m[1].toLowerCase() as 'sha256' | 'sha512'
    const v = m[2].trim()
    return { algo, kind: /^[0-9a-f]+$/i.test(v) ? 'hex' : 'b64', value: v }
  }
  // 裸 base64（sha512 为 88 字符）
  if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) return { algo: 'sha512', kind: 'b64', value: s }
  return null
}

function digestMatches(expected: ExpectedDigest, d: FileDigests): boolean {
  if (expected.algo === 'sha512') {
    return expected.kind === 'hex'
      ? expected.value.toLowerCase() === d.sha512hex
      : expected.value === d.sha512b64
  }
  // sha256 只支持 hex 形态（GitHub digest）
  return expected.kind === 'hex' && expected.value.toLowerCase() === d.sha256hex
}

async function hashFile(file: string): Promise<FileDigests> {
  const h512 = createHash('sha512')
  const h256 = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) {
    const buf = chunk as Buffer
    h512.update(buf)
    h256.update(buf)
  }
  const sha512hex = h512.digest('hex')
  return { sha512hex, sha512b64: Buffer.from(sha512hex, 'hex').toString('base64'), sha256hex: h256.digest('hex') }
}

/** 更新包地址必须是 https；开发态（未打包）允许 http 以便本地自测 */
function isAllowedUpdateUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && !app.isPackaged
  } catch {
    return false
  }
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
      const j = (await r.json()) as { version?: string; url?: string; notes?: string; sha512?: string; sha256?: string }
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
        assetSha512: j.sha512 || j.sha256,
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
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number; digest?: string }>
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
      assetSha512: setup?.digest,
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
  expectSize?: number,
  expectSha512?: string
): Promise<{ ok: boolean; file?: string; out?: string }> {
  if (!url) return { ok: false, out: '缺少下载地址' }
  if (!isAllowedUpdateUrl(url)) return { ok: false, out: '更新包地址必须是 https（开发态例外）' }
  const expected = normalizeExpectedDigest(expectSha512)
  const safeName = (name || 'miaodraw-setup.exe').replace(/[^\w.-]/g, '_')
  const abs = dlPath(safeName)
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    // 已有缓存：大小一致且（若给了摘要）摘要一致才复用，否则删掉重下
    if (fs.existsSync(abs) && (!expectSize || fs.statSync(abs).size === expectSize)) {
      if (!expected?.value) return { ok: true, file: abs }
      const cached = await hashFile(abs)
      if (digestMatches(expected, cached)) return { ok: true, file: abs }
      log('warn', 'update cached file digest mismatch, re-download')
      await fsp.unlink(abs).catch(() => undefined)
    }
    dlAbort = new AbortController()
    const r = await fetch(url, { headers: { 'User-Agent': 'miaodraw-updater' }, signal: dlAbort.signal })
    if (!r.ok || !r.body) return { ok: false, out: `下载失败：HTTP ${r.status}` }
    const total = Number(r.headers.get('content-length') || expectSize || 0)
    const tmp = `${abs}.part`
    const fh = await fsp.open(tmp, 'w')
    // 边下边算摘要：体积大，不能下完再读一遍
    const h512 = createHash('sha512')
    const h256 = createHash('sha256')
    let received = 0
    let lastTick = 0
    try {
      const reader = r.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const buf = Buffer.from(value)
        h512.update(buf)
        h256.update(buf)
        await fh.write(buf)
        received += buf.byteLength
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
    // 落盘前校验：摘要不符立即丢弃 .part —— 绝不把未校验的 exe rename 成可执行安装包
    const sha512hex = h512.digest('hex')
    const digests: FileDigests = {
      sha512hex,
      sha512b64: Buffer.from(sha512hex, 'hex').toString('base64'),
      sha256hex: h256.digest('hex')
    }
    if (expected?.value && !digestMatches(expected, digests)) {
      await fsp.unlink(tmp).catch(() => undefined)
      onProgress({ stage: 'error', detail: '安装包校验失败' })
      log('error', `update digest mismatch ${safeName}`)
      return { ok: false, out: '安装包校验失败（摘要不匹配），已丢弃下载内容；请检查更新源' }
    }
    await fsp.rename(tmp, abs)
    // 记下实际摘要：安装前复验，防止下载后被替换
    await fsp.writeFile(`${abs}.sha512`, digests.sha512b64, 'utf-8').catch(() => undefined)
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
  // 完整性复验：下载时写下的 .sha512 sidecar 必须匹配，否则拒绝执行
  const sidecar = `${file}.sha512`
  if (fs.existsSync(sidecar)) {
    try {
      const expected = normalizeExpectedDigest(fs.readFileSync(sidecar, 'utf-8').trim())
      if (expected?.value) {
        const actual = await hashFile(file)
        if (!digestMatches(expected, actual)) {
          log('error', 'update install blocked: digest mismatch')
          return { ok: false, out: '安装包校验失败（文件已被改动），已拒绝执行，请重新下载' }
        }
      }
    } catch (e) {
      return { ok: false, out: `安装包复验失败：${e instanceof Error ? e.message : String(e)}` }
    }
  } else {
    log('warn', 'update install without digest sidecar (legacy download)')
  }
  const err = await shell.openPath(file)
  if (err) return { ok: false, out: `无法启动安装包：${err}` }
  return { ok: true }
}
