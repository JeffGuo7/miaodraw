// 成本护栏 fail-closed 单测（零成本）：预估价 / 价格缺失拒付 / 一次性凭证 / 硬上限 / 记账
// 运行：node --test src/main/video/cost.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CostLedger,
  HARD_CAP_PER_SUBMIT_CNY,
  TOKEN_TTL_MS,
  authorizePaidSubmit,
  checkBudget,
  estimateCost,
  issueConfirmToken,
  paidItemsHash,
  verifyConfirmToken
} from './cost.ts'

const ITEMS = [
  { kind: 'image', price_key: 'z-image-turbo', qty: 5 },
  { kind: 'tts', price_key: 'qwen3-tts-flash', chars: 100 },
  { kind: 'compose', price_key: 'local-compose' }
]

test('预估：5 张 ¥0.1 图 + 100 字 TTS + 本地合成 = ¥0.5 + TTS，且标注未核实', () => {
  const e = estimateCost(ITEMS)
  assert.equal(e.lines.length, 3)
  assert.equal(e.expectCny, 0.5, '5×0.1 + 100/1000×0.02 = 0.1×5 + 0.002 → 0.5（round2）')
  assert.equal(e.unpriced, false)
  assert.equal(e.maxCny, 0.5)
  assert.ok(e.note.includes('账单为准'), '含未核实档位时必须提示')
  assert.equal(e.lines.find((l) => l.price_key === 'local-compose').cny, 0)
})

test('预估：价目缺失 → unpriced，maxCny=null（不许假装算得出来）', () => {
  const e = estimateCost([{ kind: 'video', price_key: 'kling-v9', qty: 1 }])
  assert.equal(e.unpriced, true)
  assert.equal(e.maxCny, null)
  assert.equal(e.expectCny, 0)
  assert.ok(e.note.includes('接受按量计费'))
})

test('付费项指纹：顺序无关、改一项即变（绑定凭证用）', () => {
  const a = paidItemsHash([ITEMS[0], ITEMS[1]])
  const b = paidItemsHash([ITEMS[1], ITEMS[0]])
  assert.equal(a, b)
  const c = paidItemsHash([{ ...ITEMS[0], qty: 6 }, ITEMS[1]])
  assert.notEqual(a, c)
})

test('一次性凭证：签发 → 校验通过并作废 → 重放被拒', () => {
  const hash = paidItemsHash(ITEMS)
  const t = issueConfirmToken({ stageId: 'st1', revision: 3, paidHash: hash, nonce: 'n1', now: 1000 })
  const first = verifyConfirmToken(t, { stageId: 'st1', revision: 3, paidHash: hash }, 1100)
  assert.equal(first.ok, true)
  assert.notEqual(first.token, t, '必须返回已作废的新凭证')
  const replay = verifyConfirmToken(first.token, { stageId: 'st1', revision: 3, paidHash: hash }, 1200)
  assert.equal(replay.ok, false)
  assert.equal(replay.code, 'TOKEN_USED')
})

test('一次性凭证：stage/revision/付费项任一变化 → 失效（计划改了要重新确认）', () => {
  const t = issueConfirmToken({ stageId: 'st1', revision: 3, paidHash: paidItemsHash(ITEMS), nonce: 'n1', now: 1000 })
  assert.equal(verifyConfirmToken(t, { stageId: 'st2', revision: 3, paidHash: t.paid_hash }, 1100).code, 'TOKEN_MISMATCH')
  assert.equal(verifyConfirmToken(t, { stageId: 'st1', revision: 4, paidHash: t.paid_hash }, 1100).code, 'TOKEN_MISMATCH')
  assert.equal(verifyConfirmToken(t, { stageId: 'st1', revision: 3, paidHash: 'other' }, 1100).code, 'TOKEN_MISMATCH')
})

test('一次性凭证：缺凭证 / 过期 → 明确的 gate code（fail-closed）', () => {
  assert.equal(verifyConfirmToken(null, { stageId: 'st1', revision: 1, paidHash: 'x' }, 1).code, 'COST_GATE_REQUIRED')
  const t = issueConfirmToken({ stageId: 'st1', revision: 1, paidHash: 'x', nonce: 'n', now: 1000 })
  assert.equal(verifyConfirmToken(t, { stageId: 'st1', revision: 1, paidHash: 'x' }, 1000 + TOKEN_TTL_MS + 1).code, 'TOKEN_EXPIRED')
})

