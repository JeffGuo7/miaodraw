import { app, shell, BrowserWindow, ipcMain, protocol, net, dialog, safeStorage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { blHealth, generate, distill, runBl, setBailianKey, hasBailianKey, bailianAuthTest, type GenOpts } from './bl'
import { httpGenerate } from './providers'
import { runAgent } from './agent'
import { createSegmentService } from './segment'
import { loadLibrary, libraryRoot } from './library'

// ---------- 路径 ----------
const APP_ROOT = app.getAppPath()
const isPackaged = app.isPackaged
const LIB_ROOT = libraryRoot(isPackaged, APP_ROOT, process.resourcesPath)
const OUT_DIR = isPackaged ? path.join(app.getPath('userData'), 'outputs') : path.join(APP_ROOT, 'outputs')
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// ---------- 单实例 ----------
const segmentService = createSegmentService((url) => {
  try {
    const u = new URL(url)
    if (u.protocol !== 'media:') return null
    const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean)
    if (segs.length < 2) return null
    const base =
      segs[0] === 'out'
        ? OUT_DIR
        : segs[0] === 'lib-a'
          ? path.join(LIB_ROOT, 'libA', 'images')
          : segs[0] === 'lib-b'
            ? path.join(LIB_ROOT, 'libB', 'data', 'images')
            : null
    if (!base) return null
    const abs = path.resolve(base, ...segs.slice(1))
    return abs
  } catch {
    return null
  }
})

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

