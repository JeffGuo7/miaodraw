// 图片成本护栏单测：预估价 / 价目缺失兜底 / 预算 fail-closed
// 运行：node --test src/main/image-cost.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FALLBACK_UNIT_PRICE_CNY, checkImageBudget, estimateImageBatch } from './image-cost.ts'

test('预估价：收录模型按单价 × 张数', () => {
  assert.equal(estimateImageBatch('z-image-turbo', 1).cny, 0.1)
  assert.equal(estimateImageBatch('wan2.7-image', 3).cny, 0.6)
  assert.equal(estimateImageBatch('z-image-turbo', 3).priced, true)
})

test('预估价：未收录模型按兜底最高单价，不低估', () => {
  const e = estimateImageBatch('some-new-model', 2)
  assert.equal(e.priced, false)
  assert.equal(e.unitCny, FALLBACK_UNIT_PRICE_CNY)
  assert.equal(e.cny, Math.round(FALLBACK_UNIT_PRICE_CNY * 2 * 100) / 100)
})

test('张数非法时至少按 1 张估（不能因为 n=0 白跑）', () => {
  assert.equal(estimateImageBatch('z-image-turbo', 0).count, 1)
  assert.equal(estimateImageBatch('z-image-turbo', -5).count, 1)
  assert.equal(estimateImageBatch('z-image-turbo', Number.NaN).count, 1)
})

test('预算充足 → 放行并给出剩余', () => {
  const r = checkImageBudget({ model: 'z-image-turbo', count: 2, spentCny: 1, budgetCny: 20 })
  assert.equal(r.ok, true)
  assert.equal(r.estimate.cny, 0.2)
  assert.equal(r.remainingCny, Math.round((20 - 1 - 0.2) * 100) / 100)
})

test('预算不足 → fail-closed（拒绝，不发请求）', () => {
  const r = checkImageBudget({ model: 'wan2.7-image', count: 5, spentCny: 19.5, budgetCny: 20 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BUDGET_EXCEEDED')
  assert.match(r.reason, /预算不足/)
})

test('预算非法（0/负数/NaN）→ 拒绝，不能当成无限预算', () => {
  for (const bad of [0, -1, Number.NaN]) {
    const r = checkImageBudget({ model: 'z-image-turbo', count: 1, spentCny: 0, budgetCny: bad })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BUDGET_INVALID')
  }
})

test('恰好用尽边界：spent + 本次 == budget 应放行', () => {
  const r = checkImageBudget({ model: 'z-image-turbo', count: 2, spentCny: 19.8, budgetCny: 20 })
  assert.equal(r.ok, true)
})
