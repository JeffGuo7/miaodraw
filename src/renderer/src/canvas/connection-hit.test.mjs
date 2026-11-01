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

test('端口圆内命中（via=port），返回左侧中部锚点', () => {
  const anchor = portAnchor(nodes[1]) // {600, 500}
  const hit = hitTestConnectionTarget(nodes, { x: anchor.x - 10, y: anchor.y }, { scale: 1 })
  assert.equal(hit.nodeId, 'b')
  assert.equal(hit.via, 'port')
  assert.deepEqual(hit.anchor, anchor)
})

test('拖到卡片身上松手也算命中（via=body）—— 用户最直觉的连线方式', () => {
  const hit = hitTestConnectionTarget(nodes, { x: 150, y: 100 }, { scale: 1 })
  assert.equal(hit.nodeId, 'a')
  assert.equal(hit.via, 'body')
  assert.deepEqual(hit.anchor, portAnchor(nodes[0]))
})

test('端口优先于卡片身位：指向端口时不会被上层卡片抢走', () => {
  // b 的端口在 (600,500)；把 a 放到覆盖该点的位置（a 在上层数组末尾）
  const overlapping = [
    { id: 'target', x: 600, y: 400, width: 300, height: 200 },
    { id: 'cover', x: 500, y: 420, width: 300, height: 200 }
  ]
  const hit = hitTestConnectionTarget(overlapping, { x: 600, y: 500 }, { scale: 1 })
  assert.equal(hit.nodeId, 'target')
  assert.equal(hit.via, 'port')
})

test('半径按屏幕像素恒定：缩放 0.25 时世界 100px（屏 25px）仍命中端口', () => {
  const anchor = portAnchor(nodes[1])
  const hit = hitTestConnectionTarget(nodes, { x: anchor.x - 100, y: anchor.y }, { scale: 0.25 })
  assert.equal(hit.nodeId, 'b')
  assert.equal(hit.via, 'port')
  // 同样 100 世界像素在 k=1 下落到卡片外 → 不命中
  assert.equal(hitTestConnectionTarget(nodes, { x: anchor.x - 100, y: anchor.y }, { scale: 1 }).nodeId, null)
})

test('远处既不命中也不接近', () => {
  const hit = hitTestConnectionTarget(nodes, { x: 600, y: -800 }, { scale: 1 })
  assert.equal(hit.nodeId, null)
  assert.equal(hit.isNear, false)
  assert.equal(hit.via, null)
})

test('重叠卡片：卡片身上命中取层级更高（数组靠后）者', () => {
  const stacked = [
    { id: 'low', x: 0, y: 0, width: 300, height: 200 },
    { id: 'high', x: 0, y: 0, width: 300, height: 200 }
  ]
  assert.equal(hitTestConnectionTarget(stacked, { x: 150, y: 100 }, { scale: 1 }).nodeId, 'high')
  assert.equal(hitTestConnectionTarget([stacked[1], stacked[0]], { x: 150, y: 100 }, { scale: 1 }).nodeId, 'low')
})

test('排除源节点自身', () => {
  const hit = hitTestConnectionTarget(nodes, { x: 150, y: 100 }, { scale: 1, excludeId: 'a' })
  assert.equal(hit.nodeId, null)
})

test('自定义半径生效', () => {
  const anchor = portAnchor(nodes[1])
  const at = { x: anchor.x - 30, y: anchor.y }
  assert.equal(hitTestConnectionTarget(nodes, at, { scale: 1, radiusPx: 20 }).nodeId, null, '20px 半径外，但仍在卡片外 → 不命中')
  // 半径不影响卡片身位命中
  assert.equal(hitTestConnectionTarget(nodes, at, { scale: 1, radiusPx: 20 }).via, null)
})

test('吸附：命中目标时端点落到目标锚点，未命中时跟鼠标', () => {
  const world = { x: 610, y: 500 }
  const hit = hitTestConnectionTarget(nodes, world, { scale: 1 })
  const snapped = snapEndpoint(world, hit)
  assert.equal(snapped.snapped, true)
  assert.deepEqual({ x: snapped.x, y: snapped.y }, portAnchor(nodes[1]))
  const miss = snapEndpoint({ x: 20, y: 900 }, { nodeId: null, anchor: null, isNear: false, via: null })
  assert.equal(miss.snapped, false)
  assert.deepEqual({ x: miss.x, y: miss.y }, { x: 20, y: 900 })
})

test('connectionPath 输出三次贝塞尔，短距离保留最小弧度', () => {
  assert.equal(connectionPath({ x: 0, y: 0 }, { x: 200, y: 100 }), 'M 0 0 C 100 0, 100 100, 200 100')
  assert.equal(connectionPath({ x: 0, y: 0 }, { x: 0, y: 100 }), 'M 0 0 C 50 0, -50 100, 0 100')
})

test('源端锚点在右、目标端锚点在左（连线方向：右出左进）', () => {
  const n = { id: 'x', x: 100, y: 200, width: 320, height: 300 }
  assert.deepEqual(sourcePortAnchor(n), { x: 420, y: 350 })
  assert.deepEqual(portAnchor(n), { x: 100, y: 350 })
})
