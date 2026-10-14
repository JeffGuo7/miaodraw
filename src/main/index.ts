import { app, shell, BrowserWindow, ipcMain, protocol, net, dialog, safeStorage, nativeImage, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import {
  httpChat,
  httpModels,
  httpBailianImage,
  httpOpenAIImages,
  httpWanxEdit,
  httpEraseCompletion,
  imageCapability,
  clampRefs,
  persistImage,
  cancelHttp,
  cancelAllHttp,
  compatBase,
  originOf,
  MODEL_NOISE_RE,
  DASHSCOPE_ORIGIN,
  type ModelConn,
  type RefImage,
  type WanxEditFn
} from './http'
import { httpGenerate, PROVIDER_BASE_URLS } from './providers'
import { runAgent } from './agent'
import { createSegmentService } from './segment'
import { loadLibrary, libraryRoot } from './library'
import { initLogger, log } from './logger'
import { checkUpdate, downloadUpdate, installUpdate, cancelUpdateDownload } from './updater'
import { localCaption, prefetchCaptionModel, captionModelId, type CaptionProgress } from './localCaption'
import { registerCanvasAssetHandlers } from './canvasAssets'
import { registerPixelleHandlers, pixelleOutputDir, stopPixelleBackend } from './pixelle'

// ---------- 路径 ----------
const APP_ROOT = app.getAppPath()
const isPackaged = app.isPackaged
const LIB_ROOT = libraryRoot(isPackaged, APP_ROOT, process.resourcesPath)
const OUT_DIR = isPackaged ? path.join(app.getPath('userData'), 'outputs') : path.join(APP_ROOT, 'outputs')
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')
/** 素材留档允许的扩展名（refs:read 白名单，防路径构造） */
const REF_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

// ---------- 单实例 ----------
// 验收截图模式使用独立 userData，避免与正在运行的正式实例抢单实例锁
if (process.env.TEST_MODE === 'screenshot') {
  app.setPath('userData', path.join(app.getPath('userData'), 'shot-session'))
}
if (!app.requestSingleInstanceLock()) {
  console.log('[debug] single-instance lock denied, quitting')
  app.quit()
}

// ---------- 分割服务（复用带目录逃逸校验的 parseMediaUrl，勿在此重复实现） ----------
const segmentService = createSegmentService((url) => parseMediaUrl(url))

// ---------- media:// 协议 ----------
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

function resolveMediaHost(bucket: string): string | null {
  if (bucket === 'out') return OUT_DIR
  if (bucket === 'lib-a') return path.join(LIB_ROOT, 'libA', 'images')
  if (bucket === 'lib-b') return path.join(LIB_ROOT, 'libB', 'data', 'images')
  return null
}

// ---------- 缩略图缓存（media:// ?w= 降采样） ----------
const thumbCache = new Map<string, Buffer>()
async function thumbnail(abs: string, w: number): Promise<Buffer | null> {
  const key = `${abs}@${w}`
  const hit = thumbCache.get(key)
  if (hit) return hit
  try {
    const img = nativeImage.createFromPath(abs)
    if (img.isEmpty()) return null
    const { width } = img.getSize()
    const scaled = width > w ? img.resize({ width: w }) : img
    const buf = scaled.toPNG()
    if (thumbCache.size >= 100) {
      const oldest = thumbCache.keys().next().value
      if (oldest !== undefined) thumbCache.delete(oldest)
    }
    thumbCache.set(key, buf)
    return buf
  } catch {
    return null
  }
}

/** media://local/<bucket>/<相对路径> → 绝对路径（含目录逃逸校验），失败返回 null */
function parseMediaUrl(url: string): string | null {  try {
    const u = new URL(url)
    if (u.protocol !== 'media:') return null
    const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean)
    if (segs.length < 2) return null
    const base = resolveMediaHost(segs[0])
    if (!base) return null
    const abs = path.resolve(base, ...segs.slice(1))
    if (!abs.startsWith(path.resolve(base) + path.sep)) return null
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
    return abs
  } catch {
    return null
  }
}

/** 作品目录内文件名 → 绝对路径：拒绝分隔符/越界，仅允许图片扩展名。
 *  唯一出口：history:delete / agent:run / image:chain 共用，勿在别处自行 path.join */
function resolveOutputPath(name: string): string | null {
  if (!name || typeof name !== 'string') return null
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  if (!/\.(png|jpe?g|webp)$/i.test(name)) return null
  const abs = path.resolve(OUT_DIR, name)
  if (!abs.startsWith(path.resolve(OUT_DIR) + path.sep)) return null
  return abs
}

// ---------- 设置 ----------
let libPromise: Promise<unknown> | null = null
let stylesPromise: Promise<unknown> | null = null

interface Settings {
  model?: string
  size?: string
  onboarded?: string
  /** @deprecated 旧版明文服务商密钥，仅启动迁移时读取，随后清空 */
  providers?: Record<string, { apiKey?: string }>
  /** 第三方服务商密钥密文（safeStorage 加密后 base64；不支持加密的平台退化为 base64） */
  providerKeysEnc?: Record<string, { enc: string; plainFallback?: boolean }>
  /** 通用模型配置：自定义供应商/模型 + 能力默认值 */
  modelConfig?: ModelConfig
  activeModel?: { provider: string; model: string }
  /** 百炼密钥密文（safeStorage 加密后 base64；不支持加密的平台退化为 base64 并提示） */
  bailianKeyEnc?: string
  bailianKeyPlain?: boolean
  /** 百炼工作空间 ID（非机密；o1_ 工作空间密钥需注入 BAILIAN_WORKSPACE_ID） */
  bailianWorkspace?: string
  /** 工作空间专属接入点（sk-ws- 子密钥需注入 BAILIAN_BASE_URL） */
  bailianBaseUrl?: string
  /** 自定义更新源（返回 {version,url,notes} 的 JSON；留空则用 GitHub Releases） */
  updateFeed?: string
}
function readSettings(): Settings {
  try {
    // 容错 UTF-8 BOM：外部工具（PowerShell 5.1 等）写出的配置带 BOM 会让 JSON.parse 抛异常，
    // 进而被当成"空设置"覆盖用户全部配置——历史真实事故，此处必须剥离
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf-8').replace(/^\uFEFF/, '')
    const s = JSON.parse(raw) as Settings
    // 旧版单模型设置迁移到多服务商结构
    if (!s.activeModel && s.model) s.activeModel = { provider: 'bailian', model: s.model }
    return s
  } catch {
    return {}
  }
}
function writeSettings(patch: Settings): Settings {
  const next = { ...readSettings(), ...patch }
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2))
  return next
}

