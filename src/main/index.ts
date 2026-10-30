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
import { generateVideoJob } from './bailianVideo'
import { estimateVideoCost, normalizeVideoSpec, type VideoSpecInput } from './video-protocol'

import { registerOrchestratorHandlers } from './orchestrator'
import { registerVideoHandlers } from './video'
import { checkImageBudget, estimateImageBatch } from './image-cost'

// ---------- 路径 ----------
const APP_ROOT = app.getAppPath()
const isPackaged = app.isPackaged
const LIB_ROOT = libraryRoot(isPackaged, APP_ROOT, process.resourcesPath)
const OUT_DIR = isPackaged ? path.join(app.getPath('userData'), 'outputs') : path.join(APP_ROOT, 'outputs')
/** 视频产物目录（V1 直连百炼出片；与 outputs 图片分开，避免历史记录扫描混入大文件） */
const VIDEO_DIR = isPackaged ? path.join(app.getPath('userData'), 'videos') : path.join(APP_ROOT, 'videos')
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
  if (bucket === 'vid') return VIDEO_DIR
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
  /** 视频管线累计预算（元，V1 成本护栏硬上限）；未设置时默认 ¥20 */
  videoBudget?: number
  /** 图片/改图/Agent 累计预算（元，P0 成本护栏）；未设置时默认 ¥20 */
  imageBudget?: number
  /** 已花费（元，主进程持久化，重启不清零）——供预算判定与自己核对账单 */
  imageSpentCny?: number
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
  // 原子写：先写临时文件再 rename。直接覆盖时若进程在写一半被杀，
  // 下次 readSettings 解析失败会返回 {}，用户全部配置（含密钥）被清空。
  const target = SETTINGS_FILE()
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, target)
  return next
}
/**
 * 设置对外投影：密文字段与旧明文字段绝不回显到渲染进程；服务商密钥只给掩码状态。
 * get 与 set 必须共用本函数——历史上 set 直接回传 writeSettings 的结果，
 * 把 bailianKeyEnc/providerKeysEnc 送回了渲染层（plainFallback 平台即 base64 明文）。
 */
function publicSettings(): Record<string, unknown> & { providerKeys: Record<string, { configured: boolean; masked: string; plainFallback: boolean }> } {
  const s = readSettings()
  const { bailianKeyEnc: _a, bailianKeyPlain: _b, providerKeysEnc: _c, providers: _d, ...pub } = s
  return { ...pub, providerKeys: providerKeysInfo() }
}

/** 图片链路预算（元）：settings.imageBudget，默认 ¥20（与视频预算同口径） */
function imageBudgetCny(): number {
  const v = Number(readSettings().imageBudget)
  return Number.isFinite(v) && v > 0 ? v : 20
}
/** 已花费（元）：持久化在 settings 里，重启不清零（视频账本是纯内存，这里刻意做得更严） */
function imageSpentCny(): number {
  const v = Number(readSettings().imageSpentCny)
  return Number.isFinite(v) && v >= 0 ? v : 0
}
/**
 * 付费出图前置闸门（fail-closed）：超预算直接抛错，调用方不会走到任何付费请求。
 * 图片链路没有视频那样的确认凭证，预算就是唯一的硬闸。
 */
