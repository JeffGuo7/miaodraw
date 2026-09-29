import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { log } from './logger'

/** 百炼 CLI 的 node 入口（bl.cmd 只是包装器；直接用 node 跑 .mjs，绕开 Windows spawn .cmd 限制） */
const BL_ENTRY_CANDIDATES = [
  'C:\\nvm4w\\nodejs\\node_modules\\bailian-cli\\dist\\bailian.mjs',
  'C:\\nvm4w\\nodejs\\node_modules\\@aliyun\\bailian-cli\\dist\\bailian.mjs'
]

// ---------- 内置 CLI（方案B：随安装包分发，用户免装 Node/bailian-cli） ----------
// 主进程启动时注入内置副本入口路径；优先级：BL_ENTRY 环境变量 > 内置 > 全局安装 > PATH 兜底。
let vendorEntry = ''
export function setBlVendorEntry(p: string): void {
  vendorEntry = p
}
export function usingBundledCli(): boolean {
  return !!vendorEntry && blEntry() === vendorEntry && fs.existsSync(vendorEntry)
}

const GLOBAL_ENTRY_RELS = [
  path.join('node_modules', 'bailian-cli', 'dist', 'bailian.mjs'),
  path.join('node_modules', '@aliyun', 'bailian-cli', 'dist', 'bailian.mjs')
]

/** 通过 PATH 探测全局安装的 bailian-cli，返回绝对 .mjs 入口；找不到返回 ''。
 *  绝不回退 spawn('bl', { shell: true })：args 含用户提示词，直连 cmd.exe 等于命令注入。 */
function resolveGlobalEntry(): string {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const r = spawnSync(probe, ['bl'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (r.status !== 0 || !r.stdout) return ''
    for (const line of r.stdout.split(/\r?\n/)) {
      const dir = path.dirname(line.trim())
      if (!dir || dir === '.') continue
      for (const rel of GLOBAL_ENTRY_RELS) {
        const p = path.join(dir, rel)
        if (fs.existsSync(p)) return p
      }
    }
  } catch {
    /* 探测失败按未安装处理 */
  }
  return ''
}

export function blEntry(): string {
  if (process.env.BL_ENTRY && fs.existsSync(process.env.BL_ENTRY)) return process.env.BL_ENTRY
  if (vendorEntry && fs.existsSync(vendorEntry)) return vendorEntry
  for (const c of BL_ENTRY_CANDIDATES) if (fs.existsSync(c)) return c
  return resolveGlobalEntry() // '' = 未找到任何可用 CLI 入口
}

// ---------- 应用内置密钥（免 bl auth login） ----------
// CLI 鉴权链为 --api-key > DASHSCOPE_API_KEY > 登录态；这里注入 env 级密钥，
// 不落 ~/.bailian 配置，与用户命令行登录态互相隔离、应用内优先生效。
let bailianKey = ''
export function setBailianKey(key: string): void {
  bailianKey = (key || '').trim()
}
export function hasBailianKey(): boolean {
  return bailianKey.length > 0
}

function spawnBl(args: string[]): ChildProcess {
  const entry = blEntry()
  if (!entry) {
    throw new Error('未找到百炼 CLI：内置副本缺失且全局安装探测失败。请重新安装妙绘工作台，或先 npm i -g bailian-cli')
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (bailianKey) env['DASHSCOPE_API_KEY'] = bailianKey
  return spawn(process.execPath, [entry, ...args], { env })
}

export interface BlResult {
  code: number
  stdout: string
  stderr: string
}

// ---------- 子进程治理：并发闸 / 注册表 / 整树终止 / 流上限 / 取消 ----------
const MAX_CONCURRENT = 2 // 并发 CLI 进程上限，防止并发生成互相串图与资源挤兑
const STREAM_CAP_BYTES = 2 * 1024 * 1024 // stdout/stderr 采集上限，防失控输出吃穿内存

let active = 0
const waiters: Array<() => void> = []
const live = new Map<string, ChildProcess>()
const cancelled = new Set<ChildProcess>()

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  active++
}

function releaseSlot(): void {
  active = Math.max(0, active - 1)
  const next = waiters.shift()
  if (next) next()
}

/** Windows 下 SIGKILL 杀不掉 cmd→node 孙进程，用 taskkill 整树终止 */
function killTree(child: ChildProcess): void {
  if (child.pid && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    } catch {
      /* 落到下面的直接 kill */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
}

/** 取消一次运行（按 runId）：整树终止，对应 Promise 以「已取消」结束 */
export function blCancel(runId: string): boolean {
  const child = live.get(runId)
  if (!child) return false
  cancelled.add(child)
  killTree(child)
  return true
}

/** 应用退出前清理所有存活子进程，避免后台继续烧钱 */
export function blKillAll(): void {
  for (const child of live.values()) {
    cancelled.add(child)
    killTree(child)
  }
  live.clear()
}

export function runBl(args: string[], timeoutMs = 620000, runId?: string): Promise<BlResult> {
  return acquireSlot().then(
    () =>
      new Promise<BlResult>((resolve, reject) => {
        let child: ChildProcess
        try {
          child = spawnBl(args)
        } catch (e) {
          releaseSlot()
          reject(e)
          return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (runId) live.delete(runId)
          releaseSlot()
          fn()
        }
        const timer = setTimeout(() => {
          settled = true
          cancelled.add(child)
          killTree(child)
          if (runId) live.delete(runId)
          releaseSlot()
          // 超时信息不回显完整参数（内含用户提示词）
          reject(new Error(`百炼 CLI 超时（${Math.round(timeoutMs / 1000)}s）：${args.slice(0, 2).join(' ')} …`))
        }, timeoutMs)
        if (runId) live.set(runId, child)
        // UTF-8 解码（防多字节被截断成乱码）+ 容量上限 + 流错误兜底（防 EPIPE 未捕获异常）
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
          if (stdout.length < STREAM_CAP_BYTES) stdout += chunk
        })
        child.stderr?.on('data', (chunk: string) => {
          if (stderr.length < STREAM_CAP_BYTES) stderr += chunk
        })
        child.stdout?.on('error', () => {})
        child.stderr?.on('error', () => {})
        child.on('error', (e) => {
          finish(() => reject(new Error(`无法启动百炼 CLI（${blEntry()}）：${e.message}`)))
        })
        child.on('close', (code) => {
          finish(() => {
            if (cancelled.has(child)) {
              cancelled.delete(child)
              reject(new Error('已取消本次任务'))
              return
            }
            resolve({ code: code ?? -1, stdout, stderr })
          })
        })
      })
  )
}