// ---------- 密钥加解密（百炼与第三方服务商共用） ----------
function encryptSecret(plain: string): { enc: string; plainFallback: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: safeStorage.encryptString(plain).toString('base64'), plainFallback: false }
  }
  return { enc: Buffer.from(plain, 'utf-8').toString('base64'), plainFallback: true }
}
function decryptSecret(enc: string, plainFallback?: boolean): string {
  try {
    if (plainFallback || !safeStorage.isEncryptionAvailable()) {
      return Buffer.from(enc, 'base64').toString('utf-8')
    }
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

// ---------- 百炼密钥（应用内配置，纯 HTTP 直连，与命令行登录态彻底解耦） ----------
/** 旧版 bailianKeyEnc 字段解密（迁移前兜底） */
function decryptKey(s: Settings): string {
  if (!s.bailianKeyEnc) return ''
  try {
    if (s.bailianKeyPlain || !safeStorage.isEncryptionAvailable()) {
      return Buffer.from(s.bailianKeyEnc, 'base64').toString('utf-8')
    }
    return safeStorage.decryptString(Buffer.from(s.bailianKeyEnc, 'base64'))
  } catch {
    return ''
  }
}
/** 百炼密钥统一从 providerKeysEnc.bailian 读取；旧版 bailianKeyEnc 字段仅在迁移前兜底 */
function bailianApiKey(): string {
  const s = readSettings()
  const rec = s.providerKeysEnc?.['bailian']
  if (rec?.enc) return decryptSecret(rec.enc, rec.plainFallback)
  return decryptKey(s)
}
function bailianOrigin(): string {
  return originOf(readSettings().bailianBaseUrl ?? '')
}
function bailianKeyInfo(): { configured: boolean; masked: string; plan: 'token-plan' | 'ordinary' | 'workspace' | 'unknown'; plainFallback: boolean } {
  const key = bailianApiKey()
  if (!key) return { configured: false, masked: '', plan: 'unknown', plainFallback: false }
  const plan = key.startsWith('sk-sp-')
    ? 'token-plan'
    : key.startsWith('sk-ws-') || key.startsWith('o1_')
      ? 'workspace'
      : key.startsWith('sk-')
        ? 'ordinary'
        : 'unknown'
  const masked = key.length <= 8 ? '••••' : `${key.slice(0, 6)}••••${key.slice(-4)}`
  const rec = readSettings().providerKeysEnc?.['bailian']
  return { configured: true, masked, plan, plainFallback: rec ? !!rec.plainFallback : !!readSettings().bailianKeyPlain }
}

/** 任意供应商（含 bailian）的调用连接描述；密钥/接入点每次实时读设置，保存即热生效 */
function connFor(provider: string, model: string): ModelConn {
  if (provider === 'bailian') {
    return { provider, model, kind: 'bailian', origin: bailianOrigin(), apiKey: bailianApiKey() }
  }
  const custom = getModelConfig().customProviders?.find((c) => c.id === provider)
  const apiBase = (custom?.baseUrl || PROVIDER_BASE_URLS[provider] || '').replace(/\/+$/, '')
  return { provider, model, kind: 'openai', apiBase, apiKey: getProviderKey(provider) }
}

// ---------- 第三方服务商密钥（safeStorage 加密，与百炼密钥同权；明文不落盘、不回显） ----------
// bailian 纳入统一存储：providerKeysEnc.bailian 即百炼密钥（HTTP 直连唯一鉴权来源）
const PROVIDER_IDS = ['bailian', 'siliconflow', 'openai'] as const
type ProviderId = (typeof PROVIDER_IDS)[number]

function isProviderId(v: string): v is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(v)
}

function getProviderKey(provider: string): string {
  if (!provider) return ''
  const rec = readSettings().providerKeysEnc?.[provider]
  if (!rec?.enc) return ''
  return decryptSecret(rec.enc, rec.plainFallback)
}

// ---------- 通用模型配置（Cherry Studio 式：供应商 + 模型条目 + 能力默认值） ----------
interface UserModelEntry {
  id: string
  name: string
  caps: string[]
}
interface CustomProvider {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  models: UserModelEntry[]
}
interface ModelConfig {
  extraModels?: Record<string, UserModelEntry[]>
  customProviders?: CustomProvider[]
  defaults?: { image?: string; text?: string; vision?: string }
  /** 从服务端 /models 拉取的模型 ID 目录（按供应商缓存，Cherry Studio 式自动发现） */
  fetchedModels?: Record<string, string[]>
}

function getModelConfig(): ModelConfig {
  return readSettings().modelConfig ?? {}
}

/** 能力默认值解析："provider::model" → { provider, model }；未配置回退内置 */
function resolveDefault(kind: 'image' | 'text' | 'vision', fallback: { provider: string; model: string }): { provider: string; model: string } {
  const raw = getModelConfig().defaults?.[kind]
  if (raw) {
    const [p, m] = raw.split('::')
    if (p && m) return { provider: p, model: m }
  }
  return fallback
}

function providerKeysInfo(): Record<string, { configured: boolean; masked: string; plainFallback: boolean }> {
  const s = readSettings()
  const out: Record<string, { configured: boolean; masked: string; plainFallback: boolean }> = {}
  for (const id of PROVIDER_IDS) {
    const rec = s.providerKeysEnc?.[id]
    if (!rec?.enc) {
      out[id] = { configured: false, masked: '', plainFallback: false }
      continue
    }
    const k = decryptSecret(rec.enc, rec.plainFallback)
    out[id] = {
      configured: k.length > 0,
      masked: k.length <= 8 ? '••••' : `${k.slice(0, 4)}••••${k.slice(-4)}`,
      plainFallback: !!rec.plainFallback
    }
  }
  // 自定义供应商的密钥状态一并回显（掩码）
  for (const c of getModelConfig().customProviders ?? []) {
    const rec = s.providerKeysEnc?.[c.id]
    if (rec?.enc) {
      const k = decryptSecret(rec.enc, rec.plainFallback)
      out[c.id] = {
        configured: k.length > 0,
        masked: k.length <= 8 ? '••••' : `${k.slice(0, 4)}••••${k.slice(-4)}`,
        plainFallback: !!rec.plainFallback
      }
    } else {
      out[c.id] = { configured: false, masked: '', plainFallback: false }
    }
  }
  return out
}

/** 旧版明文 providers.*.apiKey → safeStorage 加密迁移，并从设置中移除明文字段（启动时执行） */
function migrateLegacyProviderKeys(): void {
  const s = readSettings()
  if (!s.providers) return
  const next: NonNullable<Settings['providerKeysEnc']> = { ...s.providerKeysEnc }
  for (const id of PROVIDER_IDS) {
    const plain = s.providers[id]?.apiKey
    if (plain && !next[id]?.enc) next[id] = encryptSecret(plain)
  }
  writeSettings({ providerKeysEnc: next, providers: undefined })
}

// ---------- 收藏 ----------
interface FavItem {
  key: string
  src: 'a' | 'b'
  n: number
  title: string
  prompt: string
  img: string
  savedAt: number
}
function readFavorites(): FavItem[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'favorites.json'), 'utf-8')) as FavItem[]
  } catch {
    return []
  }
}
function writeFavorites(list: FavItem[]): void {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(path.join(app.getPath('userData'), 'favorites.json'), JSON.stringify(list, null, 2))
}

// ---------- 窗口 ----------
let win: BrowserWindow | null = null

/** 应用图标：打包态在 resources 下，开发态在 build 下；缺文件时回退默认 */
const APP_ICON = isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(APP_ROOT, 'build', 'icon.png')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1520,
    height: 940,
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#1d1d1f',
      height: 56
    },
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#f5f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win?.show())
  // 外链只放行 http(s)；file:/smb:/自定义 scheme 一律不交给系统打开
  win.webContents.setWindowOpenHandler((d) => {
    if (/^https?:\/\//i.test(d.url)) void shell.openExternal(d.url)
    return { action: 'deny' }
  })
  // 禁止整窗导航离开应用页面：一旦被导去外部站点，preload 仍会注入，等于把全套 IPC 交给对方
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) e.preventDefault()
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ---------- 验收截图模式（与 aodl-pilot 的 TEST_MODE 同思路） ----------
const VIEW_INDEX: Record<string, number> = { create: 0, canvas: 1, compose: 2, library: 3, distill: 4, history: 5, settings: 6 }

/** smoke 断言：记录每个验收点的结果，ERR/异常计入失败，最终决定退出码 */
let shotErrors = 0
function check(label: string, v: unknown): void {
  const s = String(v)
  if (s.startsWith('ERR') || s.includes('"err"')) {
    shotErrors++
    console.log(`[shot] FAIL ${label}:`, s.slice(0, 200))
  } else {
    console.log(`[shot] ok   ${label}:`, s.slice(0, 200))
  }
}

