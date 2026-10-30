// 视口适配单测：包围盒居中、缩放夹紧、边界情况
// 运行：node --test src/renderer/src/canvas/viewport-fit.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fitView, focusNode, MAX_K, MIN_K } from './viewport-fit.ts'

const SIZE = { width: 1000, height: 800 }

test('空列表返回 null（调用方保持原视口）', () => {
  assert.equal(fitView([], SIZE), null)
})

test('单节点居中且完整可见', () => {
  const vp = fitView([{ x: 0, y: 0, width: 200, height: 100 }], SIZE)
  assert.ok(vp)
  // 节点中心映射到容器中心
  assert.equal(Math.round(vp.x + 100 * vp.k), 500)
  assert.equal(Math.round(vp.y + 50 * vp.k), 400)
  assert.ok(vp.k > 1, '小节点应放大填充')
})

test('超大包围盒缩到可见（缩放不小于下限）', () => {
  const vp = fitView([{ x: 0, y: 0, width: 100000, height: 100000 }], SIZE)
  assert.ok(vp)
  assert.equal(vp.k, MIN_K)
})

test('极小包围盒不超过放大上限', () => {
  const vp = fitView([{ x: 0, y: 0, width: 1, height: 1 }], SIZE)
  assert.ok(vp)
  assert.equal(vp.k, MAX_K)
})

test('多节点按并集包围盒适配', () => {
  const vp = fitView([{ x: 0, y: 0, width: 100, height: 100 }, { x: 900, y: 700, width: 100, height: 100 }], SIZE)
  assert.ok(vp)
  const left = vp.x
  const right = vp.x + 1000 * vp.k
  assert.ok(left >= 0 && right <= 1000, '并集应完整落在容器内')
})

test('聚焦节点：该节点占据约 60% 视口', () => {
  const vp = focusNode({ x: 0, y: 0, width: 400, height: 400 }, SIZE)
  assert.ok(vp)
  assert.ok(vp.k > 0.5)
  assert.equal(Math.round(vp.x + 200 * vp.k), 500)
})

test('聚焦非法节点返回 null', () => {
  assert.equal(focusNode({ x: 0, y: 0, width: 0, height: 0 }, SIZE), null)
})
