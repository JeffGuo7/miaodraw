/**
 * Pixelle-Video 后端管理（M3）：沿用 PixelleVideo-Desktop 已验证方案。
 * - 空闲端口自动选择（PIXELLE_PORT 可固定，测试用）
 * - spawn uv.exe run python api/app.py（FastAPI 后端，原项目零改动）
 * - /health 健康检查就绪后才放行
 * - 退出 taskkill /T /F 杀全树，无残留
 */
import { app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const DEFAULT_BACKEND_DIR = 'D:\\project\\Pixelle-Video'

export interface PixelleState {
  proc: ChildProcess | null
  port: number | null
  baseUrl: string | null
}

const state: PixelleState = { proc: null, port: null, baseUrl: null }

function backendDir(): string {
  return process.env.PIXELLE_BACKEND_DIR || DEFAULT_BACKEND_DIR
}

export function pixelleOutputDir(): string {
  return process.env.PIXELLE_OUTPUT_DIR || path.join(backendDir(), 'output')
}

function log(msg: string): void {
  console.log(`[pixelle] ${new Date().toISOString()} ${msg}`)
}

function getFreePort(): Promise<number> {
  if (process.env.PIXELLE_PORT) return Promise.resolve(Number(process.env.PIXELLE_PORT))
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200)
      res.resume()
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** 确保后端配置存在（官方要求 config.yaml，缺省从 example 复制） */
function ensureConfig(): void {
  const dir = backendDir()
  const example = path.join(dir, 'config.example.yaml')
  const target = path.join(dir, 'config.yaml')
  try {
    if (!fs.existsSync(target) && fs.existsSync(example)) {
      fs.copyFileSync(example, target)
      log('config.yaml created from example')
    }
  } catch (e) {
    log(`ensureConfig failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 启动后端（若已在跑直接返回），就绪后 resolve baseUrl */
export async function ensurePixelleBackend(): Promise<{ baseUrl: string }> {
  if (state.proc && state.port && (await checkHealth(state.port))) {
    return { baseUrl: state.baseUrl as string }
  }
  if (!fs.existsSync(path.join(backendDir(), 'pyproject.toml'))) {
    throw new Error(`Pixelle 后端目录不存在：${backendDir()}（可用 PIXELLE_BACKEND_DIR 覆盖）`)
  }
  ensureConfig()
  const port = await getFreePort()
  log(`starting backend on port ${port}`)
  const proc = spawn(
    'uv.exe',
    [
      'run',
      // Windows 实测两个必须项（否则后端会在渲染/渲染后的打印阶段直接崩）：
      // 1) PYTHONUTF8/PYTHONIOENCODING：Python 默认按 GBK 编码 stdout，Pixelle 里
      //    print("✓ …") 会抛 UnicodeEncodeError 打断管线（见下方 env）。
      // 2) edge-tts>=7.3.1：仓库锁定 7.2.7，与微软 TTS 端点握手失效（403）；
      //    7.3.1 正常。默认 TTS 走 DashScope Qwen-TTS，这里仅保证兜底路径可用。
      '--with', 'edge-tts>=7.3.1',
      'python',
      'api/app.py',
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ],
    {
      cwd: backendDir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    }
  )
  state.proc = proc
  state.port = port
  state.baseUrl = `http://127.0.0.1:${port}`
  proc.stdout?.on('data', (d) => log(`[backend] ${String(d).trim()}`))
  proc.stderr?.on('data', (d) => log(`[backend:err] ${String(d).trim()}`))
  proc.on('exit', (code) => {
    log(`backend exited code=${code}`)
    if (state.proc === proc) {
      state.proc = null
      state.port = null
      state.baseUrl = null
    }
  })

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (!state.proc) throw new Error('Pixelle 后端进程在启动阶段退出（查看主进程日志）')
    if (await checkHealth(port)) {
      log('backend healthy')
      return { baseUrl: state.baseUrl as string }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  await stopPixelleBackend()
  throw new Error('Pixelle 后端 120s 内未就绪（首次运行 uv 需要解析依赖，可重试）')
}

/** 杀整个后端进程树 */
export async function stopPixelleBackend(): Promise<void> {
  const proc = state.proc
  if (!proc || proc.exitCode !== null) return
  const pid = proc.pid
  if (!pid) return
  log(`killing backend tree pid=${pid}`)
  await new Promise<void>((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
      if (err) {
        log(`taskkill failed: ${err.message}, fallback kill()`)
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
      }
      resolve()
    })
  })
  state.proc = null
  state.port = null
  state.baseUrl = null
}

/** 应用退出时清理（多次注册安全） */
let quitHooked = false
export function hookPixelleQuit(): void {
  if (quitHooked) return
  quitHooked = true
  app.on('before-quit', (e) => {
    if (!state.proc) return
    e.preventDefault()
    void stopPixelleBackend().finally(() => app.exit(0))
  })
}

type HandleFn = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown) => void

/** IPC：pixelle:ensure / pixelle:proxy（渲染层不直连后端，主进程代理转发） */
export function registerPixelleHandlers(handle: HandleFn): void {
  hookPixelleQuit()

  handle('pixelle:ensure', async (): Promise<{ baseUrl: string }> => {
    return ensurePixelleBackend()
  })

  /** 环境预检：uv 是否可用、后端目录是否存在（缺失给用户可执行的指引） */
  handle('pixelle:checkEnv', async (): Promise<{ ok: boolean; uv: boolean; backendDir: boolean; message?: string }> => {
    const uv = await new Promise<boolean>((resolve) => {
      execFile('uv.exe', ['--version'], (err) => resolve(!err))
    })
    const dir = backendDir()
    const backendDirExists = fs.existsSync(path.join(dir, 'pyproject.toml'))
    let message: string | undefined
    if (!uv) message = '未检测到 uv（Python 环境管理器）。请安装：https://docs.astral.sh/uv/ 或 winget install astral-sh.uv，安装后重启应用重试。'
    else if (!backendDirExists) message = `Pixelle 后端目录不存在：${dir}。请克隆 https://github.com/ATH-MaaS/Pixelle-Video 到该位置，或设置环境变量 PIXELLE_BACKEND_DIR 指向实际目录。`
    return { ok: uv && backendDirExists, uv, backendDir: backendDirExists, message }
  })

  /** 通用代理：GET/POST 后端 REST，渲染层轮询任务也走这里（规避 CORS/混合内容） */
  handle(
    'pixelle:proxy',
    async (_e, args: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<{ status: number; json: unknown }> => {
      const { baseUrl } = await ensurePixelleBackend()
      const resp = await fetch(`${baseUrl}${args.path}`, {
        method: args.method,
        headers: args.body ? { 'Content-Type': 'application/json' } : undefined,
        body: args.body ? JSON.stringify(args.body) : undefined
      })
      const text = await resp.text()
      let json: unknown = null
      try {
        json = JSON.parse(text)
      } catch {
        json = { raw: text.slice(0, 2000) }
      }
      return { status: resp.status, json }
    }
  )

  /** 视频产物指纹采样（不整读大视频：只取文件 stat + 头部 4MB 哈希作为 quick_hash） */
  handle('pixelle:videoInfo', async (_e, absPath: string): Promise<{ size: number; mtimeMs: number; quickHash: string }> => {
    const allowed = path.normalize(pixelleOutputDir())
    const target = path.normalize(absPath)
    if (!target.startsWith(allowed)) throw new Error('路径不在 Pixelle 输出目录内')
    const fsp = await import('node:fs/promises')
    const st = await fsp.stat(target)
    const fh = await fsp.open(target, 'r')
    try {
      const head = Buffer.alloc(Math.min(4 * 1024 * 1024, st.size))
      await fh.read(head, 0, head.length, 0)
      return { size: st.size, mtimeMs: st.mtimeMs, quickHash: crypto.createHash('sha256').update(head).digest('hex') }
    } finally {
      await fh.close()
    }
  })
}
