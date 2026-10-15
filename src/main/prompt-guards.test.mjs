// 提示词质量层单测（P0）
// 运行：node --test src/main/prompt-guards.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  auditPlannedPrompt,
  buildImagePrompt,
  checkPhrasePreservation,
  checkVoBlacklist,
  checkVoDensity,
  qcImagePrompt,
  scanFabrications,
  vendorCardFor
} from './prompt-guards.ts'

test('QC：正文否定式清单被识别', () => {
  const r = qcImagePrompt('干净背景，不要文字，没有人物，禁止logo，Medium: 扁平插画，9:16')
  assert.ok(r.some((f) => f.id === 'constraint-negation'))
})

test('QC：抽象氛围词缺可见杠杆被识别', () => {
  const r = qcImagePrompt('高级感，治愈系，Medium: 摄影，9:16')
  assert.ok(r.some((f) => f.id === 'abstract-mood'))
  const ok = qcImagePrompt('高级感，侧逆光勾边，主色墨绿 60-70%，哑光宣纸质感，Medium: 摄影，9:16')
  assert.equal(ok.some((f) => f.id === 'abstract-mood'), false)
})

test('QC：缺媒介/缺比例/需要文字却没引号文案', () => {
  const r = qcImagePrompt('一只猫', { needsText: true })
  const ids = r.map((f) => f.id)
  assert.ok(ids.includes('medium-drift'))
  assert.ok(ids.includes('aspect-missing'))
  assert.ok(ids.includes('on-image-text'))
})

test('QC：有参考图但没写引用角色', () => {
  const r = qcImagePrompt('融合一下，Medium: 插画，9:16', { hasRefs: true })
  assert.ok(r.some((f) => f.id === 'ref-role-missing'))
  const ok = qcImagePrompt('以图1为主体，图2只提供配色，Medium: 插画，9:16', { hasRefs: true })
  assert.equal(ok.some((f) => f.id === 'ref-role-missing'), false)
})

test('厂商卡：wan2.7-image=9 / qwen-image-3=3 / z-image-turbo=1，前缀不互相抢', () => {
  assert.equal(vendorCardFor('wan2.7-image').maxRefs, 9)
  assert.equal(vendorCardFor('qwen-image-3.0-pro').maxRefs, 3)
  assert.equal(vendorCardFor('qwen-image-3.0-pro').name, 'Qwen-Image 3.x')
  assert.equal(vendorCardFor('z-image-turbo').maxRefs, 1)
  assert.equal(vendorCardFor('gpt-image-1').maxRefs, 16)
  assert.equal(vendorCardFor('kling-v3').maxRefs, 1)
})

test('海报配方：保留用户原句序，尾部只追加确定性增强', () => {
  const brief = '新中式茶馆春季招募，可以加点暖色，要醒目点'
  const p = buildImagePrompt(brief, {
    size: '1080x1920',
    medium: '平面设计海报',
    palette: { main: '茶汤琥珀', accent: '宣纸米白', highlight: '金色描边' },
    layout: '信息阶梯',
    onImageText: ['春水煎茶', '招募茶艺师']
  })
  assert.ok(p.startsWith(brief), '必须原句开头')
  assert.match(p, /Medium: 平面设计海报/)
  assert.match(p, /主色茶汤琥珀约 60-70%/)
  assert.match(p, /画内文字仅限：「春水煎茶」、「招募茶艺师」/)
  assert.match(p, /不得新增或改写/)
  // 未给文案时：不编造，声明留白
  const noText = buildImagePrompt('咖啡店海报', { size: '9:16' })
  assert.match(noText, /不出现可读文字/)
})

test('编造检测：A/B 反例（品牌名/电话/邮箱/地址/五险一金）全部命中', () => {
  const userText = '新中式茶馆春季招募海报，主标题写「春水煎茶」，副标题「招募茶艺师」'
  const aiDraft = '隐山·茶事 招聘：联系电话 010-8888-6666，邮箱 hr@yinshan.com，地址 杭州西湖区龙井路 18 号，五险一金，月薪 8000 元'
  const hits = scanFabrications(aiDraft, userText)
  const kinds = hits.map((h) => h.kind)
  assert.ok(kinds.includes('电话'))
  assert.ok(kinds.includes('邮箱'))
  assert.ok(kinds.includes('地址'))
  assert.ok(kinds.includes('价格') || kinds.includes('福利承诺'))
  // 用户自己给过的不算编造
  assert.equal(scanFabrications('联系电话 010-8888-6666', '联系电话 010-8888-6666').length, 0)
})

test('原句保真：用户指定文案被模型改写 → 检出缺失', () => {
  const userText = '主标题「春水煎茶」，副标题「招募茶艺师」'
  const modelOutput = '主标题「春水初生」，副标题「招贤纳士」'
  const r = checkPhrasePreservation(userText, modelOutput)
  assert.ok(r.missing.includes('春水煎茶'))
  assert.ok(r.missing.includes('招募茶艺师'))
  assert.equal(checkPhrasePreservation(userText, '画面主标题「春水煎茶」，下方「招募茶艺师」').missing.length, 0)
})

test('文案黑名单：震惊体/喊话体/套版开场/绝对化命中', () => {
  assert.deepEqual(checkVoBlacklist('震惊！99%的人不知道的秘诀').map((h) => h.kind).sort(), ['标题党', '震惊体'])
  assert.ok(checkVoBlacklist('别划走，一定要看到最后').some((h) => h.kind === '喊话体'))
  assert.ok(checkVoBlacklist('我闺蜜疯狂安利我一个东西').some((h) => h.kind === '套版开场'))
  assert.ok(checkVoBlacklist('全网最低价，史上最强配方').some((h) => h.kind === '绝对化'))
  assert.equal(checkVoBlacklist('雨天的咖啡馆里，一只戴贝雷帽的柴犬趴在窗边看行人').length, 0)
})

test('台词密度：15 秒中文预算 40-55 字，超预算给删词建议', () => {
  const ok = checkVoDensity('雨天的咖啡馆里，一只戴贝雷帽的柴犬趴在窗边看行人', 15)
  assert.equal(ok.over, false)
  assert.ok(ok.budget.max >= 40 && ok.budget.max <= 55)
  const long = checkVoDensity('春天来了'.repeat(30), 15)
  assert.equal(long.over, true)
  assert.match(long.advice, /删修饰词|拆段/)
})

test('审计入口：编造 + 缺失短语 + 黑名单同时暴露，needsAttention=true', () => {
  const audit = auditPlannedPrompt('主标题「春水初生」，联系电话 010-8888-6666', '主标题「春水煎茶」', { needsText: true })
  assert.equal(audit.needsAttention, true)
  assert.ok(audit.findings.fabrications.length >= 1)
  assert.ok(audit.findings.missingPhrases.includes('春水煎茶'))
})
