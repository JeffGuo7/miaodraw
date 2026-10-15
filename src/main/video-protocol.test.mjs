// V1 百炼视频协议单测（零成本）：请求构造 / 状态映射 / URL 校验 / 预估价 / 成本护栏
// 运行：node --test src/main/video-protocol.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_VIDEO_SPEC,
  MAX_AUTO_RETRY,
  VIDEO_MAX_BYTES,
  afterFailure,
  buildVideoLineage,
  buildVideoSubmitBody,
  buildVideoSubmitUrl,
  buildVideoTaskUrl,
  canAutoRetry,
  estimateVideoCost,
  mapTaskStatus,
  normalizeVideoSpec,
  pollDelayMs,
  progressOf,
  truncatePrompt,
  validateVideoUrl,
  withinSizeCap
} from './video-protocol.ts'

const ORIGIN = 'https://llm-9c9i0r44qlve2ehv.cn-beijing.maas.aliyuncs.com'

test('默认档 = 红线档：2 秒 / 720P / 关 prompt_extend', () => {
  assert.equal(DEFAULT_VIDEO_SPEC.duration, 2)
  assert.equal(DEFAULT_VIDEO_SPEC.resolution, '720P')
  assert.equal(DEFAULT_VIDEO_SPEC.promptExtend, false)
  const spec = normalizeVideoSpec({ prompt: ' 一杯咖啡的清晨 ' })
  assert.deepEqual(spec, { prompt: '一杯咖啡的清晨', ...DEFAULT_VIDEO_SPEC, negative: undefined })
})

test('归一化：非法输入一律回落到更便宜档，绝不放大参数', () => {
  const s = normalizeVideoSpec({ prompt: 'x', duration: 7, resolution: '4K', ratio: '21:9', model: 'wan9.9', promptExtend: 'yes' })
  assert.equal(s.duration, 10, '7 秒向上取最近合法档')
  assert.equal(s.resolution, '720P')
  assert.equal(s.ratio, '16:9')
  assert.equal(s.model, 'wan2.7-t2v')
  assert.equal(s.promptExtend, false, '非严格 true 不许开')
  assert.equal(normalizeVideoSpec({ prompt: 'x', duration: -3 }).duration, 2)
  assert.equal(normalizeVideoSpec({ prompt: 'x', duration: 1 }).duration, 2)
})

test('提示词超长截断（不因超限被接口拒）', () => {
  assert.equal(truncatePrompt('  a\n\n b '.repeat(1)), 'a b')
  const long = 'x'.repeat(2000)
  assert.equal(truncatePrompt(long).length, 800)
  assert.ok(truncatePrompt(long).endsWith('…'))
})

test('URL 构造：提交与任务轮询都落在 /api/v1，且容忍尾部斜杠', () => {
  assert.equal(buildVideoSubmitUrl(ORIGIN), `${ORIGIN}/api/v1/services/aigc/video-generation/video-synthesis`)
  assert.equal(buildVideoSubmitUrl(`${ORIGIN}/`), `${ORIGIN}/api/v1/services/aigc/video-generation/video-synthesis`)
  assert.equal(buildVideoTaskUrl(ORIGIN, 'abc-123'), `${ORIGIN}/api/v1/tasks/abc-123`)
})

test('提交体严格照实测规格（含默认关 prompt_extend）', () => {
  const spec = normalizeVideoSpec({ prompt: '海边的清晨', duration: 2 })
  const body = buildVideoSubmitBody(spec)
  assert.deepEqual(body, {
    model: 'wan2.7-t2v',
    input: { prompt: '海边的清晨' },
    parameters: { resolution: '720P', ratio: '16:9', duration: 2, prompt_extend: false }
  })
  const withNeg = buildVideoSubmitBody(normalizeVideoSpec({ prompt: 'x', negative: '模糊' }))
  assert.equal(withNeg.input.negative_prompt, '模糊')
})

test('任务状态映射：PENDING/RUNNING/SUCCEEDED/FAILED + 取 video_url', () => {
  assert.equal(mapTaskStatus({ output: { task_status: 'PENDING', task_id: 't1' } }).state, 'pending')
  assert.equal(mapTaskStatus({ output: { task_status: 'RUNNING', task_id: 't1' } }).state, 'running')
  const ok = mapTaskStatus({ output: { task_status: 'SUCCEEDED', task_id: 't1', video_url: 'https://x.aliyuncs.com/a.mp4' } })
  assert.equal(ok.state, 'succeeded')
  assert.equal(ok.videoUrl, 'https://x.aliyuncs.com/a.mp4')
  assert.equal(ok.fatal, false)
  const bad = mapTaskStatus({ output: { task_status: 'FAILED', task_id: 't1', code: 'InvalidParameter', message: 'bad prompt' } })
  assert.equal(bad.state, 'failed')
  assert.equal(bad.code, 'InvalidParameter')
  assert.equal(bad.fatal, true, 'task 不存在/参数错要立刻失败，不轮询到超时')
  const noStatus = mapTaskStatus({ code: 'InvalidApiKey', message: 'nope' })
  assert.equal(noStatus.state, 'failed')
  assert.equal(noStatus.fatal, true)
  assert.equal(mapTaskStatus({}).state, 'pending', '空体不误判失败')
})