async function screenshotMode(w: BrowserWindow): Promise<void> {
  w.webContents.on('console-message', (_e, _level, message) => {
    if (message.toLowerCase().includes('error')) console.log('[renderer]', message.slice(0, 300))
  })
  // 整体看门狗：默认 90s 后强制截图退出（超时计为失败）；短视频/长任务可用 SHOT_WATCHDOG_MS 延长
  const watchdogMs = Number(process.env.SHOT_WATCHDOG_MS || 0) || 90000
  const watchdog = setTimeout(
    () => {
      console.log('[shot] watchdog fired')
      void w.webContents
        .capturePage()
        .then((img) => fs.writeFileSync(process.env.SHOT_PATH || path.join(APP_ROOT, 'screenshot-client.png'), img.toPNG()))
        .catch(() => undefined)
        // app.exit 不会触发 before-quit：这里必须手动收掉 Pixelle 后端子进程树，否则残留 python 占住管道
        .finally(() => {
          void stopPixelleBackend()
            .catch(() => undefined)
            .finally(() => app.exit(1))
        })
    },
    watchdogMs
  )
  await new Promise((r) => setTimeout(r, 3000))
  const view = process.env.SHOT_VIEW
  if (view && VIEW_INDEX[view] !== undefined) {
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX[view]}].click()`
    )
    await new Promise((r) => setTimeout(r, view === 'library' ? 90000 : 1500))
  }
  if (process.env.SHOT_GEN === '1') {
    const r = await w.webContents.executeJavaScript(
      `window.api.generate({
        prompt: '一只橘猫趴在旧书堆上打盹，温暖台灯光，水彩插画风格',
        model: 'wan2.7-image', provider: 'bailian', w: 1024, h: 1024
      }).then(x => 'OK:' + x.file).catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] generate:', r)
    check('generate', r)
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.history}].click()`
    )
    await new Promise((r) => setTimeout(r, 4000))
  }
  // 多素材融合冒烟：从案例库取两张图作为素材，走 generate 的多图链路并校验 sidecar 记录
  if (process.env.SHOT_FUSE === '1') {
    const fused = await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const a = await window.api.imageRead('media://local/lib-a/ad-creative_case174/output.jpg')
          const b = await window.api.imageRead('media://local/lib-a/ad-creative_case175/output.jpg')
          const ab = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)
          const x = await window.api.generate({
            prompt: '把图2的排版与配色风格用到图1的内容上，融合成一张广告海报',
            model: 'wan2.7-image', provider: 'bailian', w: 1024, h: 1024,
            refs: [
              { name: 'case174.jpg', data: ab(a), role: 'subject', source: 'library' },
              { name: 'case175.jpg', data: ab(b), role: 'style', source: 'library' }
            ]
          })
          return 'OK:' + x.file
        } catch (e) { return 'ERR:' + e.message }
      })()`
    )
    console.log('[shot] fuse:', fused)
    check('fuse', fused)
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.history}].click()`
    )
    await new Promise((r) => setTimeout(r, 3000))
  }
  // 复现冒烟：点历史最新一条的「复现」，验证多素材能从内容寻址留档还原创作者素材托盘
  if (process.env.SHOT_REPRO === '1') {
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.history}].click()`
    )
    await new Promise((r) => setTimeout(r, 2500))
    const clicked = await w.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.repro-btn'); if (!b) return 'ERR:no-repro-button'; b.click(); return 'clicked' })()`
    )
    await new Promise((r) => setTimeout(r, 3500))
    const tray = await w.webContents.executeJavaScript(`document.querySelectorAll('.ref-item').length`)
    console.log('[shot] repro:', clicked, 'tray items:', tray)
    check('repro', clicked === 'clicked' && Number(tray) > 0 ? `OK:${tray}个素材已还原` : 'ERR:素材托盘未还原')
  }
  // 组图冒烟：enable_sequential 一次多张，校验 files 数组与全部落盘
  if (process.env.SHOT_BATCH === '1') {
    const batched = await w.webContents.executeJavaScript(
      `window.api.generate({
        prompt: '水彩插画风，一只橘猫在窗台上打盹。第一张：清晨；第二张：黄昏',
        model: 'wan2.7-image', provider: 'bailian', w: 1024, h: 1024,
        n: 2, sequential: true
      }).then(x => 'OK:' + (x.files ? x.files.length : 1) + '张 ' + x.file).catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] batch:', batched)
    const n = Number(String(batched).match(/OK:(\d+)张/)?.[1] ?? 0)
    check('batch', n > 1 ? `OK:组图 ${n} 张` : `ERR:组图未返回多张 (${batched})`)
  }
  // 图像编辑冒烟：自动生成蒙版 → 局部重绘（走异步任务链路 + 版本链接续）
  if (process.env.SHOT_EDIT === '1') {
    const edited = await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const hist = await window.api.history()
          if (!hist || !hist.length) return 'ERR:no-history'
          const item = hist[0]
          const buf = await window.api.imageRead(item.url)
          const blob = new Blob([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)])
          const url = URL.createObjectURL(blob)
          const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url })
          const off = document.createElement('canvas')
          off.width = img.naturalWidth
          off.height = img.naturalHeight
          const ctx = off.getContext('2d')
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, off.width, off.height)
          ctx.fillStyle = '#fff'
          ctx.beginPath()
          ctx.arc(off.width * 0.5, off.height * 0.35, Math.min(off.width, off.height) * 0.18, 0, Math.PI * 2)
          ctx.fill()
          const mBlob = await new Promise((res) => off.toBlob((b) => res(b), 'image/png'))
          const mask = await mBlob.arrayBuffer()
          const r = await window.api.imageEdit({ op: 'repaint', name: item.name, mask, prompt: '在涂抹区域画一个白色的蝴蝶结', runId: 'edit-smoke' })
          return 'OK:' + r.file + ' parent=' + (r.parent || '-')
        } catch (e) { return 'ERR:' + e.message }
      })()`
    )
    console.log('[shot] edit:', edited)
    check('edit', String(edited).startsWith('OK:') ? edited : `ERR:图像编辑失败 ${edited}`)
  }
  // 风格库冒烟：校验内置数据条数，并打开抽屉确认渲染
  if (process.env.SHOT_STYLES === '1') {
    const count = await w.webContents.executeJavaScript(
      `window.api.styles().then(d => 'OK:' + (d.count || 0) + '条/' + (d.groups ? d.groups.length : 0) + '组').catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] styles data:', count)
    await w.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.style-lib-btn'); if (b) b.click(); return !!b })()`
    )
    await new Promise((r) => setTimeout(r, 1800))
    const cards = await w.webContents.executeJavaScript(`document.querySelectorAll('.style-card').length`)
    console.log('[shot] styles cards:', cards)
    const n = Number(String(count).match(/OK:(\d+)条/)?.[1] ?? 0)
    check('styles', n > 100 && Number(cards) > 0 ? `OK:${n}条 · 抽屉渲染${cards}张卡片` : `ERR:风格库未就绪 (${count} / cards=${cards})`)
  }
  // 更新冒烟：校验更新检查链路（无 Release 时应返回「还没有发布」而不是报错），并打开「关于」页截图
  if (process.env.SHOT_UPDATE === '1') {
    const u = await w.webContents.executeJavaScript(
      `window.api.updateCheck().then(r => 'OK:' + JSON.stringify({ ok: r.ok, current: r.current, hasUpdate: r.hasUpdate || false, latest: r.latest || '', out: r.out || '' })).catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] update:', u)
    check('update', String(u).startsWith('OK:') ? u : `ERR:更新检查失败 ${u}`)
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.settings}].click()`
    )
    await new Promise((r) => setTimeout(r, 1200))
    const clicked = await w.webContents.executeJavaScript(
      `(() => { const items=[...document.querySelectorAll('.sn-item')]; const about=items.find(i => /关于/.test(i.textContent || '')); if (about) about.click(); return !!about })()`
    )
    console.log('[shot] update about nav:', clicked)
    await new Promise((r) => setTimeout(r, 900))
  }
  // 更新下载冒烟（配合本地假更新源）：check → download，校验文件真的落盘且大小正确
  if (process.env.SHOT_UPDATE2 === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const info = await window.api.updateCheck()
          if (!info.ok) return 'ERR:check ' + (info.out || '')
          if (!info.hasUpdate) return 'ERR: 未识别到新版本 (' + info.current + ' vs ' + (info.latest || '-') + ')'
          const d = await window.api.updateDownload({ url: info.assetUrl, name: info.assetName, size: info.assetSize })
          return d.ok ? 'OK:' + info.latest + ' → ' + d.file : 'ERR:download ' + (d.out || '')
        } catch (e) { return 'ERR:' + e.message }
      })()`
    )
    console.log('[shot] update2:', r)
    check('update-download', String(r).startsWith('OK:') ? r : `ERR:下载链路失败 ${r}`)
  }
  // 本地反推冒烟：下载模型（首次）→ 本地出英文描述 → 文本模型改写中文
  if (process.env.SHOT_LOCAL === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const buf = await window.api.imageRead('media://local/lib-a/ad-creative_case174/output.jpg')
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
          const x = await window.api.distillLocal({ data: ab, name: 'case174.jpg', rewrite: true })
          return 'OK:' + String(x.prompt || '').slice(0, 80) + ' || raw=' + String(x.raw || '').slice(0, 60) + ' || rewritten=' + x.rewritten
        } catch (e) { return 'ERR:' + e.message }
      })()`
    )
    console.log('[shot] localDistill:', r)
    check('local-distill', String(r).startsWith('OK:') ? r : `ERR:本地反推失败 ${r}`)
  }
  if (process.env.SHOT_DISTILL === '1') {
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.library}].click()`
    )
    await new Promise((r) => setTimeout(r, 7000))
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const img = document.querySelector('.lib-card img')
        if (!img) return 'ERR: no lib image'
        const buf = await window.api.imageRead(img.src)
        document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.distill}].click()
        await new Promise(r => setTimeout(r, 800))
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        const x = await window.api.distill({ data: ab, name: 'case.png' })
        return 'OK:' + x.prompt.slice(0, 80)
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] distill:', r)
    check('distill', r)
    await new Promise((r2) => setTimeout(r2, 1000))
  }
  if (process.env.SHOT_PAL === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const out = {}
        try {
          out.items = document.querySelectorAll('.ant-menu-item').length
          const el = document.querySelectorAll('.ant-menu-item')[4]
          out.found = !!el
          el && el.click()
          await new Promise(r => setTimeout(r, 600))
          out.view = document.querySelector('.app-header .ant-typography')?.textContent || ''
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
          await new Promise(r => setTimeout(r, 1200))
          out.palOpen = !!document.querySelector('.pal')
        } catch (e) { out.err = e.message }
        return JSON.stringify(out)
      })()`
    )
    console.log('[shot] pal:', r)
    check('pal', r)
    await new Promise((r2) => setTimeout(r2, 800))
  }
  clearTimeout(watchdog)
  if (process.env.SHOT_AGENT === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const x = await window.api.agentRun({
          runId: 'shot-agent',
          goal: '画一张日系清新的街角咖啡店门面，然后提高整体对比度',
          model: 'wanx2.0-t2i-turbo'
        })
        const chain = x.last ? await window.api.imageChain(x.last.file) : []
        return 'OK:' + JSON.stringify({ steps: x.files.length, reply: x.reply.slice(0, 50), chain: chain.length })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] agent:', r)
    check('agent', r)
    await new Promise((r2) => setTimeout(r2, 500))
  }
  if (process.env.SHOT_COMPOSE === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const byText = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))
        byText('文字')?.click()
        await new Promise(r => setTimeout(r, 500))
        byText('导出 PNG')?.click()
        await new Promise(r => setTimeout(r, 1500))
        return 'clicked'
      })()`
    )
    console.log('[shot] compose:', r)
  }
  if (process.env.SHOT_CANVAS === '1') {
    // 画布工作台自测：点工具条新建三类节点，断言 DOM 中真的出现节点卡片
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button')].find(b => b.textContent.includes(t))
        const made = []
        for (const t of ['文本', '图片', '视频']) {
          const b = byText(t)
          if (!b) return 'ERR: toolbutton ' + t + ' not found'
          b.click()
          made.push(t)
          await new Promise(r => setTimeout(r, 400))
        }
        await new Promise(r => setTimeout(r, 800))
        const nodes = document.querySelectorAll('[data-node-id]').length
        const toolbar = document.querySelector('.ivc-toolbar') ? 1 : 0
        return nodes >= 3 ? 'OK:nodes=' + nodes + ',toolbar=' + toolbar + ',clicked=' + made.join('/') : 'ERR:nodes=' + nodes
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas:', r)
    check('canvas', r)
  }
  if (process.env.SHOT_CANVAS_GEN === '1') {
    // 画布出图节点端到端自测：新建出图节点 → 填提示词 → 点生成 → 等图片卡落画布
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button')].find(b => b.textContent.includes(t))
        const genBtn = byText('出图')
        if (!genBtn) return 'ERR: 工具条无出图按钮'
        genBtn.click()
        await sleep(600)
        const ta = document.querySelector('.ivc-gen-prompt')
        if (!ta) return 'ERR: 出图节点无提示词输入框'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '一只戴贝雷帽的柴犬，扁平插画风格，简洁背景')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(300)
        const run = [...document.querySelectorAll('.ivc-gen button')].find(b => b.textContent.includes('生成'))
        if (!run) return 'ERR: 无生成按钮'
        run.click()
        const t0 = Date.now()
        while (Date.now() - t0 < 70000) {
          await sleep(2000)
          const imgs = document.querySelectorAll('.ivc-img').length
          if (imgs > 0) return 'OK:canvas_images=' + imgs + ' in ' + Math.round((Date.now() - t0) / 1000) + 's'
          const err = document.querySelector('.ivc-gen-error')
          if (err) return 'ERR: ' + err.textContent.slice(0, 150)
        }
        return 'ERR: 70s 超时未出图'
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-gen:', r)
    check('canvas-gen', r)
  }
  if (process.env.SHOT_CANVAS_VIDEO === '1') {
    // 画布视频节点端到端自测：新建视频节点 → 填文案 → 生成成片 → 等视频卡（需 Pixelle 后端，耗时数分钟）
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button')].find(b => b.textContent.includes(t))
        const btn = byText('视频')
        if (!btn) return 'ERR: 工具条无视频按钮'
        btn.click()
        await sleep(700)
        const ta = document.querySelector('.ivc-gen-prompt')
        if (!ta) return 'ERR: 视频节点无文案输入框'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '秋日午后，一只戴贝雷帽的柴犬坐在窗边看落叶')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(300)
        const run = [...document.querySelectorAll('.ivc-gen button')].find(b => b.textContent.includes('生成成片'))
        if (!run) return 'ERR: 无生成成片按钮'
        run.click()
        const t0 = Date.now()
        while (Date.now() - t0 < 360000) {
          await sleep(5000)
          const vid = document.querySelectorAll('video.ivc-video').length
          if (vid > 0) return 'OK:canvas_videos=' + vid + ' in ' + Math.round((Date.now() - t0) / 1000) + 's'
          const err = document.querySelector('.ivc-gen-error')
          if (err) return 'ERR: ' + err.textContent.slice(0, 200)
        }
        return 'ERR: 360s 超时未出片'
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-video:', r)
    check('canvas-video', r)
  }
  if (process.env.SHOT_CANVAS_ASSETS === '1') {
    // 画布数据层自测（零成本）：直接读 IndexedDB，核对资产入库与血统边
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const openDb = () => new Promise((res, rej) => {
          const rq = indexedDB.open('miaodraw-canvas')
          rq.onsuccess = () => res(rq.result)
          rq.onerror = () => rej(rq.error)
        })
        try {
          const db = await openDb()
          const all = (store) => new Promise((res, rej) => {
            const tx = db.transaction(store, 'readonly')
            const rq = tx.objectStore(store).getAll()
            rq.onsuccess = () => res(rq.result)
            rq.onerror = () => rej(rq.error)
          })
          const assets = await all('assets')
          const deps = await all('asset_dependencies')
          const px = assets.filter(a => String(a.path || '').startsWith('pixelle/'))
          const meta = assets.filter(a => a.metadata && String(JSON.stringify(a.metadata)).includes('source'))
          return JSON.stringify({
            assets: assets.length,
            pixelle: px.length,
            lastPixelle: px.slice(-2).map(a => a.path),
            deps: deps.length,
            lastDeps: deps.slice(-2).map(d => ({ role: d.role, op: d.operation })),
            withMeta: meta.length
          })
        } catch (e) { return 'ERR:' + e.message }
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-assets:', r)
    check('canvas-assets', r)
  }
  if (process.env.SHOT_KEY === '1') {
    // 百炼密钥全链路自测：读取 → （已有则不动，避免覆盖真实密钥）→ 类型/掩码断言
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const out = {}
        try {
          const info = await window.api.bailianKeyGet()
          out.configured = info.configured
          out.plan = info.plan
          out.masked = info.configured ? info.masked.replace(/[^•]/g, '*') : ''
          const h = await window.api.health()
          out.hasKeyFlag = h.hasKey
        } catch (e) { out.err = e.message }
        return JSON.stringify(out)
      })()`
    )
    console.log('[shot] key:', r)
    check('key', r)
    await new Promise((r2) => setTimeout(r2, 500))
  }
  if (process.env.SHOT_SEG === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const h = await window.api.history()
        if (!h.length) return 'ERR: no history'
        const src = h[0].url
        const t0 = Date.now()
        const m = await window.api.segmentMask(src, [{ x: 512, y: 512 }])
        window.__segMask = m.maskUrl
        return 'OK:' + m.width + 'x' + m.height + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] seg:', r)
    check('seg', r)
    try {
      const maskUrl = await w.webContents.executeJavaScript(`window.__segMask`)
      if (maskUrl) fs.writeFileSync(path.join(APP_ROOT, 'seg-mask.png'), Buffer.from(maskUrl.split(',')[1], 'base64'))
    } catch {}
  }
  try {
    const img = await w.webContents.capturePage()
    const out = process.env.SHOT_PATH || path.join(APP_ROOT, 'screenshot-client.png')
    fs.writeFileSync(out, img.toPNG())
    console.log('[shot] saved:', out)
  } catch (e) {
    console.error('[shot] failed:', e)
    shotErrors++
  }
  // 有断言失败则以非零退出，让 CI / smoke 脚本能感知
  // 注意：app.exit 不触发 before-quit，需先手动收掉 Pixelle 后端子进程树
  await stopPixelleBackend().catch(() => undefined)
  app.exit(shotErrors > 0 ? 1 : 0)
}

