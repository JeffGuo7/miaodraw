// V1 主链纯函数单测（零成本）：分镜解析/校验 + TTS 与 ffmpeg 构造 + 阶段作业规划
// 运行：node --test src/main/video/pipeline.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildScriptPrompt, extractJson, parseScript, shotImagePrompt } from './script.ts'
import {
  TTS_MODEL,
  buildComposeArgs,
  buildConcatList,
  buildProbeArgs,
  buildTtsBody,
  buildTtsUrl,
  dimensions,
  distributeByAudio,
  estimateSpeechSeconds,
  parseProbeDuration,
  parseTtsResponse
} from './media.ts'
import { planStageJobs } from './planning.ts'

const GOOD_LLM = '```json\n{"title":"秋日茶事","shots":[{"narration":"秋天的午后","image_prompt":"暖色窗边，木桌上的一杯热茶，柔和侧光"},{"narration":"水汽慢慢升起","image_prompt":"特写茶面水汽，浅景深，暖黄调"}]}\n```'

test('分镜解析：容忍 ```json 围栏，取 title/shots 且序号从 1 起', () => {
  const r = parseScript(GOOD_LLM, { shotCount: 2, shotSeconds: 3 })
  assert.equal(r.title, '秋日茶事')
  assert.equal(r.shots.length, 2)
  assert.equal(r.shots[1].index, 2)
  assert.equal(r.narration, '秋天的午后水汽慢慢升起')
  assert.equal(r.issues.length, 0)
})

test('分镜解析：模型不吐 JSON → 文本兜底切分并记账（流程不断）', () => {
  const r = parseScript('第一句口播。第二句口播！第三句口播？', { shotCount: 3 })
  assert.equal(r.shots.length, 3)
  assert.ok(r.issues.some((i) => i.includes('兜底')))
  assert.ok(r.shots[0].image_prompt.length > 0, '画面提示词不得为空')
  assert.ok(r.shots[0].image_prompt.startsWith('第一句口播'))
})

test('分镜解析：黑名单/密度超预算必须被记账（P0 文案检查卡）', () => {
  const bad = JSON.stringify({
    title: 'x',
    shots: [
      { narration: '震惊！所有人都在用的速成秘籍，三天学会', image_prompt: 'a' },
      { narration: '绝对有效，第一，第二，第三，第四，第五，第六，第七，第八，第九，第十', image_prompt: 'b' }
    ]
  })
  const r = parseScript(bad, { shotCount: 2, shotSeconds: 3 })
  assert.ok(r.blacklistHits.length >= 1)
  assert.ok(r.issues.some((i) => i.includes('黑名单')))
  assert.ok(r.issues.some((i) => i.includes('密度')))
})

test('脚本 prompt：口播预算写进硬约束；给了上屏文字才允许出现文字', () => {
  const p = buildScriptPrompt('帮我做一条茶叶短视频', { shotCount: 4, shotSeconds: 3 })
  assert.ok(p.includes('12 秒') === false, '不写总时长，写每镜头时长')
  assert.ok(/字数控制在 \d+-\d+ 字/.test(p))
  assert.ok(p.includes('画面内不要出现任何文字'))
  const p2 = buildScriptPrompt('茶叶', { onScreenText: '春水煎茶' })
  assert.ok(p2.includes('春水煎茶'))
  assert.ok(p2.includes('不得新增品牌名/电话/邮箱/价格/承诺'))
})

test('extractJson：从废话+围栏里也能取到 JSON；坏输入返回 null', () => {
  assert.deepEqual(extractJson('先说明一下\n```json\n{"a":1}\n```\n谢谢'), { a: 1 })
  assert.equal(extractJson(''), null)
  assert.equal(extractJson('没有 JSON'), null)
})

test('画面提示词：尾部只追加确定性增强，没有上屏文字就明确不出现文字', () => {
  const p = shotImagePrompt({ index: 1, narration: 'n', image_prompt: '窗边热茶' }, { ratio: '9:16' })
  assert.ok(p.startsWith('窗边热茶'))
  assert.ok(p.includes('画幅 9:16'))
  assert.ok(p.includes('不出现任何文字'))
  assert.ok(shotImagePrompt({ index: 1, narration: 'n', image_prompt: 'x' }, { onScreenText: '春水煎茶' }).includes('仅限：「春水煎茶」'))
})

test('TTS：请求体与 URL 对齐实测规格（qwen3-tts-flash / Cherry）', () => {
  const body = buildTtsBody('  秋天的午后  ')
  assert.deepEqual(body, { model: TTS_MODEL, input: { text: '秋天的午后', voice: 'Cherry' } })
  assert.equal(buildTtsUrl('https://x.maas.aliyuncs.com/'), 'https://x.maas.aliyuncs.com/services/aigc/multimodal-generation/generation')
})

test('TTS 响应解析：容忍 audio.url / output.audio_url / choices[].message.content[].audio', () => {
  assert.equal(parseTtsResponse({ output: { audio: { url: 'https://a/x.mp3' } }, request_id: 'r1' }).audioUrl, 'https://a/x.mp3')
  assert.equal(parseTtsResponse({ output: { audio_url: 'https://a/y.wav' } }).audioUrl, 'https://a/y.wav')
  assert.equal(parseTtsResponse({ output: { choices: [{ message: { content: [{ audio: 'https://a/z.mp3' }] } }] } }).audioUrl, 'https://a/z.mp3')
  assert.equal(parseTtsResponse({}).audioUrl, '')
})

