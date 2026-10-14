// 连线几何命中单测（P0-5 验收项②）
// 运行：node --test src/renderer/src/canvas/connection-hit.test.mjs
// 说明：被测模块是纯几何 .ts（只有 import type），Node 直接做类型擦除即可执行。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hitTestConnectionTarget, portAnchor, snapEndpoint, connectionPath } from './connection-hit.ts'

const nodes = [
  { id: 'a', x: 0, y: 0, width: 300, height: 200 },
  { id: 'b', x: 600, y: 400, width: 300, height: 200 }
]

test('包围盒内命中，优先级 0', () => {
  const hit = hitTestConnectionTarget(nodes, { x: 150, y: 100 }, { scale: 1 })
  assert.equal(hit.nodeId, 'a')
  assert.equal(hit.priority, 0)
  assert.deepEqual(hit.anchor, portAnchor(nodes[0]))
})

test('端口圆内命中，优先级 1（屏幕 18px，缩放到 0.25 仍恒定命中）', () => {
  const anchor = portAnchor(nodes[1]) // {600, 500}，位于节点左边缘
  // k=1：锚点左侧 10 世界像素（盒外）→ 屏 10px（在 18px 内）
  const at1 = hitTestConnectionTarget(nodes, { x: anchor.x - 10, y: anchor.y }, { scale: 1 })
  assert.equal(at1.nodeId, 'b')
  assert.equal(at1.priority, 1)
  // k=0.25：锚点左侧 40 世界像素 = 屏 10px → 仍应命中（1/k 补偿）
  const at2 = hitTestConnectionTarget(nodes, { x: anchor.x - 40, y: anchor.y }, { scale: 0.25 })
  assert.equal(at2.nodeId, 'b')
  assert.equal(at2.priority, 1)
  // 对照：锚点左侧 20 世界像素在 k=1 下 = 屏 20px > 18px（掉出端口圆），但在 24px 外扩区内
  const at3 = hitTestConnectionTarget(nodes, { x: anchor.x - 20, y: anchor.y }, { scale: 1 })
  assert.equal(at3.nodeId, 'b')
  assert.equal(at3.priority, 2)
})

test('外扩区命中，优先级 2；超出外扩区不命中', () => {
  // 节点 b 左边缘 x=600，屏 24px 外扩：k=1 → 世界 24px
  const near = hitTestConnectionTarget(nodes, { x: 600 - 20, y: 500 }, { scale: 1 })
  assert.equal(near.nodeId, 'b')
  assert.equal(near.priority, 2)
  const far = hitTestConnectionTarget(nodes, { x: 600 - 60, y: 500 }, { scale: 1 })
  assert.equal(far.nodeId, null)
  assert.equal(far.priority, null)
})

test('高缩放时外扩区按 1/k 收窄（屏幕恒定）', () => {
  // k=2 → 外扩世界范围 12px；距边缘 20 世界像素 = 40 屏像素，超出 → 不命中
  const hit = hitTestConnectionTarget(nodes, { x: 600 - 20, y: 500 }, { scale: 2 })
  assert.equal(hit.nodeId, null)
})

test('优先级排序：包围盒内压过端口圆', () => {
  // 点落在 a 内，同时距 b 的端口圆很近 → 取 a（priority 0）
  const hit = hitTestConnectionTarget(nodes, { x: 299, y: 100 }, { scale: 1 })
  assert.equal(hit.nodeId, 'a')
  assert.equal(hit.priority, 0)
})

test('排除源节点自身', () => {
  const hit = hitTestConnectionTarget(nodes, { x: 150, y: 100 }, { scale: 1, excludeId: 'a' })
  assert.equal(hit.nodeId, null)
})

test('重叠节点：同优先级取层级更高（数组靠后）者', () => {
  const stacked = [
    { id: 'low', x: 0, y: 0, width: 300, height: 200 },
    { id: 'high', x: 10, y: 10, width: 300, height: 200 } // 后创建 = 在上层
  ]
  const hit1 = hitTestConnectionTarget(stacked, { x: 150, y: 100 }, { scale: 1 })
  assert.equal(hit1.nodeId, 'high')
  // 反序数组：同一几何、层级关系反转 → 取新的上层
  const reversed = [
    { id: 'high', x: 10, y: 10, width: 300, height: 200 },
    { id: 'low', x: 0, y: 0, width: 300, height: 200 }
  ]
  assert.equal(hitTestConnectionTarget(reversed, { x: 150, y: 100 }, { scale: 1 }).nodeId, 'low')
  // 优先级仍压过层级：下层节点的端口圆命中（优先级 1）不敌上层节点的盒内命中（优先级 0）
  const near = hitTestConnectionTarget(stacked, { x: 290, y: 100 }, { scale: 1 })
  assert.equal(near.nodeId, 'high')
  assert.equal(near.priority, 0)
})

test('吸附：命中目标时端点落到目标锚点，未命中时跟鼠标', () => {
  const world = { x: 610, y: 500 }
  const hit = hitTestConnectionTarget(nodes, world, { scale: 1 })
  const snapped = snapEndpoint(world, hit)
  assert.equal(snapped.snapped, true)
  assert.deepEqual({ x: snapped.x, y: snapped.y }, portAnchor(nodes[1]))
  const miss = snapEndpoint({ x: 20, y: 900 }, { nodeId: null, priority: null, anchor: null, isNear: false })
  assert.equal(miss.snapped, false)
  assert.deepEqual({ x: miss.x, y: miss.y }, { x: 20, y: 900 })
})

test('connectionPath 输出三次贝塞尔', () => {
  const d = connectionPath({ x: 0, y: 0 }, { x: 100, y: 50 })
  assert.equal(d, 'M 0 0 C 50 0, 50 50, 100 50')
})
