// 远程资源地址安全判定单测：https 放行 / 内网与明文拒绝 / 阿里云域例外
// 运行：node --test src/main/net-guard.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkRemoteUrl } from './net-guard.ts'

test('公网 https 放行', () => {
  assert.equal(checkRemoteUrl('https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/a.png').ok, true)
  assert.equal(checkRemoteUrl('https://api.openai.com/v1/images/x.png').ok, true)
})

test('内网/本机地址一律拒绝（SSRF 面）', () => {
  for (const u of [
    'http://127.0.0.1:8080/a.png',
    'https://localhost/a.png',
    'https://10.0.0.5/a.png',
    'https://192.168.1.10/a.png',
    'https://172.16.0.1/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/a.png',
    'https://intranet/a.png'
  ]) {
    assert.equal(checkRemoteUrl(u).ok, false, u + ' 应被拒绝')
  }
})

test('明文 http 默认拒绝，仅阿里云产物域可按开关放行', () => {
  assert.equal(checkRemoteUrl('http://dashscope-result.oss-cn-hangzhou.aliyuncs.com/a.png').ok, false)
  assert.equal(checkRemoteUrl('http://dashscope-result.oss-cn-hangzhou.aliyuncs.com/a.png', { allowHttpAliyun: true }).ok, true)
  assert.equal(checkRemoteUrl('http://evil.example.com/a.png', { allowHttpAliyun: true }).ok, false)
})

test('非 http(s) 协议与带凭据的 URL 拒绝', () => {
  assert.equal(checkRemoteUrl('file:///C:/Windows/win.ini').ok, false)
  assert.equal(checkRemoteUrl('ftp://a.example.com/x').ok, false)
  assert.equal(checkRemoteUrl('https://user:pass@a.example.com/x').ok, false)
  assert.equal(checkRemoteUrl('').ok, false)
  assert.equal(checkRemoteUrl('not a url').ok, false)
})