export async function blUpdate(): Promise<{ ok: boolean; out: string }> {
  const r = await runBl(['update'], 300000)
  return { ok: r.code === 0, out: (r.stdout + '\n' + r.stderr).trim().slice(-800) }
}

let healthCache: { at: number; value: { ok: boolean; version: string; entry: string; bundled: boolean } } | null = null
const HEALTH_TTL_OK = 5 * 60 * 1000 // 成功缓存 5 分钟：避免渲染层双轮询每分钟空起 CLI 进程
const HEALTH_TTL_FAIL = 60 * 1000 // 失败只缓存 1 分钟，尽快给出恢复机会

export async function blHealth(force = false): Promise<{ ok: boolean; version: string; entry: string; bundled: boolean }> {
  if (!force && healthCache && Date.now() - healthCache.at < (healthCache.value.ok ? HEALTH_TTL_OK : HEALTH_TTL_FAIL)) {
    return healthCache.value
  }
  const entry = blEntry()
  const bundled = usingBundledCli()
  try {
    const r = await runBl(['--version'], 20000)
    const version = r.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
    const value = { ok: r.code === 0 && version.length > 0, version, entry, bundled }
    healthCache = { at: Date.now(), value }
    return value
  } catch {
    const value = { ok: false, version: '', entry, bundled }
    healthCache = { at: Date.now(), value }
    return value
  }
}

/** 密钥有效性验证：一次最小对话调用。不指定模型，让 CLI 按密钥前缀自动路由
 *  （sk-sp- → token-plan 端点及其默认模型；sk- → 普通 DashScope 端点） */
export async function bailianAuthTest(): Promise<{ ok: boolean; out: string }> {
  if (!bailianKey) return { ok: false, out: '尚未在应用内配置百炼密钥' }
  try {
    const r = await runBl(
      ['text', 'chat', '--message', '只回复两个字：成功', '--quiet', '--timeout', '30'],
      60000
    )
    const out = (r.stdout + '\n' + r.stderr).trim()
    if (r.code === 0 && out) return { ok: true, out: '密钥可用 · 模型响应：' + out.slice(0, 60) }
    return { ok: false, out: out.slice(-300) || '调用失败：无任何输出' }
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) }
  }
}

export interface GenOpts {
  prompt: string
  negative?: string
  w: number
  h: number
  seed?: number
  model: string
  parent?: string
  /** 取消与进度事件关联键：传入后 runBl 登记进程树，可用 blCancel(runId) 整树终止 */
  runId?: string
  onProgress?: (stage: string, detail?: string) => void
  ref?: { name: string; data: ArrayBuffer }
}

export interface GenResult {
  file: string
  url: string
  elapsed: number
  seed: number
  model: string
  parent?: string
}

function tail(s: string, n = 600): string {
  const t = (s || '').trim()
  return t.length > n ? t.slice(-n) : t
}