function assertImageBudget(model: string, count: number): { cny: number; count: number } {
  const gate = checkImageBudget({ model, count, spentCny: imageSpentCny(), budgetCny: imageBudgetCny() })
  if (!gate.ok) {
    log('warn', `image budget gate: ${gate.code} ${gate.reason}`)
    throw new Error(gate.reason)
  }
  return { cny: gate.estimate.cny, count: gate.estimate.count }
}
/** 成功后记账（按实际张数；写 setting 是唯一持久化点） */
function recordImageSpend(model: string, count: number): void {
  const cny = estimateImageBatch(model, count).cny
  if (!(cny > 0)) return
  writeSettings({ imageSpentCny: Math.round((imageSpentCny() + cny) * 100) / 100 })
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
/**
 * 可存密钥的服务商 = 内置三家 + 用户自定义供应商。
 * 之前只认内置 id，导致设置页里自定义供应商（custom-<ts>）保存密钥永远失败，
 * 而 http.ts 的 doubao / gpt-image 分支又依赖这些密钥 → 该能力实际不可达。
 */
function isKnownProvider(v: string): boolean {
  if (isProviderId(v)) return true
  return (getModelConfig().customProviders ?? []).some((c) => c.id === v)
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
  // ---------- 画布资产（M1 数据层：outputs/refs/videos 只读取样，供 assets 索引） ----------
  registerCanvasAssetHandlers(handle, {
    outputsPath: () => OUT_DIR,
    userDataPath: () => app.getPath('userData'),
    videosPath: () => VIDEO_DIR,
    // 历史遗留：早期 pixelle/ 资产仍要能读（只读路径，不再 spawn 任何后端）
    pixelleOutputPath: () => process.env.PIXELLE_OUTPUT_DIR || path.join('D:\\project\\Pixelle-Video', 'output')
  })

  // ---------- 视频生成（V1：直连百炼，异步任务 + 进度回推，零 Pixelle 依赖） ----------
  handle('video:generate', async (_e, raw: { spec?: VideoSpecInput; runId?: string }) => {
    const spec = normalizeVideoSpec(raw?.spec ?? {})
    if (!spec.prompt) throw new Error('提示词不能为空')
    // 成本硬上限（fail-closed）：超过就直接拒绝，不给「再点一次就过」的机会
    const cost = estimateVideoCost(spec)
    if (cost.overCap) throw new Error(`预估价 ¥${cost.cny.toFixed(2)} 超过单次上限 ¥6.00，请先降到更短时长/更低分辨率`)
    const key = bailianApiKey()
    if (!key) throw new Error('未配置百炼 API Key，请到「设置 → 模型服务」粘贴密钥并保存')
    const result = await generateVideoJob({
      spec,
      origin: bailianOrigin(),
      apiKey: key,
      outDir: VIDEO_DIR,
      onProgress: (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('video-progress', { runId: raw?.runId, ...p })
      }
    })
    log('info', `video done file=${result.file} size=${result.sizeBytes} model=${result.model} ${result.durationSec}s in ${result.elapsed}ms est=¥${result.estimatedCny}`)
    return result
  })

  // 探针专用（仅截图模式）：造一个零成本的 stub 成片结果，用来端到端验证落卡/入库/血统边
  if (process.env.TEST_MODE === 'screenshot') {
    handle('video:debugStub', async () => {
      const file = 'probe_stub.mp4'
      await fsp.mkdir(VIDEO_DIR, { recursive: true })
      await fsp.writeFile(path.join(VIDEO_DIR, file), Buffer.alloc(2048, 7))
      return {
        file,
        relPath: `videos/${file}`,
        url: `media://local/vid/${file}`,
        taskId: 'probe-stub',
        model: 'wan2.7-t2v',
        resolution: '720P',
        ratio: '16:9',
        durationSec: 2,
        sizeBytes: 2048,
        estimatedCny: 1.2,
        elapsed: 0
      }
    })
  }

  // ---------- 编排（O1：计划/阶段 IPC + plan:changed 事件） ----------
  const orch = registerOrchestratorHandlers(handle, (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  })

  // ---------- 视频管线（V1：video_jobs 幂等 + 成本护栏 fail-closed；script/tts/shots/compose 逐期接入） ----------
  registerVideoHandlers(
    handle,
    (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    },
    {
      budgetCny: () => {
        const v = Number(readSettings().videoBudget)
        return Number.isFinite(v) && v > 0 ? v : 20
      },
      // 记账留痕：每次付费/关键步骤进 plan_events（actor=auto，含金额与 request_id）
      audit: (e) =>
        orch.registry.recordAudit({
          plan_id: e.plan_id,
          event: e.event ?? 'video_paid',
          actor: 'auto',
          stage_id: e.stage_id,
          request_id: e.request_id ?? null,
          detail: `${e.detail ?? '视频作业'}${typeof e.cny === 'number' ? `：¥${e.cny}` : ''}${e.job_id ? `（job=${e.job_id}）` : ''}`
        }),
      // V1 executor 的目录与凭证（模块本身不读 electron）
      paths: {
        imageDir: () => OUT_DIR,
        videoDir: () => VIDEO_DIR,
        tmpDir: () => path.join(app.getPath('userData'), 'tmp')
      },
      bailian: { origin: () => bailianOrigin(), apiKey: () => bailianApiKey() },
      // 编排状态机 <-> 视频管线接线：视频模块不直接 import orchestrator，用回调注入
      stageRevision: (planId, stageId) => {
        const snap = orch.registry.get(planId)
        return snap?.stages.find((s) => s.id === stageId)?.revision ?? null
      },
      onStageDone: ({ planId, stageId }) => {
        const snap = orch.registry.get(planId)
        const stage = snap?.stages.find((s) => s.id === stageId)
        // 只有 doing 才能 execution_done（状态机唯一入口会再校验一次）
        if (!stage || stage.status !== 'doing') return
        orch.registry.advance(planId, stageId, 'execution_done', stage.revision, Date.now(), 'auto')
      }
    }
  )

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
    // 成本护栏（fail-closed）：超预算直接抛错，连 HTTP 请求都不会发出去
    assertImageBudget(opts.model, Math.max(1, Math.round(opts.n || 1)))
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
        recordImageSpend(opts.model, persisted.length)
        log('info', `generate done files=${persisted.length} refs=${refs.length} seq=${seq} spent=${imageSpentCny()} in ${Date.now() - t0}ms`)
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
    recordImageSpend(opts.model, 1)
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

  handle('settings:get', () => publicSettings())
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
    // 落盘后返回公开投影（绝不回传 writeSettings 的合并结果，其中含密钥密文）
    writeSettings(patch)
    return publicSettings()
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
    if (!isKnownProvider(provider)) return { ok: false as const, err: '未知服务商' }
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
    // Agent 一次会走多步出图/改图：先按 2 张的额度闸门，实际花费在执行后按产物张数记账
    assertImageBudget(imageConn.model, 2)
    // 创作页素材托盘：Agent 可用 images 参数按序号引用（1-based 即"图1/图2"）
    const materialPool = (payload.refs ?? []).slice(0, imageCapability(imageConn.model).maxRefs)
    const agentRes = await runAgent({
      runId: payload.runId,
      goal: payload.goal.trim(),
      baseImage: payload.baseName,
      textConn: connFor(textDef.provider, textDef.model),
      imageConn,
      materialPool,
      outputsDir: OUT_DIR,
      onEvent: (e: unknown) => win?.webContents.send('agent-progress', e)
    })
    // 按实际产物张数记账（至少记 1 张，避免 0 张时漏记）
    recordImageSpend(imageConn.model, Math.max(1, agentRes.files.length))
    return agentRes
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
      // 改图同样是付费链路，走同一套预算闸门
      assertImageBudget(model, 1)
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
        recordImageSpend(model, 1)
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
  handle('update:download', async (_e, payload: { url: string; name: string; size?: number; sha512?: string }) => {
    if (!payload?.url) throw new Error('缺少下载地址')
    // sha512 由更新源签发（feed 的 sha512 / GitHub asset digest）；缺失时 downloadUpdate 会明确拒绝非 https 地址
    return downloadUpdate(
      payload.url,
      payload.name,
      (p) => win?.webContents.send('update-progress', p),
      payload.size,
      payload.sha512
    )
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
    // 探针单独成模块（原实现占入口 55% 行数）：动态加载，生产路径不执行
    const probeWin = win
    void import('./probes/shot')
      .then((m) => m.runScreenshotProbes({ win: probeWin, appRoot: APP_ROOT }))
      .catch((e) => {
        log('error', 'screenshot probes failed to load: ' + (e instanceof Error ? e.message : String(e)))
        app.exit(1)
      })
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
