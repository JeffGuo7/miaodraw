// 吸附对齐单测：边/中心对齐、阈值、最近优先、网格兜底、两轴独立
// 运行：node --test src/renderer/src/canvas/snapping.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computeSnap } from './snapping.ts'

const OTHER = { x: 100, y: 100, width: 200, height: 100 }

test('左边缘对齐：差值在阈值内产生修正与竖线', () => {
  const r = computeSnap({ x: 104, y: 300, width: 50, height: 50 }, [OTHER], { threshold: 8 })
  assert.equal(r.dx, -4)
  assert.equal(r.guides.some((g) => g.axis === 'x' && g.world === 100), true)
})

test('超出阈值不吸附', () => {
  const r = computeSnap({ x: 140, y: 300, width: 50, height: 50 }, [OTHER], { threshold: 8 })
  assert.equal(r.dx, 0)
  assert.equal(r.guides.length, 0)
})

test('中心对齐：中线与中线', () => {
  const r = computeSnap({ x: 175, y: 400, width: 50, height: 50 }, [OTHER], { threshold: 8 })
  // 移动块中心 200，other 中心 200 → 无需位移，应给出 center 对齐线
  assert.equal(r.dx, 0)
  assert.equal(r.guides.some((g) => g.kind === 'center' && g.world === 200), true)
})

test('多邻居时取最近的一个', () => {
  const near = { x: 300, y: 0, width: 10, height: 10 }
  const r = computeSnap({ x: 296, y: 500, width: 50, height: 50 }, [OTHER, near], { threshold: 8 })
  assert.equal(r.dx, 4)
  assert.equal(r.guides[0].world, 300)
})

test('两轴独立吸附', () => {
  const r = computeSnap({ x: 103, y: 97, width: 50, height: 50 }, [OTHER], { threshold: 8 })
  assert.equal(r.dx, -3)
  assert.equal(r.dy, 3)
  assert.equal(r.guides.length, 2)
})

test('无邻居时按网格兜底（8px）', () => {
  const r = computeSnap({ x: 61, y: 62, width: 50, height: 50 }, [], { threshold: 8, grid: 8 })
  assert.equal(r.dx, 3) // 61 → 64
  assert.equal(r.dy, 2) // 62 → 64
})

test('网格兜底也受阈值约束（差 3px 但阈值只有 2 → 不吸附）', () => {
  const r = computeSnap({ x: 67, y: 67, width: 50, height: 50 }, [], { threshold: 2, grid: 8 })
  assert.equal(r.dx, 0)
  assert.equal(r.dy, 0)
})

test('threshold=0.5 的最小值不会让所有点互相吸附', () => {
  const r = computeSnap({ x: 1000, y: 1000, width: 10, height: 10 }, [OTHER], { threshold: 0.5 })
  assert.equal(r.dx, 0)
  assert.equal(r.dy, 0)
})

test('右边缘对左边缘：不同尺寸节点也能对齐', () => {
  // 移动块左边 500，right = 550；other.right = 300 —— 无对齐；用 other.x=498 让移动块 left 贴 other.x
  const o = { x: 498, y: 1000, width: 100, height: 100 }
  const r = computeSnap({ x: 500, y: 0, width: 50, height: 50 }, [o], { threshold: 4 })
  assert.equal(r.dx, -2)
})
