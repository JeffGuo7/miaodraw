// 打包前置脚本：把全局安装的 bailian-cli 复制进 vendor/，并压成 zip 随安装包分发
// 用途：让最终用户无需安装 Node / npm i -g bailian-cli / bl auth login
// 为什么用 zip：electron-builder 的全局排除规则会把 extraResources 里的 node_modules 剪掉，
//             整包 zip 成单文件可绕开该限制；应用首启时用系统 tar.exe 解包到 userData。
// 用法：npm run vendor  （build:win 前自动执行，见 package.json）
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CANDIDATES = [
  process.env['BL_SRC'],
  'C:\\nvm4w\\nodejs\\node_modules\\bailian-cli',
  path.join(path.dirname(process.execPath), 'node_modules', 'bailian-cli')
].filter(Boolean)

function findSource() {
  for (const c of CANDIDATES) {
    if (c && fs.existsSync(path.join(c, 'dist', 'bailian.mjs'))) return c
  }
  throw new Error(
    '未找到全局 bailian-cli（需含 dist/bailian.mjs）。请先 npm i -g bailian-cli，或用环境变量 BL_SRC 指定其安装目录。'
  )
}

const src = findSource()
const vendorRoot = path.join(__dirname, '..', 'vendor')
const dst = path.join(vendorRoot, 'bailian-cli')
const zipPath = path.join(vendorRoot, 'bailian-cli.zip')

fs.rmSync(dst, { recursive: true, force: true })
fs.rmSync(zipPath, { force: true })
fs.mkdirSync(vendorRoot, { recursive: true })
// 排除 .bin（Windows 命令包装器，运行时不需要且易损坏）
fs.cpSync(src, dst, {
  recursive: true,
  filter: (s) => !s.split(path.sep).includes('.bin')
})

// Windows 10+ 自带 bsdtar，-a 按扩展名自动选 zip 格式
const r = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', vendorRoot, 'bailian-cli'], {
  stdio: 'inherit'
})
if (r.status !== 0) throw new Error('vendor zip 打包失败（tar 退出码 ' + r.status + '）')

const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)
console.log(`[vendor] ${src} → vendor/bailian-cli + bailian-cli.zip (${mb} MB)`)