// ---------- IPC ----------
/**
 * 融合素材留档：内容寻址写入 userData/refs/<sha1>.<ext>（同图天然去重）。
 * sidecar 只记 hash，历史「复现」不依赖原文件是否还在。
 */
async function archiveRefs(refs: RefImage[]): Promise<Array<{ order: number; role?: string; hash: string; name: string; source?: string }>> {
  const dir = path.join(app.getPath('userData'), 'refs')
  await fsp.mkdir(dir, { recursive: true })
  const out: Array<{ order: number; role?: string; hash: string; name: string; source?: string }> = []
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i]
    const buf = Buffer.from(r.data)
    const hash = createHash('sha1').update(buf).digest('hex')
    const ext = (path.extname(r.name) || '.png').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.png'
    const abs = path.join(dir, `${hash}${ext}`)
    if (!fs.existsSync(abs)) await fsp.writeFile(abs, buf)
    out.push({ order: i + 1, role: r.role, hash, name: r.name, source: r.source })
  }
  return out
}

function registerIpc(): void {
  // ---------- 画布资产（M1 数据层：outputs/refs 只读取样，供 assets 索引） ----------
  registerCanvasAssetHandlers(handle, {
    outputsPath: () => OUT_DIR,
    userDataPath: () => app.getPath('userData'),
    pixelleOutputPath: () => pixelleOutputDir()
  })

  // ---------- Pixelle 视频生产后端（M3：起停管理 + REST 代理） ----------
  registerPixelleHandlers(handle)

  /** 统一入口守卫：仅接受本应用窗口 webContents 的调用，其它来源一律拒绝 */
  function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      if (!win || e.sender.id !== win.webContents.id) {
        throw new Error('拒绝来源不明的 IPC 调用')
      }
      // 守卫通过后调用真实处理器（参数类型由各 handler 自行声明并校验）
      return (fn as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(e, ...args)
    })
  }
  // ---------- 引擎健康（HTTP 直连：密钥就绪 + 接入点可达，带缓存避免轮询打爆） ----------
  let probeCache: { at: number; ok: boolean } | null = null
  handle('health', async () => {
    const key = bailianApiKey()
    const origin = bailianOrigin()
    let ok = false
    if (key) {
      if (!probeCache || Date.now() - probeCache.at > (probeCache.ok ? 5 * 60 * 1000 : 60 * 1000)) {
        try {
          await httpModels(compatBase(origin), key, 8000)
          ok = true
        } catch {
          ok = false
        }
        probeCache = { at: Date.now(), ok }
      } else {
        ok = probeCache.ok
      }
    }
    let host = origin
    try {
      host = new URL(origin).host
    } catch {
      /* 保持原样 */
    }
    return {
      ok,
      version: host,
      entry: origin,
      bundled: false,
      hasKey: !!key,
      libraryReady: fs.existsSync(LIB_ROOT),
      outputsDir: OUT_DIR
    }
  })

  handle('library', () => {
    if (!libPromise) {
      libPromise = loadLibrary(LIB_ROOT, path.join(app.getPath('userData'), 'library-hash-cache.json'))
      // 失败后清空缓存允许重试，否则一次解析失败会让灵感库整个会话永久不可用
      libPromise.catch(() => {
        libPromise = null
      })
    }
    return libPromise
  })

  /** 内置风格/提示词库（library/styles.json，随包分发；由 scripts/build-styles.cjs 生成） */
  handle('styles', () => {
    if (!stylesPromise) {
      stylesPromise = fsp
        .readFile(path.join(LIB_ROOT, 'styles.json'), 'utf-8')
        .then((t) => JSON.parse(t.replace(/^\uFEFF/, '')) as unknown)
        .catch((e) => {
          stylesPromise = null
          log('warn', `styles.json 读取失败：${e instanceof Error ? e.message : String(e)}`)
          return { version: 1, groups: [], styles: [], count: 0 }
        })
    }
    return stylesPromise
  })

  handle('history', async () => {
    try {
      await fsp.mkdir(OUT_DIR, { recursive: true })
      const files = await fsp.readdir(OUT_DIR)
      const imgs = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      const stats = await Promise.all(
        imgs.map(async (f) => {
          const st = await fsp.stat(path.join(OUT_DIR, f))
          let params: unknown
          try {
            params = JSON.parse(await fsp.readFile(path.join(OUT_DIR, `${f}.json`), 'utf-8'))
          } catch {
            params = undefined
          }
          return {
            name: f,
            mtime: st.mtimeMs,
            size: st.size,
            url: `media://local/out/${encodeURIComponent(f)}`,
            params
          }
        })
      )
      stats.sort((a, b) => b.mtime - a.mtime)
      return stats.slice(0, 300)
    } catch {
      return []
    }
  })

  // 删除一条历史：仅限作品目录内的图片文件（含同名参数 sidecar），走统一校验
  handle('history:delete', async (_e, name: string) => {
    const abs = resolveOutputPath(name)
    if (!abs) throw new Error('文件名不合法')
    if (!fs.existsSync(abs)) return { ok: true } // 已不存在视为成功
    await fsp.unlink(abs)
    await fsp.rm(`${abs}.json`, { force: true })
    return { ok: true }
  })

  // 生成入参（渲染层 GenOpts 与 provider/runId 扩展）
  interface GenIpcOpts {
    prompt: string
    negative?: string
    w: number
    h: number
    seed?: number
    model: string
    provider?: string
    runId?: string
    parent?: string
    /** 单素材旧字段（等价 refs[0]） */
    ref?: { name: string; data: ArrayBuffer }
    /** 多素材融合：顺序即图1/图2/图3 */
    refs?: RefImage[]
    /** 出图张数（组图模式为最大张数） */
    n?: number
    /** 组图模式（wan2.7 enable_sequential） */
    sequential?: boolean
  }

  /** 归一化素材入参：ref（旧字段）与 refs 合并，并按模型能力截断 */
  function normalizeRefs(opts: GenIpcOpts): { refs: RefImage[]; dropped: number } {
    const list: RefImage[] = opts.refs?.length ? opts.refs : opts.ref ? [opts.ref] : []
    const { refs, dropped } = clampRefs(list, opts.model)
    return { refs, dropped }
  }

  handle('generate', async (_e, raw: GenIpcOpts) => {
    const opts = raw
    if (!opts || !opts.prompt || !opts.prompt.trim()) throw new Error('提示词不能为空')
    const provider = opts.provider || 'bailian'
    const onProgress = (stage: string, detail?: string): void => {
      win?.webContents.send('gen-progress', { runId: opts.runId, stage, detail })
    }
    const normalized = normalizeRefs(opts)
    const { refs } = normalized
    if (normalized.dropped > 0) {
      log('warn', `refs clamped: model=${opts.model} dropped=${normalized.dropped}`)
    }
    const sidecarRefs = refs.length ? await archiveRefs(refs) : []
    if (provider === 'bailian') {
      const key = bailianApiKey()
      if (!key) throw new Error('未配置百炼 API Key，请到「设置 → 模型服务」粘贴密钥并保存')
      const t0 = Date.now()
      onProgress('prepare', '参数就绪')
      // 种子恒定化：不传就随机一个并回传，保证每张图都可复现
      const usedSeed = opts.seed && opts.seed > 0 ? opts.seed : Math.floor(Math.random() * 2147483647)
      const cap = imageCapability(opts.model)
      // 出图张数：组图（wan2.7 enable_sequential）上限 12，普通模式 4，qwen-image 系 6
      const seq = !!opts.sequential && cap.protocol === 'dashscope-multimodal'
      const maxN = seq ? 12 : cap.protocol === 'dashscope-multimodal' ? 4 : 6
      const wantN = Math.min(Math.max(1, Math.round(opts.n || 1)), maxN)
      try {
        // 协议按模型能力分发：wan2.7 系走 DashScope 原生，qwen-image-3.x 走 OpenAI 兼容
        const r =
          cap.protocol === 'openai-images'
            ? await httpOpenAIImages({
                apiBase: compatBase(bailianOrigin()),
                apiKey: key,
                model: opts.model,
                prompt: opts.prompt,
                negative: opts.negative,
                refs,
                w: opts.w,
                h: opts.h,
                n: wantN,
                seed: usedSeed,
                runId: opts.runId,
                onProgress
              })
            : await httpBailianImage({
                origin: bailianOrigin(),
                apiKey: key,
                model: opts.model,
                prompt: opts.prompt,
                negative: opts.negative,
                w: opts.w,
                h: opts.h,
                seed: usedSeed,
                refs,
                n: wantN,
                sequential: seq,
                runId: opts.runId,
                onProgress
              })
        onProgress('save', '保存结果')
        const persisted: Array<{ file: string; url: string }> = []
        for (const buf of r.buffers) {
          persisted.push(
            await persistImage(buf, OUT_DIR, {
              prompt: opts.prompt,
              negative: opts.negative,
              w: opts.w,
              h: opts.h,
              seed: usedSeed,
              model: opts.model,
              provider: 'bailian',
              parent: opts.parent,
              refs: sidecarRefs
            })
          )
        }
        const first = persisted[0]
        log('info', `generate done files=${persisted.length} refs=${refs.length} seq=${seq} in ${Date.now() - t0}ms`)
        return {
          file: first.file,
          url: first.url,
          elapsed: Date.now() - t0,
          seed: usedSeed,
          model: opts.model,
          parent: opts.parent,
          files: persisted.length > 1 ? persisted : undefined
        }
      } catch (e) {
        log('error', `generate failed: ${e instanceof Error ? e.message : String(e)}`)
        throw e
      }
    }
    // HTTP 多服务商：OpenAI 兼容（内置模板 + 自定义供应商），目前仅文生图
    if (refs.length) throw new Error('当前服务商暂不支持素材融合，请切换回百炼模型使用')
    const apiKey = getProviderKey(provider)
    if (!apiKey) {
      const label = provider === 'siliconflow' ? '硅基流动' : provider === 'openai' ? 'OpenAI' : provider
      throw new Error(`未配置 ${label} 的 API Key，请到「设置 → 模型服务」填写`)
    }
    const mc = getModelConfig()
    const custom = mc.customProviders?.find((c) => c.id === provider)
    if (!custom && provider !== 'siliconflow' && provider !== 'openai') throw new Error(`未知服务商：${provider}`)
    if (custom && !custom.enabled) throw new Error(`供应商 ${custom.name} 已停用`)
    const t0 = Date.now()
    const r = await httpGenerate({
      provider,
      apiBase: custom?.baseUrl,
      apiKey,
      prompt: opts.prompt,
      negative: opts.negative,
      w: opts.w,
      h: opts.h,
      seed: opts.seed,
      model: opts.model,
      outputsDir: OUT_DIR
    })
    await fsp.writeFile(
      path.join(OUT_DIR, `${r.file}.json`),
      JSON.stringify(
        { prompt: opts.prompt, negative: opts.negative || undefined, w: opts.w, h: opts.h, seed: r.seed, model: opts.model, provider, createdAt: new Date().toISOString() },
        null,
        2
      )
    )
    return {
      file: r.file,
      url: `media://local/out/${encodeURIComponent(r.file)}`,
      elapsed: Date.now() - t0,
      seed: r.seed,
      model: opts.model
    }
  })

  handle('gen:cancel', (_e, runId: string) => ({ ok: cancelHttp(String(runId || '')) }))

  /** 连通检查（Cherry Studio 式）：拉一次 /models，免费且即时 */
  handle('test:provider', async (_e, provider: string) => {
    const conn = connFor(String(provider || ''), '')
    if (!conn.apiKey) return { ok: false, out: '请先填写 API Key 并保存' }
    if (conn.kind === 'openai' && !conn.apiBase) return { ok: false, out: '该供应商缺少 API 地址' }
    try {
      const ids = await httpModels(conn.kind === 'bailian' ? compatBase(conn.origin || DASHSCOPE_ORIGIN) : conn.apiBase!, conn.apiKey, 15000)
      return { ok: true, out: `连接成功 · 服务端返回 ${ids.length} 个模型` }
    } catch (e) {
      return { ok: false, out: e instanceof Error ? e.message : String(e) }
    }
  })

  /** 自动发现模型目录：/models → 去噪后入库到 modelConfig.fetchedModels */
  handle('models:fetch', async (_e, provider: string) => {
    const conn = connFor(String(provider || ''), '')
    if (!conn.apiKey) return { ok: false as const, out: '请先填写该供应商的 API Key' }
    if (conn.kind === 'openai' && !conn.apiBase) return { ok: false as const, out: '该供应商缺少 API 地址' }
    try {
      const all = await httpModels(conn.kind === 'bailian' ? compatBase(conn.origin || DASHSCOPE_ORIGIN) : conn.apiBase!, conn.apiKey, 20000)
      const models = all.filter((id) => !MODEL_NOISE_RE.test(id))
      const mc = getModelConfig()
      const next: ModelConfig = { ...mc, fetchedModels: { ...mc.fetchedModels, [provider]: models } }
      writeSettings({ modelConfig: next })
      return { ok: true as const, total: all.length, models: models.length }
    } catch (e) {
      return { ok: false as const, out: e instanceof Error ? e.message : String(e) }
    }
  })

  const DISTILL_PROMPT = [
    '你是文生图提示词反推专家。从这张图反推一段可直接喂给任意文生图产品（Midjourney/即梦/SD等）的提示词：',
    '一个完整段落（80~150词），覆盖主体内容、风格媒介、构图视角、光线、色调、质感与画质关键词；',
    '图中若有文字，原样描述内容与位置。可在末尾附一行适合该图的风格参数或 negative prompt。',
    '只输出提示词本身，不要任何解释，不要用"图中""这是"等措辞，直接描述画面。'
  ].join('')

  handle('distill', async (_e, payload: { data: ArrayBuffer; name: string }) => {
    if (!payload?.data) throw new Error('没收到图片')
    const t0 = Date.now()
    const def = resolveDefault('vision', { provider: 'bailian', model: 'qwen3-vl-plus' })
    const conn = connFor(def.provider, def.model)
    if (!conn.apiKey) throw new Error('未配置模型密钥，请到「设置 → 模型服务」填写')
    const prompt = await httpChat({
      apiBase: conn.kind === 'bailian' ? compatBase(conn.origin || DASHSCOPE_ORIGIN) : conn.apiBase || '',
      apiKey: conn.apiKey,
      model: conn.model,
      message: DISTILL_PROMPT,
      images: [{ name: payload.name || 'image.png', data: payload.data }],
      temperature: 0.3,
      timeoutMs: 180000,
      runId: 'distill-' + t0,
      disableThinking: conn.kind === 'bailian'
    })
    return { prompt, elapsed: Date.now() - t0 }
  })

  // ---------- 通用模型配置 ----------
  handle('model-config:get', () => getModelConfig())
  handle('model-config:set', (_e, cfg: ModelConfig) => {
    writeSettings({ modelConfig: cfg ?? {} })
    return getModelConfig()
  })

  handle('settings:get', () => {
    const s = readSettings()
    // 密文字段与旧明文字段绝不回显到渲染进程；服务商密钥只给掩码状态
    const { bailianKeyEnc: _a, bailianKeyPlain: _b, providerKeysEnc: _c, providers: _d, ...pub } = s
    return { ...pub, providerKeys: providerKeysInfo() }
  })
  handle('settings:set', (_e, patch: Settings) => {
    if (
      patch &&
      ('bailianKeyEnc' in patch ||
        'bailianKeyPlain' in patch ||
        'providerKeysEnc' in patch ||
        'providers' in patch ||
        'providerKeys' in patch)
    ) {
      throw new Error('密钥字段请使用 bailian-key:set / provider-key:set 接口')
    }
    return writeSettings(patch)
  })

  // ---------- 第三方服务商密钥管理 ----------
  handle('bailian-ws:set', (_e, payload: { ws?: string; baseUrl?: string }) => {
    const ws = String(payload?.ws || '').trim()
    const baseUrl = String(payload?.baseUrl || '').trim()
    const patch: Settings = {}
    if (ws) patch.bailianWorkspace = ws
    if (baseUrl) patch.bailianBaseUrl = baseUrl
    writeSettings(patch) // HTTP 直连每次实时读设置，保存即热生效
    return { ok: true as const }
  })
  handle('provider-key:get', () => providerKeysInfo())
  handle('provider-key:set', (_e, provider: string, key: string) => {
    if (!isProviderId(provider)) return { ok: false as const, err: '未知服务商' }
    const plain = String(key || '').trim()
    if (!plain) return { ok: false as const, err: '密钥不能为空' }
    if (/\s/.test(plain)) return { ok: false as const, err: '密钥中间包含空格或换行，请重新完整复制粘贴' }
    const next = { ...readSettings().providerKeysEnc }
    const { enc, plainFallback } = encryptSecret(plain)
    next[provider] = { enc, plainFallback }
    writeSettings({ providerKeysEnc: next })
    return { ok: true as const, info: providerKeysInfo(), plainFallback }
  })
  handle('provider-key:clear', (_e, provider: string) => {
    const id = String(provider || '').trim()
    if (!id) return { ok: false as const, err: '服务商不能为空' }
    const next = { ...readSettings().providerKeysEnc }
    delete next[id]
    writeSettings({ providerKeysEnc: next })
    return { ok: true as const, info: providerKeysInfo() }
  })

  // ---------- 百炼密钥管理 ----------
  handle('bailian-key:get', () => bailianKeyInfo())
  handle('bailian-key:set', (_e, key: string) => {
    const plain = String(key || '').trim()
    if (!plain) return { ok: false as const, err: '密钥不能为空' }
    if (/\s/.test(plain)) {
      return { ok: false as const, err: '密钥中间包含空格或换行，请重新完整复制粘贴' }
    }
    // 不强制前缀：sk- / sk-ws- / sk-sp- 均可，有效性交给「测试连通」验证
    const next = { ...readSettings().providerKeysEnc }
    next['bailian'] = encryptSecret(plain)
    writeSettings({ providerKeysEnc: next, bailianKeyEnc: undefined, bailianKeyPlain: undefined })
    return { ok: true as const, info: bailianKeyInfo(), plainFallback: next['bailian'].plainFallback }
  })
  handle('bailian-key:clear', () => {
    const next = { ...readSettings().providerKeysEnc }
    delete next['bailian']
    writeSettings({ providerKeysEnc: next, bailianKeyEnc: undefined, bailianKeyPlain: undefined })
    return bailianKeyInfo()
  })
  handle('bailian-key:test', async () => {
    const key = bailianApiKey()
    if (!key) return { ok: false, out: '尚未配置百炼密钥，请先填写并保存' }
    try {
      const t0 = Date.now()
      const textModel = resolveDefault('text', { provider: 'bailian', model: 'qwen3.8-flash' }).model
      const out = await httpChat({
        apiBase: compatBase(bailianOrigin()),
        apiKey: key,
        model: textModel,
        message: '只回复两个字：成功',
        temperature: 0.1,
        timeoutMs: 30000,
        disableThinking: true
      })
      return { ok: true, out: `密钥可用（${Date.now() - t0}ms）· ${textModel} 响应：${out.slice(0, 60)}` }
    } catch (e) {
      return { ok: false, out: e instanceof Error ? e.message : String(e) }
    }
  })

  // ---------- 本地反推（离线；本地小模型出英文描述，再用文本模型改写成中文提示词） ----------
  handle('distill:local', async (_e, payload: { data: ArrayBuffer; name?: string; rewrite?: boolean }) => {
    if (!payload?.data) throw new Error('没收到图片')
    const onProgress = (p: CaptionProgress): void => win?.webContents.send('local-caption-progress', p)
    const r = await localCaption(payload.data, payload.name || 'image.png', onProgress)
    let prompt = r.text
    let rewritten = false
    if (payload.rewrite !== false) {
      const def = resolveDefault('text', { provider: 'bailian', model: 'qwen3.8-flash' })
      const conn = connFor(def.provider, def.model)
      if (conn.apiKey) {
        try {
          const zh = await httpChat({
            apiBase: conn.kind === 'bailian' ? compatBase(conn.origin || DASHSCOPE_ORIGIN) : conn.apiBase || '',
            apiKey: conn.apiKey,
            model: conn.model,
            system:
              '你是文生图提示词专家。把给定的英文画面描述改写成一段可直接用于文生图的中文提示词（80~150 字），' +
              '覆盖主体内容、风格媒介、构图视角、光线、色调与质感；只输出提示词本身，不要解释。',
            message: r.text,
            temperature: 0.5,
            timeoutMs: 60000,
            disableThinking: conn.kind === 'bailian'
          })
          if (zh.trim()) {
            prompt = zh.trim()
            rewritten = true
          }
        } catch (e) {
          log('warn', `local distill rewrite failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    return { prompt, raw: r.text, model: r.model, elapsed: r.elapsed, rewritten }
  })
  handle('distill:local-prefetch', async () =>
    prefetchCaptionModel((p) => win?.webContents.send('local-caption-progress', p))
  )
  handle('caption:model', () => ({ model: captionModelId() }))

  handle('favorites:list', () => readFavorites().sort((a, b) => b.savedAt - a.savedAt))
  handle('favorites:toggle', (_e, item: Omit<FavItem, 'savedAt'>) => {
    const list = readFavorites()
    const idx = list.findIndex((f) => f.key === item.key)
    if (idx >= 0) list.splice(idx, 1)
    else list.push({ ...item, savedAt: Date.now() })
    writeFavorites(list)
    return list.sort((a, b) => b.savedAt - a.savedAt)
  })

  handle('agent:run', async (_e, payload: { runId: string; goal: string; baseName?: string; model?: string; provider?: string; refs?: RefImage[] }) => {
    if (!payload?.goal?.trim()) throw new Error('请输入指令')
    if (payload.baseName && !resolveOutputPath(payload.baseName)) throw new Error('底图文件不合法')
    // 模型默认值来自通用配置：文本模型驱动 Agent 规划，生图默认驱动出图步骤
    const textDef = resolveDefault('text', { provider: 'bailian', model: 'qwen3.8-flash' })
    const imageDef = resolveDefault('image', { provider: 'bailian', model: 'wan2.7-image' })
    const imageConn = connFor(payload.provider || imageDef.provider, payload.model || imageDef.model)
    if (!imageConn.apiKey) throw new Error('未配置生图模型密钥，请到「设置 → 模型服务」填写')
    // 创作页素材托盘：Agent 可用 images 参数按序号引用（1-based 即"图1/图2"）
    const materialPool = (payload.refs ?? []).slice(0, imageCapability(imageConn.model).maxRefs)
    return runAgent({
      runId: payload.runId,
      goal: payload.goal.trim(),
      baseImage: payload.baseName,
      textConn: connFor(textDef.provider, textDef.model),
      imageConn,
      materialPool,
      outputsDir: OUT_DIR,
      onEvent: (e: unknown) => win?.webContents.send('agent-progress', e)
    })
  })

  // ---------- 图像编辑（wanx2.1-imageedit 系列：局部重绘/擦除/去水印/超分/扩图/上色/线稿） ----------
  type ImageEditOp = 'repaint' | 'erase' | 'dewatermark' | 'upscale' | 'expand' | 'colorize' | 'doodle'
  const EDIT_FN: Record<Exclude<ImageEditOp, 'erase'>, WanxEditFn> = {
    repaint: 'description_edit_with_mask',
    dewatermark: 'remove_watermark',
    upscale: 'super_resolution',
    expand: 'expand',
    colorize: 'colorization',
    doodle: 'doodle'
  }
  const EDIT_DEFAULT_PROMPT: Record<ImageEditOp, string> = {
    repaint: '在该区域生成与周围自然协调的内容',
    erase: '',
    dewatermark: '去除画面中的文字水印，保持背景自然、无残留痕迹',
    upscale: '保持画面内容不变，提升清晰度与细节',
    expand: '自然延展画面内容，保持原有风格、光线与透视一致',
    colorize: '为画面自然上色，色彩协调真实',
    doodle: '根据线稿生成完整的画面内容，保持线条结构'
  }
  const EDIT_LABEL: Record<ImageEditOp, string> = {
    repaint: '局部重绘',
    erase: '擦除物体',
    dewatermark: '去水印',
    upscale: '超分放大',
    expand: '扩图',
    colorize: '上色',
    doodle: '线稿生图'
  }

  /** 从 PNG 字节读宽高（sidecar 记录用；非 PNG 返回 0） */
  function pngSize(buf: Buffer): { w: number; h: number } {
    if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    }
    return { w: 0, h: 0 }
  }

  handle(
    'image:edit',
    async (
      _e,
      payload: {
        op: ImageEditOp
        name?: string
        data?: ArrayBuffer
        mask?: ArrayBuffer
        prompt?: string
        factor?: number
        scales?: { top?: number; bottom?: number; left?: number; right?: number }
        runId?: string
      }
    ) => {
      const op = payload?.op
      if (!op || !(op in EDIT_LABEL)) throw new Error('未知的图像编辑操作')
      const needsMask = op === 'repaint' || op === 'erase'
      const key = bailianApiKey()
      if (!key) throw new Error('未配置百炼 API Key，请到「设置 → 模型服务」粘贴密钥并保存')
      // 源图：优先直接用字节；否则按作品目录文件名读取（走统一校验）
      let srcBuf: Buffer
      let srcName: string
      if (payload.data) {
        srcBuf = Buffer.from(payload.data)
        srcName = payload.name || 'source.png'
      } else {
        const abs = resolveOutputPath(String(payload.name || ''))
        if (!abs || !fs.existsSync(abs)) throw new Error('源图不存在或文件名不合法')
        srcBuf = await fsp.readFile(abs)
        srcName = path.basename(abs)
      }
      if (needsMask && !payload.mask) throw new Error('请先在图上涂抹要处理的区域')
      const maskRef = payload.mask ? { name: 'mask.png', data: payload.mask } : undefined
      const origin = bailianOrigin()
      const prompt = payload.prompt?.trim() || EDIT_DEFAULT_PROMPT[op]
      const model = op === 'erase' ? 'image-erase-completion' : 'wanx2.1-imageedit'
      const onProgress = (stage: string, detail?: string): void => {
        win?.webContents.send('gen-progress', { runId: payload.runId, stage, detail })
      }
      const t0 = Date.now()
      onProgress('prepare', `${EDIT_LABEL[op]}：准备中`)
      try {
        const r =
          op === 'erase'
            ? await httpEraseCompletion({
                origin,
                apiKey: key,
                image: { name: srcName, data: new Uint8Array(srcBuf).buffer as ArrayBuffer },
                mask: maskRef!,
                runId: payload.runId,
                onProgress
              })
            : await httpWanxEdit({
                origin,
                apiKey: key,
                fn: EDIT_FN[op],
                image: { name: srcName, data: new Uint8Array(srcBuf).buffer as ArrayBuffer },
                mask: maskRef,
                prompt,
                upscaleFactor: payload.factor,
                expandScales: payload.scales,
                runId: payload.runId,
                onProgress
              })
        const size = pngSize(r.buffer)
        const { file, url } = await persistImage(r.buffer, OUT_DIR, {
          prompt,
          w: size.w,
          h: size.h,
          seed: 0,
          model,
          provider: 'bailian',
          parent: payload.name
        })
        log('info', `image:edit done op=${op} file=${file} in ${Date.now() - t0}ms`)
        return { file, url, elapsed: Date.now() - t0, seed: 0, model, parent: payload.name, op }
      } catch (e) {
        log('error', `image:edit failed op=${op}: ${e instanceof Error ? e.message : String(e)}`)
        throw e
      }
    }
  )

  handle('image:chain', async (_e, name: string) => {
    const chain: Array<{ name: string; url: string }> = []
    let cur = name
    for (let i = 0; i < 20; i++) {
      if (!resolveOutputPath(cur)) break
      const abs = path.join(OUT_DIR, cur)
      if (!fs.existsSync(abs)) break
      chain.unshift({ name: cur, url: `media://local/out/${encodeURIComponent(cur)}` })
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(OUT_DIR, `${cur}.json`), 'utf-8')) as {
          parent?: string
        }
        if (!meta.parent || meta.parent === cur) break
        cur = meta.parent
      } catch {
        break
      }
    }
    return chain
  })

  handle('segment:mask', async (_e, src: string, points: Array<{ x: number; y: number }>) => {
    if (!points?.length) throw new Error('请先在图上点击至少一个点')
    return segmentService.mask(src, points)
  })

  handle('compose:save', async (_e, payload: { dataUrl: string; width: number; height: number }) => {
    if (!payload?.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('导出数据无效')
    await fsp.mkdir(OUT_DIR, { recursive: true })
    const name = `compose_${Date.now()}.png`
    const b64 = payload.dataUrl.slice('data:image/png;base64,'.length)
    await fsp.writeFile(path.join(OUT_DIR, name), Buffer.from(b64, 'base64'))
    await fsp.writeFile(
      path.join(OUT_DIR, `${name}.json`),
      JSON.stringify(
        { kind: 'compose', w: payload.width, h: payload.height, createdAt: new Date().toISOString() },
        null,
        2
      )
    )
    return { name, url: `media://local/out/${encodeURIComponent(name)}` }
  })

  handle('open:path', (_e, kind: string) => {
    const p =
      kind === 'outputs'
        ? OUT_DIR
        : kind === 'library'
          ? LIB_ROOT
          : kind === 'userData'
            ? app.getPath('userData')
            : null
    if (!p || !fs.existsSync(p)) return { ok: false }
    void shell.openPath(p)
    return { ok: true }
  })

  // ---------- 应用内更新（自研，见 updater.ts 的说明） ----------
  handle('update:check', () => checkUpdate(readSettings().updateFeed))
  handle('update:download', async (_e, payload: { url: string; name: string; size?: number }) => {
    if (!payload?.url) throw new Error('缺少下载地址')
    return downloadUpdate(payload.url, payload.name, (p) => win?.webContents.send('update-progress', p), payload.size)
  })
  handle('update:cancel', () => ({ ok: cancelUpdateDownload() }))
  handle('update:install', async (_e, file: string) => {
    // 只允许安装 userData/updates 下、由本应用下载的 .exe，杜绝渲染层传入任意路径
    const abs = path.resolve(String(file || ''))
    const dir = path.resolve(app.getPath('userData'), 'updates')
    if (!abs.startsWith(dir + path.sep) || !/\.exe$/i.test(abs)) throw new Error('安装包路径不合法')
    return installUpdate(abs)
  })

  handle('app:info', () => ({
    version: app.getVersion(),
    name: '妙绘工作台',
    libraryRoot: LIB_ROOT,
    outputsDir: OUT_DIR
  }))

  handle('image:read', (_e, url: string) => {
    const abs = parseMediaUrl(url)
    if (!abs) throw new Error('找不到文件')
    return fsp.readFile(abs)
  })

  /** 读取素材留档（内容寻址 userData/refs/<sha1><ext>）：历史「复现」还原素材托盘 */
  handle('refs:read', (_e, hash: string, ext: string) => {
    const h = String(hash || '').toLowerCase()
    const x = String(ext || '').toLowerCase()
    if (!/^[a-f0-9]{40}$/.test(h)) throw new Error('素材标识不合法')
    if (!/^\.[a-z0-9]{2,5}$/.test(x) || !REF_EXTS.has(x)) throw new Error('素材格式不合法')
    const abs = path.join(app.getPath('userData'), 'refs', `${h}${x}`)
    if (!fs.existsSync(abs)) throw new Error('素材留档已不在本机（可能被清理）')
    return fsp.readFile(abs)
  })

  handle('image:save', async (_e, url: string) => {
    const abs = parseMediaUrl(url)
    if (!abs) return { ok: false, err: '找不到源文件' }
    const ext = path.extname(abs) || '.png'
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: `妙绘_${Date.now()}${ext}`,
      filters: [{ name: '图片', extensions: [ext.replace('.', '')] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, err: '已取消' }
    await fsp.copyFile(abs, r.filePath)
    return { ok: true, path: r.filePath }
  })

  handle('image:reveal', (_e, url: string) => {
    const abs = parseMediaUrl(url)
    if (abs) shell.showItemInFolder(abs)
    return { ok: !!abs }
  })
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  initLogger(path.join(app.getPath('userData'), 'logs'))
  log('info', `app ready version=${app.getVersion()} packaged=${isPackaged} engine=http-direct`)
  migrateLegacyProviderKeys()
  protocol.handle('media', async (req) => {
    const abs = parseMediaUrl(req.url)
    if (!abs) return new Response('not found', { status: 404 })
    // ?w=64..2048：列表/封面缩略图按需降采样（nativeImage 缩放 + 小容量缓存），避免整屏原图解码
    let w = 0
    try {
      w = Number(new URL(req.url).searchParams.get('w')) || 0
    } catch {
      w = 0
    }
    if (w >= 64 && w <= 2048) {
      const buf = await thumbnail(abs, w)
      if (buf) return new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/png' } })
    }
    return net.fetch(pathToFileURL(abs).toString())
  })

  // 清扫崩溃残留的私有生成目录（.gen-*，超过 1 天的）
  void fsp
    .readdir(OUT_DIR)
    .then((names) => {
      for (const n of names) {
        if (!n.startsWith('.gen-')) continue
        const p = path.join(OUT_DIR, n)
        void fsp
          .stat(p)
          .then((st) => {
            if (Date.now() - st.mtimeMs > 86400000) void fsp.rm(p, { recursive: true, force: true }).catch(() => {})
          })
          .catch(() => {})
      }
    })
    .catch(() => {})

  registerIpc()
  createWindow()

  if (process.env.TEST_MODE === 'screenshot' && win) {
    void screenshotMode(win)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

// 退出前中断所有在途 HTTP 生成请求，避免后台继续消耗额度
app.on('before-quit', () => {
  cancelAllHttp()
})
