// 连线规则单测：合法数据依赖放行、非法组合拒绝、分组/计划不参与连线
// 运行：node --test src/renderer/src/canvas/connection-rules.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canConnect } from './connection-rules.ts'

function n(id, type) {
  return { id, type, x: 0, y: 0, width: 100, height: 100, metadata: {}, zIndex: 1 }
}

test('文本/图片/配置 → 出图：合法', () => {
  assert.equal(canConnect(n('a', 'text'), n('b', 'generate')).ok, true)
  assert.equal(canConnect(n('a', 'image'), n('b', 'generate')).ok, true)
  assert.equal(canConnect(n('a', 'config'), n('b', 'generate')).ok, true)
})

test('图片/音频/出图产物 → 视频：合法', () => {
  assert.equal(canConnect(n('a', 'image'), n('b', 'video')).ok, true)
  assert.equal(canConnect(n('a', 'audio'), n('b', 'video')).ok, true)
  assert.equal(canConnect(n('a', 'generate'), n('b', 'video')).ok, true)
})

test('视频/音频做源：没有下游可接', () => {
  assert.equal(canConnect(n('a', 'video'), n('b', 'generate')).ok, false)
  assert.equal(canConnect(n('a', 'video'), n('b', 'video')).ok, false)
})

test('不能连自己', () => {
  const r = canConnect(n('a', 'text'), n('a', 'generate'))
  assert.equal(r.ok, false)
  assert.match(r.reason, /自己/)
})

test('分组与计划卡不参与连线', () => {
  assert.equal(canConnect(n('a', 'group'), n('b', 'generate')).ok, false)
  assert.equal(canConnect(n('a', 'text'), n('b', 'plan')).ok, false)
})

test('非法组合给出可读原因', () => {
  const r = canConnect(n('a', 'audio'), n('b', 'generate'))
  assert.equal(r.ok, false)
  assert.match(r.reason, /音频/)
  assert.match(r.reason, /出图/)
})
