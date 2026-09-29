// 一次性脚本：纯 node 运行内置百炼 CLI 生成 4 张 logo 候选（用户要求用 Token Plan 模型出图）
// 前置：先跑 electron scripts\unlock_key.cjs 生成 assets\.key.tmp
// 用法：node scripts\run_logos.cjs
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'assets', 'logo')
const KEY_TMP = path.join(ROOT, 'assets', 'key.tmp')
const BL = path.join(ROOT, 'vendor', 'bailian-cli', 'dist', 'bailian.mjs')
const LOG = path.join(ROOT, 'assets', 'logo-run.log')

function log(m) {
  const line = '[' + new Date().toISOString() + '] ' + m
  fs.appendFileSync(LOG, line + '\n')
  // 防护：若父进程/终端退出导致 stdout 管道断开（EPIPE），此处写 console 会抛异常；
  // 曾因 uncaughtException 处理器再调 log() 形成自触发死循环，3 小时刷出 28GB 日志。
  // console 写失败只丢回显，绝不允许异常向外传播。
  try {
    console.log(line)
  } catch {
    /* ignore EPIPE / stdout closed */
  }
}

const KEY = fs.readFileSync(KEY_TMP, 'utf-8').trim()
fs.unlinkSync(KEY_TMP)
log('=== run_logos start, key prefix=' + KEY.slice(0, 6) + '*** ===')

const CANDIDATES = JSON.parse(fs.readFileSync(path.join(__dirname, 'logo_prompts.json'), 'utf-8'))

fs.mkdirSync(OUT, { recursive: true })

function gen(c) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    log('generating ' + c.id)
    const before = new Set(fs.readdirSync(OUT))
    const child = spawn(
      process.execPath,
      [
        BL, 'image', 'generate',
        '--model', 'wan2.7-image',
        '--prompt', c.prompt,
        '--size', '1024*1024',
        '--out-dir', OUT,
        '--watermark', 'false',
        '--timeout', '240'
      ],
      { env: { ...process.env, DASHSCOPE_API_KEY: KEY }, windowsHide: true }
    )
    let o = ''
    let e = ''
    child.stdout.on('data', (d) => (o += d))
    child.stderr.on('data', (d) => (e += d))
    const hard = setTimeout(() => { log(c.id + ' HARD-TIMEOUT kill'); child.kill('SIGKILL') }, 300000)
    child.on('close', (code) => {
      clearTimeout(hard)
      log(c.id + ' exit=' + code + ' in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's out=' + o.trim().slice(0, 200) + ' err=' + e.trim().slice(0, 200))
      if (code === 0) {
        const fresh = fs.readdirSync(OUT).filter((f) => !before.has(f) && /\.(png|jpe?g|webp)$/i.test(f))
        if (fresh.length) {
          const to = path.join(OUT, 'logo-' + c.id + path.extname(fresh[0]))
          fs.renameSync(path.join(OUT, fresh[0]), to)
          log('saved ' + path.basename(to))
        } else log('no new file for ' + c.id)
      }
      resolve()
    })
    child.on('error', (err) => { clearTimeout(hard); log(c.id + ' spawn error: ' + err.message); resolve() })
  })
}

;(async () => {
  for (const c of CANDIDATES) await gen(c)
  log('=== ALL DONE ===')
})()
