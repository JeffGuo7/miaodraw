// 节点落位避让单测
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveNodePlacement, PLACEMENT_GAP } from './placement.ts'

const size = { width: 320, height: 300 }

test('空画布：直接用期望坐标', () => {
  assert.deepEqual(resolveNodePlacement([], size, 100, 200), { x: 100, y: 200 })
})

test('与已有节点重叠：右移一列，不再向下堆成长柱', () => {
  const existing = [{ x: 100, y: 200, width: 320, height: 300 }]
  const spot = resolveNodePlacement(existing, size, 110, 210)
  assert.equal(spot.y, 210, '应保持同一行（不向下堆）')
  assert.ok(spot.x >= 110 + 320 + PLACEMENT_GAP, '应移到已有节点右侧之外：' + JSON.stringify(spot))
})

test('同一行放满后换行', () => {
  const row = Array.from({ length: 4 }, (_, i) => ({ x: i * 400, y: 0, width: 320, height: 300 }))
  const spot = resolveNodePlacement(row, size, 0, 0)
  assert.ok(spot.y >= 300, '第 5 张卡应换行到下方：' + JSON.stringify(spot))
})

test('远处节点不影响落位', () => {
  const existing = [{ x: 5000, y: 5000, width: 100, height: 100 }]
  assert.deepEqual(resolveNodePlacement(existing, size, 0, 0), { x: 0, y: 0 })
})

test('连续 7 次新建：两两不相交', () => {
  const placed = []
  for (let i = 0; i < 7; i++) {
    const spot = resolveNodePlacement(placed, size, 0, 0)
    placed.push({ ...spot, ...size })
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]
      const b = placed[j]
      const overlap =
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
      assert.equal(overlap, false, '第 ' + i + ' 张与第 ' + j + ' 张重叠：' + JSON.stringify([a, b]))
    }
  }
})
