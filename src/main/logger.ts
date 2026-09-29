// ---------- 轮转日志（主进程全局异常与关键事件落盘，防"静默死亡无从排查"） ----------
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024 // 单文件 5MB，超限滚动到新文件
const MAX_FILES = 3 // 最多保留 3 份，总量上限 ~15MB，绝不重蹈 28GB 日志的覆辙

let dir = ''
let active = ''

export function initLogger(logsDir: string): void {
  dir = logsDir
  try {
    fs.mkdirSync(dir, { recursive: true })
    rotate()
  } catch {
    dir = ''
  }
}

function rotate(): void {
  active = path.join(dir, `main-${Date.now()}.log`)
  const old = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('main-') && f.endsWith('.log'))
    .sort()
  while (old.length >= MAX_FILES) {
    const victim = old.shift()
    if (victim) {
      try {
        fs.unlinkSync(path.join(dir, victim))
      } catch {
        /* 被占用就留给下次 */
      }
    }
  }
}

export function log(level: 'info' | 'warn' | 'error', msg: string): void {
  if (!dir) return
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`
  try {
    fs.appendFileSync(active, line)
    if (fs.statSync(active).size > MAX_BYTES) rotate()
  } catch {
    /* 日志失败不影响业务 */
  }
}