/** media://local/<bucket>/<相对路径> → 绝对路径（含目录逃逸校验），失败返回 null */
function parseMediaUrl(url: string): string | null {
  try {
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

// ---------- 设置 ----------
let libPromise: Promise<unknown> | null = null

interface Settings {
  model?: string
  size?: string
  onboarded?: string
  providers?: Record<string, { apiKey?: string }>
  activeModel?: { provider: string; model: string }
  /** 百炼密钥密文（safeStorage 加密后 base64；不支持加密的平台退化为 base64 并提示） */
  bailianKeyEnc?: string
  bailianKeyPlain?: boolean
}
function readSettings(): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8')) as Settings
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

// ---------- 百炼密钥（应用内配置，免 bl auth login） ----------
function encryptKey(plain: string): { enc: string; plainFallback: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: safeStorage.encryptString(plain).toString('base64'), plainFallback: false }
  }
  return { enc: Buffer.from(plain, 'utf-8').toString('base64'), plainFallback: true }
}
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
function bailianKeyInfo(): { configured: boolean; masked: string; plan: 'token-plan' | 'ordinary' | 'unknown'; plainFallback: boolean } {
  const key = decryptKey(readSettings())
  if (!key) return { configured: false, masked: '', plan: 'unknown', plainFallback: false }
  const plan = key.startsWith('sk-sp-') ? 'token-plan' : key.startsWith('sk-') ? 'ordinary' : 'unknown'
  const masked = key.length <= 8 ? '••••' : `${key.slice(0, 6)}••••${key.slice(-4)}`
  return { configured: true, masked, plan, plainFallback: !!readSettings().bailianKeyPlain }
}
function initBailianKey(): void {
  setBailianKey(decryptKey(readSettings()))
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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1520,
    height: 940,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f5f5f7',
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
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler((d) => {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ---------- 验收截图模式（与 aodl-pilot 的 TEST_MODE 同思路） ----------
const VIEW_INDEX: Record<string, number> = { create: 0, compose: 1, library: 2, distill: 3, history: 4, settings: 5 }

async function screenshotMode(w: BrowserWindow): Promise<void> {
  w.webContents.on('console-message', (_e, _level, message) => {
    if (message.toLowerCase().includes('error')) console.log('[renderer]', message.slice(0, 300))
  })
  // 整体看门狗：无论卡在哪，90s 后强制截图退出
  const watchdog = setTimeout(
    () => {
      console.log('[shot] watchdog fired')
      void w.webContents
        .capturePage()
        .then((img) => fs.writeFileSync(process.env.SHOT_PATH || path.join(APP_ROOT, 'screenshot-client.png'), img.toPNG()))
        .catch(() => undefined)
        .finally(() => app.exit(0))
    },
    90000
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
        model: 'wanx2.0-t2i-turbo', w: 1024, h: 1024
      }).then(x => 'OK:' + x.file).catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] generate:', r)
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.history}].click()`
    )
    await new Promise((r) => setTimeout(r, 4000))
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
  }
  app.exit(0)
}

// ---------- IPC ----------
function registerIpc(): void {
  ipcMain.handle('health', async () => {
    const bl = await blHealth()
    return {
      ok: bl.ok,
      version: bl.version,
      entry: bl.entry,
      hasKey: hasBailianKey(),
      libraryReady: fs.existsSync(LIB_ROOT),
      outputsDir: OUT_DIR
    }
  })

  ipcMain.handle('library', () => {
    libPromise ??= loadLibrary(LIB_ROOT, path.join(app.getPath('userData'), 'library-hash-cache.json'))
    return libPromise
  })

  ipcMain.handle('history', async () => {
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

  ipcMain.handle('generate', async (_e, raw: GenOpts & { provider?: string; runId?: string }) => {
    const opts = raw as GenOpts & { provider?: string; runId?: string }
    if (!opts || !opts.prompt || !opts.prompt.trim()) throw new Error('提示词不能为空')
    const provider = opts.provider || 'bailian'
    const onProgress = (stage: string, detail?: string): void => {
      win?.webContents.send('gen-progress', { runId: opts.runId, stage, detail })
    }
    if (provider === 'bailian') return generate({ ...opts, onProgress }, OUT_DIR)
    // HTTP 多服务商：目前仅支持文生图
    if (opts.ref) throw new Error('当前服务商暂不支持图生图，请切换回百炼模型使用改图')
    const s = readSettings()
    const apiKey = s.providers?.[provider]?.apiKey
    if (!apiKey) {
      const label = provider === 'siliconflow' ? '硅基流动' : provider === 'openai' ? 'OpenAI' : provider
      throw new Error(`未配置 ${label} 的 API Key，请到「设置 → 模型服务」填写`)
    }
    if (provider !== 'siliconflow' && provider !== 'openai') throw new Error(`未知服务商：${provider}`)
    const t0 = Date.now()
    const r = await httpGenerate({
      provider,
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

  ipcMain.handle('test:provider', async (_e, provider: string) => {
    const s = readSettings()
    const apiKey = s.providers?.[provider]?.apiKey
    if (!apiKey) return { ok: false, out: '请先填写 API Key 并保存' }
    try {
      if (provider === 'siliconflow') {
        await httpGenerate({
          provider: 'siliconflow',
          apiKey,
          prompt: 'a red apple on a white table, product photo',
          w: 512,
          h: 512,
          model: 'black-forest-labs/FLUX.1-schnell',
          outputsDir: OUT_DIR
        })
      } else if (provider === 'openai') {
        await httpGenerate({
          provider: 'openai',
          apiKey,
          prompt: 'a red apple on a white table, product photo',
          w: 1024,
          h: 1024,
          model: 'gpt-image-1',
          outputsDir: OUT_DIR
        })
      } else {
        return { ok: true, out: '百炼由 bl CLI 管理，无需测试' }
      }
      return { ok: true, out: '连接成功，测试图已存入作品目录' }
    } catch (e) {
      return { ok: false, out: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('distill', (_e, payload: { data: ArrayBuffer; name: string }) => {
    if (!payload?.data) throw new Error('没收到图片')
    return distill(payload.data, payload.name || 'image.png')
  })

  ipcMain.handle('settings:get', () => {
    const s = readSettings()
    // 密文绝不回显到渲染进程
    const { bailianKeyEnc: _drop, bailianKeyPlain: __drop, ...pub } = s
    return pub
  })
  ipcMain.handle('settings:set', (_e, patch: Settings) => {
    if (patch && ('bailianKeyEnc' in patch || 'bailianKeyPlain' in patch)) {
      throw new Error('密钥字段请使用 bailian-key:set 接口')
    }
    return writeSettings(patch)
  })

  // ---------- 百炼密钥管理 ----------
  ipcMain.handle('bailian-key:get', () => bailianKeyInfo())
  ipcMain.handle('bailian-key:set', (_e, key: string) => {
    const plain = String(key || '').trim()
    if (!plain) return { ok: false as const, err: '密钥不能为空' }
    if (/\s/.test(plain)) {
      return { ok: false as const, err: '密钥中间包含空格或换行，请重新完整复制粘贴' }
    }
    // 不强制 sk- 前缀：密钥格式以百炼官方签发为准，有效性交给「测试连通」验证
    const { enc, plainFallback } = encryptKey(plain)
    writeSettings({ bailianKeyEnc: enc, bailianKeyPlain: plainFallback })
    setBailianKey(plain)
    return { ok: true as const, info: bailianKeyInfo(), plainFallback }
  })
  ipcMain.handle('bailian-key:clear', () => {
    writeSettings({ bailianKeyEnc: undefined, bailianKeyPlain: undefined })
    setBailianKey('')
    return bailianKeyInfo()
  })
  ipcMain.handle('bailian-key:test', async () => {
    if (!hasBailianKey()) return { ok: false, out: '尚未配置百炼密钥，请先填写并保存' }
    return bailianAuthTest()
  })

  ipcMain.handle('favorites:list', () => readFavorites().sort((a, b) => b.savedAt - a.savedAt))
  ipcMain.handle('favorites:toggle', (_e, item: Omit<FavItem, 'savedAt'>) => {
    const list = readFavorites()
    const idx = list.findIndex((f) => f.key === item.key)
    if (idx >= 0) list.splice(idx, 1)
    else list.push({ ...item, savedAt: Date.now() })
    writeFavorites(list)
    return list.sort((a, b) => b.savedAt - a.savedAt)
  })

  ipcMain.handle('agent:run', async (_e, payload: { runId: string; goal: string; baseName?: string; model?: string }) => {
    if (!payload?.goal?.trim()) throw new Error('请输入指令')
    const runOpts = {
      runId: payload.runId,
      goal: payload.goal.trim(),
      baseImage: payload.baseName,
      defaultModel: payload.model || 'qwen-image-3.0',
      outputsDir: OUT_DIR,
      onEvent: (e: unknown) => win?.webContents.send('agent-progress', e)
    }
    return runAgent(runOpts)
  })

  ipcMain.handle('image:chain', async (_e, name: string) => {
    const chain: Array<{ name: string; url: string }> = []
    let cur = name
    for (let i = 0; i < 20; i++) {
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

  ipcMain.handle('bl:update', async () => {
    const r = await runBl(['update'], 300000)
    return { ok: r.code === 0, out: (r.stdout + '\n' + r.stderr).trim().slice(-800) }
  })

  ipcMain.handle('segment:mask', async (_e, src: string, points: Array<{ x: number; y: number }>) => {
    if (!points?.length) throw new Error('请先在图上点击至少一个点')
    return segmentService.mask(src, points)
  })

  ipcMain.handle('compose:save', async (_e, payload: { dataUrl: string; width: number; height: number }) => {
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

  ipcMain.handle('open:path', (_e, kind: string) => {
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

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    name: '妙绘工作台',
    libraryRoot: LIB_ROOT,
    outputsDir: OUT_DIR
  }))

  ipcMain.handle('image:read', (_e, url: string) => {
    const abs = parseMediaUrl(url)
    if (!abs) throw new Error('找不到文件')
    return fsp.readFile(abs)
  })

  ipcMain.handle('image:save', async (_e, url: string) => {
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

  ipcMain.handle('image:reveal', (_e, url: string) => {
    const abs = parseMediaUrl(url)
    if (abs) shell.showItemInFolder(abs)
    return { ok: !!abs }
  })
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  initBailianKey()
  protocol.handle('media', (req) => {
    const abs = parseMediaUrl(req.url)
    if (!abs) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })

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