test('口播时长估算：中文 3.5 字/秒（驱动帧时长用）', () => {
  assert.equal(estimateSpeechSeconds('一二三四五六七'), 2)
  assert.equal(estimateSpeechSeconds(''), 1)
})

test('ffmpeg 参数：图片序列 + 音轨 → h264/aac mp4；静音时显式 -an', () => {
  const args = buildComposeArgs({ images: ['a.png'], audio: 'v.mp3', outPath: 'out.mp4', ratio: '9:16', resolution: '720P' }, { listFile: 'list.txt' })
  assert.deepEqual(args.slice(0, 5), ['-y', '-f', 'concat', '-safe', '0'])
  assert.ok(args.includes('aac') && args.includes('libx264') && args.includes('+faststart'))
  assert.ok(args.join(' ').includes('scale=720:1280'))
  const silent = buildComposeArgs({ images: ['a.png'], outPath: 'o.mp4' }, { listFile: 'l.txt' })
  assert.ok(silent.includes('-an'))
})

test('画幅/分辨率 → 尺寸；concat 清单语义（末帧重复）', () => {
  assert.deepEqual(dimensions('9:16', '720P'), { w: 720, h: 1280 })
  assert.deepEqual(dimensions('16:9', '1080P'), { w: 1920, h: 1080 })
  assert.deepEqual(dimensions('1:1', '720P'), { w: 720, h: 720 })
  const list = buildConcatList(['C:/a/1.png', 'C:/a/2.png'], 3)
  assert.equal(list.split('\n').filter((l) => l.startsWith('file ')).length, 3, '末尾要重复最后一张')
  assert.equal(list.split('\n').filter((l) => l.startsWith('duration ')).length, 2)
})

test('ffprobe：参数与时长解析；音频时长驱动镜头时长', () => {
  assert.deepEqual(buildProbeArgs('x.mp3').slice(0, 2), ['-v', 'error'])
  assert.equal(parseProbeDuration('12.34\n'), 12.34)
  assert.equal(parseProbeDuration('N/A'), 0)
  assert.equal(distributeByAudio(12, 4), 3)
  assert.equal(distributeByAudio(0, 4), 3, '没音频时用默认 3 秒')
  assert.equal(distributeByAudio(10, 3), 3.33)
})

test('阶段规划：N 镜头 → N 图 job + tts + compose，成本按价目表算', () => {
  const plan = planStageJobs({
    planId: 'p1',
    stageId: 'st_shots',
    revision: 4,
    narration: '一二三四五六七八九十',
    shots: [
      { workItemId: 's1', imagePrompt: 'a' },
      { workItemId: 's2', imagePrompt: 'b' }
    ]
  })
  assert.equal(plan.shotCount, 2)
  assert.deepEqual(plan.jobs.map((j) => j.kind), ['image', 'image', 'tts', 'compose'])
  assert.deepEqual(plan.jobs.map((j) => j.id), ['p1|st_shots|s1', 'p1|st_shots|s2', 'p1|st_shots|tts', 'p1|st_shots|compose'])
  assert.equal(plan.jobs[0].paid, true)
  assert.equal(plan.jobs[2].paid, true, 'TTS 付费')
  assert.equal(plan.jobs[3].paid, false, '本地合成不付费')
  // 2×¥0.1 图 + 10 字 TTS（0.0002，round2 归零）+ 合成 0 → ¥0.2
  assert.equal(plan.estimate.expectCny, 0.2)
  assert.equal(plan.estimate.unpriced, false)
  assert.deepEqual(plan.modelMix.sort(), ['qwen3-tts-flash', 'z-image-turbo'])
})

test('阶段规划：需离屏帧时加 frame job（不付费），可关掉 tts/compose', () => {
  const plan = planStageJobs({
    planId: 'p1',
    stageId: 'st2',
    revision: 1,
    narration: 'x',
    shots: [{ workItemId: 's1', imagePrompt: 'a' }],
    needsFrames: true,
    withTts: false,
    withCompose: false
  })
  assert.deepEqual(plan.jobs.map((j) => j.kind), ['image', 'frame'])
  assert.equal(plan.items.some((i) => i.kind === 'frame' && i.price_key === 'local-frame'), true)
  assert.equal(plan.estimate.expectCny, 0.1)
})

test('阶段规划幂等：同输入两次规划的 job key 完全一致（重复规划不产生新作业）', () => {
  const input = { planId: 'p1', stageId: 'st', revision: 1, narration: 'n', shots: [{ workItemId: 'a', imagePrompt: 'x' }] }
  const a = planStageJobs(input, 1000)
  const b = planStageJobs(input, 2000)
  assert.deepEqual(a.jobs.map((j) => j.id), b.jobs.map((j) => j.id))
  assert.equal(a.jobs[0].request_id, b.jobs[0].request_id, '付费提交幂等键也必须一致')
})
