// 一次性脚本：把选定的 C 方案 logo 加工成三套规格（纯像素处理，不联网）
// 输出：
//   assets/logo/logo-C-256.png          —— README 展示图（直角缩放）
//   build/icon.png                       —— 打包/窗口图标（1024 圆角透明）
//   src/renderer/src/assets/logo-64.png  —— 侧栏小图标（64 圆角透明）
// 用法：node_modules\electron\dist\electron.exe scripts\make_icon.cjs（就绪事件里跑，结果写状态文件）
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

app.name = 'miaodraw'
app.on('window-all-closed', () => undefined)

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'assets', 'logo', 'logo-C-ink-wave.png')
const STATUS = path.join(ROOT, 'assets', 'icon-status.txt')

/** 圆角矩形覆盖度（SDF，1px 抗锯齿） */
function roundedAlpha(px, py, w, h, r) {
  const qx = Math.abs(px + 0.5 - w / 2) - (w / 2 - r)
  const qy = Math.abs(py + 0.5 - h / 2) - (h / 2 - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  const d = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
  return Math.max(0, Math.min(1, 0.5 - d))
}

/** 缩放 + 圆角透明（BGRA 手动写 alpha） */
function rounded(size, radius) {
  const img = nativeImage.createFromPath(SRC)
  if (img.isEmpty()) throw new Error('source logo not readable: ' + SRC)
  const rz = img.resize({ width: size, height: size, quality: 'best' })
  const { width: w, height: h } = rz.getSize()
  const src = rz.getBitmap() // BGRA
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      out[i] = src[i]
      out[i + 1] = src[i + 1]
      out[i + 2] = src[i + 2]
      out[i + 3] = Math.round(255 * roundedAlpha(x, y, w, h, radius))
    }
  }
  return nativeImage.createFromBitmap(out, { width: w, height: h })
}

app.on('ready', () => {
  const lines = []
  try {
    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
    fs.mkdirSync(path.join(ROOT, 'src', 'renderer', 'src', 'assets'), { recursive: true })

    const b256 = nativeImage.createFromPath(SRC).resize({ width: 256, height: 256, quality: 'best' })
    fs.writeFileSync(path.join(ROOT, 'assets', 'logo', 'logo-C-256.png'), b256.toPNG())
    lines.push('logo-C-256.png OK')

    const icon = rounded(1024, 224)
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), icon.toPNG())
    lines.push('build/icon.png OK (1024 rounded, transparent corners)')

    const side = rounded(64, 14)
    fs.writeFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'logo-64.png'), side.toPNG())
    lines.push('logo-64.png OK (sidebar)')
  } catch (e) {
    lines.push('ERROR: ' + (e && e.message ? e.message : String(e)))
  }
  fs.writeFileSync(STATUS, lines.join('\n'))
  app.exit(0)
})
