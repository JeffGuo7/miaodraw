import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

/** 百炼 CLI 的 node 入口（bl.cmd 只是包装器；直接用 node 跑 .mjs，绕开 Windows spawn .cmd 限制） */
const BL_ENTRY_CANDIDATES = [
  'C:\\nvm4w\\nodejs\\node_modules\\bailian-cli\\dist\\bailian.mjs',
  'C:\\nvm4w\\nodejs\\node_modules\\@aliyun\\bailian-cli\\dist\\bailian.mjs'
]

export function blEntry(): string {
  if (process.env.BL_ENTRY && fs.existsSync(process.env.BL_ENTRY)) return process.env.BL_ENTRY
  for (const c of BL_ENTRY_CANDIDATES) if (fs.existsSync(c)) return c
  return 'bl' // 兜底走 PATH（spawn shell:true）
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
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (bailianKey) env['DASHSCOPE_API_KEY'] = bailianKey
  if (entry === 'bl') return spawn('bl', args, { shell: true, env })
  return spawn(process.execPath, [entry, ...args], { env })
}

export interface BlResult {
  code: number
  stdout: string
  stderr: string
}

export function runBl(args: string[], timeoutMs = 620000): Promise<BlResult> {
  return new Promise((resolve, reject) => {
    const child = spawnBl(args)
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`百炼 CLI 超时（${Math.round(timeoutMs / 1000)}s）：${args.join(' ')}`))
    }, timeoutMs)
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法启动百炼 CLI（${blEntry()}）：${e.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

export async function blUpdate(): Promise<{ ok: boolean; out: string }> {
  const r = await runBl(['update'], 300000)
  return { ok: r.code === 0, out: (r.stdout + '\n' + r.stderr).trim().slice(-800) }
}

export async function blHealth(): Promise<{ ok: boolean; version: string; entry: string }> {
  const entry = blEntry()
  try {
    const r = await runBl(['--version'], 20000)
    const version = r.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
    return { ok: r.code === 0 && version.length > 0, version, entry }
  } catch {
    return { ok: false, version: '', entry }
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
    const r = await runBl(args)
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
    const r = await runBl(['vision', 'describe', '--image', tmp, '--prompt', DISTILL_PROMPT, '--timeout', '120'], 180000)
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