/** 失败时抛出带 CLI 输出尾部的错误；成功返回落盘文件 */
export async function generate(opts: GenOpts, outputsDir: string): Promise<GenResult> {
  const t0 = Date.now()
  await fsp.mkdir(outputsDir, { recursive: true })
  // 种子恒定化：不传就随机一个并回传，保证每张图都可复现
  const usedSeed = opts.seed && opts.seed > 0 ? opts.seed : Math.floor(Math.random() * 2147483647)
  opts.onProgress?.('prepare', '参数就绪')
  log('info', `generate start model=${opts.model} size=${opts.w}x${opts.h} seed=${usedSeed} ref=${opts.ref ? 'yes' : 'no'}`)

  let tmpRef: string | null = null
  const args: string[] = []
  if (opts.ref) {
    const ext = (path.extname(opts.ref.name) || '.png').toLowerCase()
    tmpRef = path.join(os.tmpdir(), `ref-${t0}${ext}`)
    opts.onProgress?.('upload', '上传参考图')
    await fsp.writeFile(tmpRef, Buffer.from(opts.ref.data))
    args.push('image', 'edit', '--image', tmpRef)
  } else {
    args.push('image', 'generate')
  }
  args.push(
    '--model', opts.model,
    '--prompt', opts.prompt,
    '--size', `${opts.w}*${opts.h}`,
    '--out-dir', outputsDir,
    '--watermark', 'false',
    '--timeout', '600'
  )
  opts.onProgress?.('infer', '服务商推理中')
  if (opts.negative && opts.negative.trim()) args.push('--negative-prompt', opts.negative.trim())
  args.push('--seed', String(usedSeed))

  try {
    const r = await runBl(args, 620000, opts.runId)
    if (r.code !== 0) throw new Error(tail(r.stdout + r.stderr))
    opts.onProgress?.('save', '保存结果')
    let file = await newestImage(outputsDir, t0 - 5000)
    if (!file) {
      const m = r.stdout.match(/https?:\/\/\S+/)
      if (!m) throw new Error(tail('生成结束但没有找到输出文件。' + r.stdout + r.stderr))
      file = `image_${t0}.png`
      const resp = await fetch(m[0])
      if (!resp.ok) throw new Error(`下载生成结果失败：HTTP ${resp.status}`)
      await fsp.writeFile(path.join(outputsDir, file), Buffer.from(await resp.arrayBuffer()))
    }
    // 参数随图落盘（同名 .json），历史页可一键复现
    await fsp.writeFile(
      path.join(outputsDir, `${file}.json`),
      JSON.stringify(
        { prompt: opts.prompt, negative: opts.negative || undefined, w: opts.w, h: opts.h, seed: usedSeed, model: opts.model, parent: opts.parent || undefined, createdAt: new Date().toISOString() },
        null,
        2
      )
    )
    log('info', `generate done file=${file} in ${Date.now() - t0}ms`)
    return { file, url: mediaOut(file), elapsed: Date.now() - t0, seed: usedSeed, model: opts.model, parent: opts.parent }
  } finally {
    if (tmpRef) fsp.unlink(tmpRef).catch(() => {})
  }
}

const DISTILL_PROMPT = [
  '你是文生图提示词反推专家。从这张图反推一段可直接喂给任意文生图产品（Midjourney/即梦/SD等）的提示词：',
  '一个完整段落（80~150词），覆盖主体内容、风格媒介、构图视角、光线、色调、质感与画质关键词；',
  '图中若有文字，原样描述内容与位置。可在末尾附一行适合该图的风格参数或 negative prompt。',
  '只输出提示词本身，不要任何解释，不要用"图中""这是"等措辞，直接描述画面。'
].join('')

export async function distill(data: ArrayBuffer, name: string): Promise<{ prompt: string; elapsed: number }> {
  const t0 = Date.now()
  const ext = (path.extname(name) || '.png').toLowerCase()
  const tmp = path.join(os.tmpdir(), `distill-${t0}${ext}`)
  await fsp.writeFile(tmp, Buffer.from(data))
  try {
    const r = await runBl(['vision', 'describe', '--image', tmp, '--prompt', DISTILL_PROMPT, '--timeout', '120'], 180000, 'distill-' + t0)
    const prompt = r.stdout.trim()
    if (r.code !== 0 || !prompt) throw new Error(tail(r.stdout + r.stderr))
    return { prompt, elapsed: Date.now() - t0 }
  } finally {
    fsp.unlink(tmp).catch(() => {})
  }
}

function mediaOut(file: string): string {
  return `media://local/out/${encodeURIComponent(file)}`
}

async function newestImage(dir: string, notBefore: number): Promise<string | null> {
  try {
    const entries = await fsp.readdir(dir)
    let best: { f: string; m: number } | null = null
    for (const f of entries) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue
      const m = (await fsp.stat(path.join(dir, f))).mtimeMs
      if (m >= notBefore && (!best || m > best.m)) best = { f, m }
    }
    return best?.f ?? null
  } catch {
    return null
  }
}
