// 图片落盘命名单测：同毫秒不覆盖 + 真实格式扩展名
// 运行：node --test src/main/persist-image.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeImageFileName, sniffImageExt } from './image-file.ts'

test('同毫秒多张图文件名必须互不相同（组图不互相覆盖）', () => {
  const t = 1730000000000
  const names = [1, 2, 3, 4, 5].map((seq) => makeImageFileName(t, seq, 'png'))
  assert.equal(new Set(names).size, names.length)
  assert.match(names[0], /^image_1730000000000_[0-9a-z]+\.png$/)
})

test('跨毫秒/跨序号都不重复', () => {
  assert.notEqual(makeImageFileName(1, 1, 'png'), makeImageFileName(1, 2, 'png'))
  assert.notEqual(makeImageFileName(1, 1, 'png'), makeImageFileName(2, 1, 'png'))
})

test('扩展名按真实字节头推断，不能一律当 png', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(sniffImageExt(png), 'png')
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  assert.equal(sniffImageExt(jpg), 'jpg')
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
  assert.equal(sniffImageExt(webp), 'webp')
  const gif = Buffer.from('GIF89a', 'ascii')
  assert.equal(sniffImageExt(gif), 'gif')
  assert.equal(sniffImageExt(Buffer.from([1, 2, 3])), 'png', '无法识别时兜底 png')
  assert.equal(sniffImageExt(Buffer.alloc(0)), 'png')
})
