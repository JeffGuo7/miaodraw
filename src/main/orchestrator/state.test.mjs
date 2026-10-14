// 编排状态机单测（O1 验收项：状态机覆盖，含 retry/conflict）
// 运行：node --test src/main/orchestrator/state.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyAction, assertNoPlaceholders, derivePlanStatus, nextStageToAuthor, setWorkItemOutput } from './state.ts'

function stage(over = {}) {
  return {
    id: 's1',
    plan_id: 'p1',
    order: 1,
    name: '出图',
    goal: '出图',
    status: 'pending',
    waiting_reason: null,
    depends_on: [],
    execution_locks: {},
    review: { before_execution: [], after_execution: [] },
    work_items: [{ id: 'w1', name: '主图', modality: 'image', refs: [], prompt: 'p' }],
    revision: 1,
    updated_at: 0,
    ...over
  }
}

function plan(outlineCount = 2) {
  return {
    id: 'p1',
    title: 'x',
    prompt: '需要一张图',
    workflow_id: 'single-image',
    status: 'drafting',
    revision: 1,
    stage_outline: Array.from({ length: outlineCount }, (_, i) => ({ id: `s${i + 1}`, order: i + 1, name: `阶段${i + 1}` })),
    created_at: 0,
    updated_at: 0
  }
}

test('完整正路：pending→waiting_user(plan_review)→doing→waiting_user(result_review)→done', () => {
  let s = stage()
  let now = 100

  const r1 = applyAction(s, 'author_stage', 1, now++)
  assert.equal(r1.ok, true)
  s = r1.stage
  assert.equal(s.status, 'waiting_user')
  assert.equal(s.waiting_reason, 'plan_review')
  assert.equal(s.revision, 2)

  const r2 = applyAction(s, 'confirm_plan', s.revision, now++)
  assert.equal(r2.ok, true)
  s = r2.stage
  assert.equal(s.status, 'doing')
  assert.equal(s.waiting_reason, null)

  const r3 = applyAction(s, 'execution_done', s.revision, now++)
  assert.equal(r3.ok, true)
  s = r3.stage
  assert.equal(s.status, 'waiting_user')
  assert.equal(s.waiting_reason, 'result_review')

  const r4 = applyAction(s, 'confirm_result', s.revision, now++)
  assert.equal(r4.ok, true)
  s = r4.stage
  assert.equal(s.status, 'done')
  assert.equal(s.revision, 5)
  assert.equal(s.updated_at, 103)
})

test('禁止跳过 review：doing 不能直接 confirm_result', () => {
  const s = stage({ status: 'doing', revision: 3 })
  const r = applyAction(s, 'confirm_result', 3)
  assert.equal(r.ok, false)
  assert.match(r.error, /不允许动作/)
})

test('闸门语义：waiting_reason 不匹配时确认被拒', () => {
  const s = stage({ status: 'waiting_user', waiting_reason: 'result_review', revision: 2 })
  assert.equal(applyAction(s, 'confirm_plan', 2).ok, false)
  const s2 = stage({ status: 'waiting_user', waiting_reason: 'plan_review', revision: 2 })
  assert.equal(applyAction(s2, 'confirm_result', 2).ok, false)
})

test('乐观锁：expectedRevision 不匹配返回 conflict 并带当前值', () => {
  const s = stage({ status: 'doing', revision: 7 })
  const r = applyAction(s, 'execution_done', 6)
  assert.equal(r.ok, false)
  assert.equal(r.conflict, true)
  assert.equal(r.current.revision, 7)
})

test('retry：从 done / blocked / waiting_user 都能回到 doing，且清空闸门', () => {
  for (const over of [{ status: 'done' }, { status: 'blocked' }, { status: 'waiting_user', waiting_reason: 'result_review' }]) {
    const s = stage({ ...over, revision: 4 })
    const r = applyAction(s, 'retry', 4)
    assert.equal(r.ok, true, `retry from ${over.status}`)
    assert.equal(r.stage.status, 'doing')
    assert.equal(r.stage.waiting_reason, null)
  }
})

test('block / unblock：缺输入时挂起，处理后回 doing', () => {
  const s = stage({ status: 'doing', revision: 2 })
  const b = applyAction(s, 'block', 2)
  assert.equal(b.ok, true)
  assert.equal(b.stage.status, 'blocked')
  const u = applyAction(b.stage, 'unblock', b.stage.revision)
  assert.equal(u.ok, true)
  assert.equal(u.stage.status, 'doing')
})

test('完成证明：写产物后 status=done，重跑旧产物进 superseded 且 id 不变', () => {
  const s = stage({ status: 'doing', revision: 5 })
  const first = setWorkItemOutput(s, 'w1', { nodeId: 'n1', assetId: 'a1' }, 10)
  assert.equal(first.ok, true)
  assert.equal(first.stage.work_items[0].output_node_id, 'n1')
  assert.equal(first.stage.work_items[0].status, 'done')

  const again = setWorkItemOutput(first.stage, 'w1', { nodeId: 'n2', assetId: 'a2' }, 20)
  assert.equal(again.ok, true)
  const item = again.stage.work_items[0]
  assert.equal(item.id, 'w1') // 逻辑产物 id 不变
  assert.equal(item.output_node_id, 'n2')
  assert.equal(item.superseded.length, 1)
  assert.deepEqual(
    { node: item.superseded[0].output_node_id, asset: item.superseded[0].output_asset_id },
    { node: 'n1', asset: 'a1' }
  )
})

test('setWorkItemOutput 未知 item 报错', () => {
  const r = setWorkItemOutput(stage({ status: 'doing' }), 'nope', { nodeId: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /work_item 不存在/)
})

test('plan 状态推导：blocked > done > running > drafting', () => {
  const done = stage({ status: 'done' })
  assert.equal(derivePlanStatus([stage({ status: 'doing' })], 1), 'running')
  assert.equal(derivePlanStatus([done], 1), 'done')
  assert.equal(derivePlanStatus([done, stage({ id: 's2', status: 'blocked' })], 2), 'blocked')
  assert.equal(derivePlanStatus([], 2), 'drafting')
  assertEquals(derivePlanStatus([stage({ status: 'waiting_user', waiting_reason: 'plan_review' })], 2), 'running')
})

test('滚动细化：只 author 当前阶段，且未 author 的阶段不得被物化', () => {
  const p = plan(2)
  assert.equal(nextStageToAuthor(p, []), 1)
  assert.equal(nextStageToAuthor(p, [stage({ order: 1, status: 'waiting_user', waiting_reason: 'plan_review' })]), 2)
  assert.equal(nextStageToAuthor(p, [stage({ order: 1 }), stage({ id: 's2', order: 2 })]), null)

  // 占位卡（pending 且无 work_items）必须被断言拦住
  assert.throws(() => assertNoPlaceholders(p, [stage({ order: 1, status: 'pending', work_items: [] })]), /禁止占位卡/)
  // 不在 outline 里的阶段（workflow 绑定不可变）也要拦
  assert.throws(() => assertNoPlaceholders(p, [stage({ order: 9 })]), /不在 stage_outline/)
})

function assertEquals(actual, expected) {
  assert.equal(actual, expected)
}
