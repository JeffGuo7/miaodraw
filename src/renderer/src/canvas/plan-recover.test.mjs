// C6 恢复逻辑单测：stale 判定（不许误判）+ 事件缺口判定（该重拉才重拉）
// 运行：node --test src/renderer/src/canvas/plan-recover.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { STALE_MS, isPlanStale, needsFullRefresh } from './plan-recover.ts'

const plan = (status, updated_at) => ({ status, updated_at })
const stage = (status) => ({ status })

test('stale：drafting + 零阶段 + 超过 60s → 命中', () => {
  const now = 1_000_000
  assert.equal(isPlanStale(plan('drafting', now - STALE_MS - 1), [], { now }), true)
  assert.equal(isPlanStale(plan('drafting', now - STALE_MS * 2), [], { now }), true)
})

test('stale：阈值内 / 刚好等于阈值 → 不判（宁可晚判）', () => {
  const now = 1_000_000
  assert.equal(isPlanStale(plan('drafting', now - 1_000), [], { now }), false)
  assert.equal(isPlanStale(plan('drafting', now - STALE_MS), [], { now }), false)
})

test('stale：已有阶段物化 → 有过进展，不判', () => {
  const now = 1_000_000
  assert.equal(isPlanStale(plan('drafting', now - STALE_MS * 5), [stage('waiting_user')], { now }), false)
  assert.equal(isPlanStale(plan('drafting', now - STALE_MS * 5), [stage('done')], { now }), false)
})

test('stale：非 drafting 状态永不判（running/done/blocked/cancelled）', () => {
  const now = 1_000_000
  for (const st of ['running', 'done', 'blocked', 'cancelled']) {
    assert.equal(isPlanStale(plan(st, now - STALE_MS * 9), [], { now }), false, `误判：${st}`)
  }
})

test('stale：主进程报「仍在跑」(inflight) → 绝不判 stale', () => {
  const now = 1_000_000
  assert.equal(isPlanStale(plan('drafting', now - STALE_MS * 9), [], { now, inflight: true }), false)
})

test('stale：缺时间戳 / 空计划 → 不判', () => {
  assert.equal(isPlanStale(null, [], { now: 1 }), false)
  assert.equal(isPlanStale(undefined, undefined, { now: 1 }), false)
  assert.equal(isPlanStale(plan('drafting', 0), [], { now: 9_999_999 }), false)
  assert.equal(isPlanStale(plan('drafting', Number.NaN), [], { now: 9_999_999 }), false)
})

test('needsFullRefresh：revision 跳变（中间事件丢了）→ 重拉', () => {
  assert.equal(needsFullRefresh(3, { revision: 5, stages: [] }), true)
  assert.equal(needsFullRefresh(3, { revision: 9, stages: [] }), true)
})

test('needsFullRefresh：连续 revision → 正常应用，不重拉', () => {
  assert.equal(needsFullRefresh(3, { revision: 4, stages: [] }), false)
  assert.equal(needsFullRefresh(3, { revision: 3, stages: [] }), false)
})

test('needsFullRefresh：快照缺 stages（纯增量事件）→ 重拉', () => {
  assert.equal(needsFullRefresh(3, { revision: 4 }), true)
  assert.equal(needsFullRefresh(3, { revision: 4, stages: null }), true)
  assert.equal(needsFullRefresh(3, { revision: 4, stages: {} }), true)
})

test('needsFullRefresh：首次事件（prev=null）不重拉；脏数据一律重拉', () => {
  assert.equal(needsFullRefresh(null, { revision: 7, stages: [] }), false)
  assert.equal(needsFullRefresh(3, undefined), true)
  assert.equal(needsFullRefresh(3, null), true)
  assert.equal(needsFullRefresh(3, { stages: [] }), true)
  assert.equal(needsFullRefresh(3, { revision: 'x', stages: [] }), true)
})

// 回归：plan:changed 推的是 { plan, stages }，漏读 plan.revision 会让「每个事件都被当成缺口」→ 每次都白跑一趟全量重拉
test('needsFullRefresh：真实快照形态 { plan, stages } 必须按 plan.revision 判定', () => {
  const snap = (revision) => ({ plan: { revision }, stages: [{ id: 's1', status: 'doing' }] })
  assert.equal(needsFullRefresh(3, snap(4)), false, '连续 revision 被误判为缺口')
  assert.equal(needsFullRefresh(3, snap(3)), false)
  assert.equal(needsFullRefresh(3, snap(5)), true, '真缺口必须重拉')
  assert.equal(needsFullRefresh(null, snap(9)), false)
})
