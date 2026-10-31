// 连线几何命中单测
// 运行：node --test src/renderer/src/canvas/connection-hit.test.mjs
// 说明：被测模块是纯几何 .ts（只有类型导出），Node 直接做类型擦除即可执行。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_SNAP_RADIUS_PX,
  hitTestConnectionTarget,
  portAnchor,
  sourcePortAnchor,
  snapEndpoint,
  connectionPath
} from './connection-hit.ts'

const nodes = [
  { id: 'a', x: 0, y: 0, width: 300, height: 200 },
  { id: 'b', x: 600, y: 400, width: 300, height: 200 }
]

test('端口圆内命中，返回左侧中部锚点', () => {
  const anchor = portAnchor(nodes[1]) // {600, 500}
  const hit = hitTestConnectionTarget(nodes, { x: anchor.x - 10, y: anchor.y }, { scale: 1 })
  assert.equal(hit.nodeId, 'b')
  assert.deepEqual(hit.anchor, anchor)
  assert.equal(hit.isNear, true)
})

test('半径按屏幕像素恒定：缩放 0.25 时世界 100px（屏 25px）仍命中', () => {
  const anchor = portAnchor(nodes[1])
  const hit = hitTestConnectionTarget(nodes, { x: anchor.x - 100, y: anchor.y }, { scale: 0.25 })
  assert.equal(hit.nodeId, 'b')
  // 对照：同样 100 世界像素在 k=1 下是 100 屏像素，超出 44 → 不命中
  assert.equal(hitTestConnectionTarget(nodes, { x: anchor.x - 100, y: anchor.y }, { scale: 1 }).nodeId, null)
})

test('节点体本身不再是连线目标（旧实现在这里会误连）', () => {
  const hit = hitTestConnectionTarget(nodes, { x: 150, y: 100 }, { scale: 1 })
  assert.equal(hit.nodeId, null)
  assert.deepEqual(hit.anchor, null)
})

test('半径边界：恰好等于半径命中，超出即不命中', () => {
  const anchor = portAnchor(nodes[1])
  const within = hitTestConnectionTarget(nodes, { x: anchor.x - DEFAULT_SNAP_RADIUS_PX, y: anchor.y }, { scale: 1 })
  assert.equal(within.nodeId, 'b')
  const outside = hitTestConnectionTarget(nodes, { x: anchor.x - DEFAULT_SNAP_RADIUS_PX - 1, y: anchor.y }, { scale: 1 })
  assert.equal(outside.nodeId, null)
  // 但在 1.6 倍「接近」范围内 → isNear 为真，用于光标提示
  assert.equal(outside.isNear, true)
})

test('远处既不命中也不接近', () => {
  const hit = hitTestConnectionTarget(nodes, { x: 600, y: -800 }, { scale: 1 })
  assert.equal(hit.nodeId, null)
  assert.equal(hit.isNear, false)
})

test('重叠节点：取层级更高（数组靠后）的端口', () => {
  const stacked = [
    { id: 'low', x: 0, y: 0, width: 300, height: 200 },
    { id: 'high', x: 0, y: 0, width: 300, height: 200 }
  ]
  const anchor = portAnchor(stacked[0])
  const hit = hitTestConnectionTarget(stacked, { x: anchor.x + 2, y: anchor.y }, { scale: 1 })
  assert.equal(hit.nodeId, 'high')
  const reversed = [stacked[1], stacked[0]]
  assert.equal(hitTestConnectionTarget(reversed, { x: anchor.x + 2, y: anchor.y }, { scale: 1 }).nodeId, 'low')
})

test('排除源节点自身', () => {
  const anchor = portAnchor(nodes[0])
  const hit = hitTestConnectionTarget(nodes, { x: anchor.x + 2, y: anchor.y }, { scale: 1, excludeId: 'a' })
  assert.equal(hit.nodeId, null)
})

test('自定义半径生效', () => {
  const anchor = portAnchor(nodes[1])
  const at = { x: anchor.x - 30, y: anchor.y }
  assert.equal(hitTestConnectionTarget(nodes, at, { scale: 1 }).nodeId, 'b')
  assert.equal(hitTestConnectionTarget(nodes, at, { scale: 1, radiusPx: 20 }).nodeId, null)
})

test('吸附：命中目标时端点落到目标锚点，未命中时跟鼠标', () => {
  const world = { x: 610, y: 500 }
  const hit = hitTestConnectionTarget(nodes, world, { scale: 1 })
  const snapped = snapEndpoint(world, hit)
  assert.equal(snapped.snapped, true)
  assert.deepEqual({ x: snapped.x, y: snapped.y }, portAnchor(nodes[1]))
  const miss = snapEndpoint({ x: 20, y: 900 }, { nodeId: null, anchor: null, isNear: false })
  assert.equal(miss.snapped, false)
  assert.deepEqual({ x: miss.x, y: miss.y }, { x: 20, y: 900 })
})

test('connectionPath 输出三次贝塞尔，短距离保留最小弧度', () => {
  assert.equal(connectionPath({ x: 0, y: 0 }, { x: 200, y: 100 }), 'M 0 0 C 100 0, 100 100, 200 100')
  // 水平距离 0（上下对齐）时弧度下限 50，不会退化成直线
  assert.equal(connectionPath({ x: 0, y: 0 }, { x: 0, y: 100 }), 'M 0 0 C 50 0, -50 100, 0 100')
})

test('源端锚点在右、目标端锚点在左（连线方向：右出左进）', () => {
  const n = { id: 'x', x: 100, y: 200, width: 320, height: 300 }
  assert.deepEqual(sourcePortAnchor(n), { x: 420, y: 350 })
  assert.deepEqual(portAnchor(n), { x: 100, y: 350 })
})
