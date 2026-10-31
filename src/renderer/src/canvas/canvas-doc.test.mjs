// 画布文档序列化/反序列化单测
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CANVAS_DOC_SCHEMA,
  MAX_INLINE_CONTENT_CHARS,
  deserializeCanvasDocument,
  isCanvasDocumentEmpty,
  serializeCanvasDocument
} from './canvas-doc.ts'

const viewport = { x: 12, y: 34, k: 1.25 }
const doc = (nodes, connections = []) => ({ nodes, connections, viewport })

test('序列化：保留文档字段、剔除瞬态字段', () => {
  const raw = serializeCanvasDocument(
    doc([
      {
        id: 'n1',
        type: 'image',
        x: 10,
        y: 20,
        width: 320,
        height: 240,
        zIndex: 3,
        metadata: { content: 'media://cvs/a.png', prompt: 'x', running: true, progress: 0.5, status: '排队中', failCount: 2 }
      }
    ]),
    1234
  )
  assert.equal(raw.schema_version, CANVAS_DOC_SCHEMA)
  assert.equal(raw.updated_at, 1234)
  const meta = raw.nodes[0].metadata
  assert.equal(meta.running, undefined)
  assert.equal(meta.progress, undefined)
  assert.equal(meta.status, undefined)
  assert.equal(meta.failCount, undefined)
  assert.equal(meta.content, 'media://cvs/a.png')
})

test('序列化：超限 data URL 被丢弃但节点保留', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(MAX_INLINE_CONTENT_CHARS)
  const raw = serializeCanvasDocument(
    doc([{ id: 'n1', type: 'image', x: 0, y: 0, width: 320, height: 320, zIndex: 1, metadata: { content: big } }]),
    1
  )
  assert.equal(raw.nodes.length, 1)
  assert.equal(raw.nodes[0].metadata.content, '')
  assert.equal(raw.nodes[0].metadata.contentDropped, true)
})

test('反序列化：坏行逐条丢弃，好的保留', () => {
  const parsed = deserializeCanvasDocument({
    schema_version: 1,
    nodes: [
      { id: 'ok', type: 'text', x: 0, y: 0, width: 260, height: 120, metadata: { content: 'hi' }, zIndex: 1 },
      { id: 'ok', type: 'text', x: 0, y: 0, width: 260, height: 120 }, // 重复 id
      { id: 'bad-type', type: 'unknown', x: 0, y: 0, width: 100, height: 100 },
      { id: 'bad-pos', type: 'text', x: Number.NaN, y: 0, width: 100, height: 100 },
      { type: 'text', x: 0, y: 0, width: 100, height: 100 } // 缺 id
    ],
    connections: [
      { id: 'c1', from: 'ok', to: 'missing' },
      { id: 'c2', from: 'ok', to: 'ok' }
    ],
    viewport: { x: 1, y: 2, k: 99 }
  })
  assert.equal(parsed.nodes.length, 1)
  assert.equal(parsed.nodes[0].id, 'ok')
  assert.equal(parsed.connections.length, 0, '悬空/自连的连线都要丢掉')
  assert.equal(parsed.viewport.k, 5, '缩放要夹到 0.05~5')
})

test('反序列化：尺寸被夹到合理区间', () => {
  const parsed = deserializeCanvasDocument({
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 99999, metadata: {} }]
  })
  assert.equal(parsed.nodes[0].width, 80)
  assert.equal(parsed.nodes[0].height, 4000)
})

test('反序列化：整体坏数据返回 null（不打挂画布）', () => {
  assert.equal(deserializeCanvasDocument(null), null)
  assert.equal(deserializeCanvasDocument({}), null)
  assert.equal(deserializeCanvasDocument({ nodes: 'nope' }), null)
})

test('空文档判定', () => {
  assert.equal(isCanvasDocumentEmpty(doc([])), true)
  assert.equal(
    isCanvasDocumentEmpty(doc([{ id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 100, zIndex: 1, metadata: {} }])),
    false
  )
})
