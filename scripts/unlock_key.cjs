// 一次性辅助：用 Electron 的 safeStorage 解密应用内百炼密钥，写入一次性临时文件
// 用法：node_modules\electron\dist\electron.exe scripts\unlock_key.cjs
// 下一步脚本读取后立刻删除该临时文件；密钥不落任何持久存储
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

app.name = 'miaodraw'
const TMP = path.join(__dirname, '..', 'assets', 'key.tmp')

app.on('window-all-closed', (e) => e.preventDefault())
app.on('ready', () => {
  const statusFile = path.join(__dirname, '..', 'assets', 'unlock-status.txt')
  try {
    const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
    const k =
      s.bailianKeyPlain || !safeStorage.isEncryptionAvailable()
        ? Buffer.from(s.bailianKeyEnc, 'base64').toString('utf-8')
        : safeStorage.decryptString(Buffer.from(s.bailianKeyEnc, 'base64'))
    if (!k) throw new Error('empty')
    fs.writeFileSync(TMP, k, { encoding: 'utf-8' })
    fs.writeFileSync(statusFile, 'UNLOCKED ' + new Date().toISOString() + ' len=' + k.length)
    console.log('UNLOCKED')
  } catch (e) {
    fs.writeFileSync(statusFile, 'UNLOCK_FAIL: ' + e.message)
    console.log('UNLOCK_FAIL: ' + e.message)
  }
  app.exit(0)
})