test('硬上限：预算不足 / 单次超 ¥6 一律拒（不发付费请求的前置条件）', () => {
  const cheap = estimateCost(ITEMS)
  assert.equal(checkBudget({ spentCny: 0, estimate: cheap, budgetCny: 20 }).ok, true)
  const poor = checkBudget({ spentCny: 19.8, estimate: cheap, budgetCny: 20 })
  assert.equal(poor.ok, false)
  assert.equal(poor.code, 'BUDGET_EXCEEDED')
  assert.ok(poor.reason.includes('剩余'))

  // 10 秒 720P = ¥6.00：不超（边界）；12 秒 = ¥7.2：超单次硬上限
  const six = estimateCost([{ kind: 'video', price_key: 'wan2.7-t2v@720P', seconds: 10 }])
  assert.equal(six.expectCny, 6)
  assert.equal(checkBudget({ spentCny: 0, estimate: six, budgetCny: 100 }).ok, true)
  const over = estimateCost([{ kind: 'video', price_key: 'wan2.7-t2v@720P', seconds: 12 }])
  assert.equal(over.expectCny, 7.2)
  const r = checkBudget({ spentCny: 0, estimate: over, budgetCny: 100 })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes(String(HARD_CAP_PER_SUBMIT_CNY.toFixed(2))))
})

test('价格缺失 fail-closed：默认拒付，显式接受按量计费后才放行', () => {
  const unknown = estimateCost([{ kind: 'video', price_key: 'kling-v9' }])
  const denied = checkBudget({ spentCny: 0, estimate: unknown, budgetCny: 20 })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'UNPRICED_REQUIRES_CONSENT')
  assert.equal(checkBudget({ spentCny: 0, estimate: unknown, budgetCny: 20, acceptUnpriced: true }).ok, true)
  const broke = checkBudget({ spentCny: 20, estimate: unknown, budgetCny: 20, acceptUnpriced: true })
  assert.equal(broke.ok, false)
  assert.equal(broke.code, 'BUDGET_EXCEEDED')
})

test('记账：累计花费 / 分阶段 / 幂等 seed（重启后对账不重复计）', () => {
  const ledger = new CostLedger()
  ledger.record({ plan_id: 'p1', stage_id: 's1', job_id: 'j1', kind: 'image', cny: 0.1, at: 1 })
  ledger.record({ plan_id: 'p1', stage_id: 's2', job_id: 'j2', kind: 'video', cny: 1.2, request_id: 'r1', at: 2 })
  ledger.record({ plan_id: 'p2', stage_id: 's1', job_id: 'j3', kind: 'image', cny: 0.2, at: 3 })
  assert.equal(ledger.spentOf('p1'), 1.3)
  assert.deepEqual(ledger.byStage('p1'), { s1: 0.1, s2: 1.2 })
  ledger.seed(ledger.list('p1'))
  assert.equal(ledger.spentOf('p1'), 1.3, 'seed 不得重复计账')
  ledger.seed([{ plan_id: 'p1', stage_id: 's3', job_id: 'j9', kind: 'tts', cny: 0.02, at: 9 }])
  assert.equal(ledger.spentOf('p1'), 1.32, '新条目要合入')
})

test('付费总闸门：无凭证 → COST_GATE_REQUIRED（不发任何付费请求）', () => {
  const r = authorizePaidSubmit({ stageId: 's1', revision: 1, items: ITEMS, spentCny: 0, budgetCny: 20, now: 1000 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'COST_GATE_REQUIRED')
  assert.equal(r.estimate.expectCny, 0.5, '拒绝时也要回预估，便于 UI 提示')
})

test('付费总闸门：预算不足 / 超单次硬上限 → 先于凭证被拒', () => {
  const token = issueConfirmToken({ stageId: 's1', revision: 1, paidHash: paidItemsHash(ITEMS), nonce: 'n', now: 1000 })
  const poor = authorizePaidSubmit({ stageId: 's1', revision: 1, items: ITEMS, token, spentCny: 19.9, budgetCny: 20, now: 1001 })
  assert.equal(poor.code, 'BUDGET_EXCEEDED')
  const big = authorizePaidSubmit({
    stageId: 's1',
    revision: 1,
    items: [{ kind: 'video', price_key: 'wan2.7-t2v@720P', seconds: 12 }],
    token: issueConfirmToken({ stageId: 's1', revision: 1, paidHash: paidItemsHash([{ kind: 'video', price_key: 'wan2.7-t2v@720P', seconds: 12 }]), nonce: 'n', now: 1000 }),
    spentCny: 0,
    budgetCny: 100,
    now: 1001
  })
  assert.equal(big.code, 'BUDGET_EXCEEDED')
})

test('付费总闸门：凭证正确 → 通过并作废；重放/换 revision → 拒绝', () => {
  const hash = paidItemsHash(ITEMS)
  const token = issueConfirmToken({ stageId: 's1', revision: 7, paidHash: hash, nonce: 'n', now: 1000 })
  const ok = authorizePaidSubmit({ stageId: 's1', revision: 7, items: ITEMS, token, spentCny: 0, budgetCny: 20, now: 1001 })
  assert.equal(ok.ok, true)
  assert.equal(ok.token.used, true)
  const replay = authorizePaidSubmit({ stageId: 's1', revision: 7, items: ITEMS, token: ok.token, spentCny: 0.5, budgetCny: 20, now: 1002 })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, 'TOKEN_USED')
  const drifted = authorizePaidSubmit({ stageId: 's1', revision: 8, items: ITEMS, token, spentCny: 0, budgetCny: 20, now: 1003 })
  assert.equal(drifted.code, 'TOKEN_MISMATCH')
})