test('状态 → 进度 / 轮询节奏', () => {
  assert.equal(progressOf('pending'), 0.05)
  assert.equal(progressOf('running'), 0.6)
  assert.equal(progressOf('succeeded'), 1)
  assert.equal(progressOf('failed'), 0)
  assert.equal(pollDelayMs(0), 3000)
  assert.equal(pollDelayMs(19), 3000)
  assert.equal(pollDelayMs(20), 5000)
})

test('下载 URL 校验：必须 https 且域名在白名单', () => {
  assert.equal(validateVideoUrl('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.mp4').ok, true)
  assert.equal(validateVideoUrl('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.mp4').ok, false)
  assert.equal(validateVideoUrl('https://evil.example.com/x.mp4').ok, false)
  assert.equal(validateVideoUrl('https://127.0.0.1/x.mp4').ok, false)
  assert.equal(validateVideoUrl('https://localhost/x.mp4').ok, false)
  assert.equal(validateVideoUrl('file:///c:/x.mp4').ok, false)
  assert.equal(validateVideoUrl('not-a-url').ok, false)
  assert.equal(validateVideoUrl('').ok, false)
})

test('体积上限保护', () => {
  assert.equal(withinSizeCap(4.5 * 1024 * 1024), true)
  assert.equal(withinSizeCap(VIDEO_MAX_BYTES + 1), false)
  assert.equal(withinSizeCap(0), true, '拿不到长度时先放行，边下边数')
})

test('预估价：2 秒 720P ≈ ¥1.2，且标注未核实', () => {
  const e = estimateVideoCost(normalizeVideoSpec({ prompt: 'x', duration: 2 }))
  assert.equal(e.cny, 1.2)
  assert.equal(e.verified, false)
  assert.ok(e.note.includes('以百炼账单为准'))
  assert.equal(estimateVideoCost(normalizeVideoSpec({ prompt: 'x', duration: 5, resolution: '1080P' })).cny, 6)
  assert.equal(estimateVideoCost(normalizeVideoSpec({ prompt: 'x', duration: 2, resolution: '720P', promptExtend: true })).note.includes('prompt_extend'), true)
})

test('成本护栏：同一节点连续失败 2 次后停止自动重试', () => {
  let failures = 0
  assert.equal(canAutoRetry(failures), true)
  failures = afterFailure(failures)
  assert.equal(canAutoRetry(failures), true)
  failures = afterFailure(failures)
  assert.equal(failures, MAX_AUTO_RETRY)
  assert.equal(canAutoRetry(failures), false, '第 2 次失败后必须人工再点')
  assert.equal(afterFailure(-5), 1)
})

test('血统边：只对已入库父产物建边（role=derived, operation=bailian-video）', () => {
  const edges = buildVideoLineage(
    'child1',
    [{ assetId: 'p1' }, { assetId: undefined }, { assetId: 'p2' }],
    { model: 'wan2.7-t2v', duration: 2 },
    1700000000000
  )
  assert.equal(edges.length, 2, '未入库的连线不算父产物')
  assert.deepEqual(
    edges.map((e) => [e.child_id, e.parent_id, e.role, e.operation, e.input_index]),
    [
      ['child1', 'p1', 'derived', 'bailian-video', null],
      ['child1', 'p2', 'derived', 'bailian-video', null]
    ]
  )
  assert.deepEqual(JSON.parse(edges[0].metadata), { source: 'bailian-video', model: 'wan2.7-t2v', duration_sec: 2 })
})

test('血统边：没有父产物（纯文生视频）→ 不产生任何边', () => {
  assert.deepEqual(buildVideoLineage('c', [], { model: 'wan2.7-t2v', duration: 2 }, 1), [])
  assert.deepEqual(buildVideoLineage('c', [{ assetId: undefined }], { model: 'wan2.7-t2v', duration: 2 }, 1), [])
})

test('硬上限：10 秒 1080P 预估价 ¥12 会被判 overCap（fail-closed）', () => {
  const e = estimateVideoCost(normalizeVideoSpec({ prompt: 'x', duration: 10, resolution: '1080P' }))
  assert.equal(e.cny, 12)
  assert.equal(e.overCap, true)
  assert.equal(estimateVideoCost(normalizeVideoSpec({ prompt: 'x', duration: 2, resolution: '720P' })).overCap, false)
})
