// 编排注册表单测（O1 验收项：能造 plan 并推进状态机；含首阶段异步物化与冲突）
// 运行：node --test src/main/orchestrator/registry.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PlanRegistry } from './registry.ts'

test('建计划：立即返回 drafting（只有骨架，不物化任何阶段）', () => {
  const reg = new PlanRegistry()
  const res = reg.create('帮我做一条带货短视频，要分镜和口播')
  assert.equal(res.kind, 'plan')
  assert.equal(res.snapshot.plan.status, 'drafting')
  assert.equal(res.snapshot.stages.length, 0)
  assert.equal(res.snapshot.plan.workflow_id, 'doc-to-video')
  assert.equal(res.snapshot.plan.stage_outline.length, 4)
  assert.deepEqual(
    res.snapshot.plan.stage_outline.map((s) => s.order),
    [1, 2, 3, 4]
  )
})

test('直连路径：单图需求不建计划', () => {
  const reg = new PlanRegistry()
  const res = reg.create('画一只猫')
  assert.equal(res.kind, 'direct')
  assert.equal(res.capsule.route_kind, 'direct')
})

test('素材不足时问用户：图生视频无参考图', () => {
  const reg = new PlanRegistry()
  const res = reg.create('让这张图动起来', { pixelleReady: true })
  assert.equal(res.kind, 'ask')
  assert.match(res.capsule.question, /参考图/)
})

test('Pixelle 未就绪时降级为出图流程', () => {
  const reg = new PlanRegistry()
  const res = reg.create('把这些素材做成一个短视频', { pixelleReady: false })
  assert.equal(res.kind, 'plan')
  assert.equal(res.snapshot.plan.workflow_id, 'single-image')
})

test('首阶段物化：一次一个，进入 plan_review，并广播变更', () => {
  const seen = []
  const reg = new PlanRegistry((snap) => seen.push(snap))
  const created = reg.create('做一条短视频，先分镜')
  assert.equal(created.kind, 'plan')
  const planId = created.snapshot.plan.id
  assert.equal(reg.get(planId).stages.length, 0)

  const r1 = reg.authorFirstStage(planId)
  assert.equal(r1.ok, true)
  assert.equal(r1.value.stages.length, 1)
  assert.equal(r1.value.stages[0].order, 1)
  assert.equal(r1.value.stages[0].status, 'waiting_user')
  assert.equal(r1.value.stages[0].waiting_reason, 'plan_review')
  assert.equal(r1.value.plan.status, 'running')
  assert.equal(seen.length, 1)

  // 第二次调用才会物化第 2 阶段（滚动细化）
  const r2 = reg.authorFirstStage(planId)
  assert.equal(r2.value.stages.length, 2)
  assert.deepEqual(
    r2.value.stages.map((s) => s.order),
    [1, 2]
  )
})

test('状态机推进闭环：确认计划 → 执行完成 → 确认结果 → 下一阶段', () => {
  const reg = new PlanRegistry()
  const created = reg.create('做一条短视频')
  const planId = created.snapshot.plan.id
  const s1 = reg.authorFirstStage(planId).value.stages[0]

  const a1 = reg.advance(planId, s1.id, 'confirm_plan', s1.revision)
  assert.equal(a1.ok, true)
  assert.equal(a1.value.status, 'doing')

  const a2 = reg.advance(planId, s1.id, 'execution_done', a1.value.revision)
  assert.equal(a2.ok, true)
  assert.equal(a2.value.waiting_reason, 'result_review')

  const a3 = reg.advance(planId, s1.id, 'confirm_result', a2.value.revision)
  assert.equal(a3.ok, true)
  assert.equal(a3.value.status, 'done')

  // 第一阶段 done 后再 author 第二阶段
  const r = reg.authorFirstStage(planId)
  assert.equal(r.value.stages.length, 2)
  assert.equal(r.value.stages[1].status, 'waiting_user')
})

test('乐观锁冲突：过期 revision 被拒并返回当前值', () => {
  const reg = new PlanRegistry()
  const created = reg.create('做一条短视频')
  const planId = created.snapshot.plan.id
  const s1 = reg.authorFirstStage(planId).value.stages[0]

  const ok = reg.advance(planId, s1.id, 'confirm_plan', s1.revision)
  assert.equal(ok.ok, true)

  const stale = reg.advance(planId, s1.id, 'execution_done', s1.revision) // 用旧 revision
  assert.equal(stale.ok, false)
  assert.equal(stale.conflict, true)
  assert.equal(stale.current.revision, ok.value.revision)
})

test('patchStage：改提示词带乐观锁，revision 递增', () => {
  const reg = new PlanRegistry()
  const created = reg.create('做一条短视频')
  const planId = created.snapshot.plan.id
  const s1 = reg.authorFirstStage(planId).value.stages[0]

  const items = s1.work_items.map((w) => ({ ...w, prompt: '改好的提示词' }))
  const r = reg.patchStage(planId, s1.id, { work_items: items }, s1.revision)
  assert.equal(r.ok, true)
  assert.equal(r.value.revision, s1.revision + 1)
  assert.equal(r.value.work_items[0].prompt, '改好的提示词')

  const stale = reg.patchStage(planId, s1.id, { work_items: items }, s1.revision)
  assert.equal(stale.ok, false)
  assert.equal(stale.conflict, true)
})

test('删除计划连同阶段（不涉及产物资产）', () => {
  const reg = new PlanRegistry()
  const created = reg.create('做一条短视频')
  const planId = created.snapshot.plan.id
  reg.authorFirstStage(planId)
  assert.equal(reg.remove(planId), true)
  assert.equal(reg.get(planId), null)
  assert.equal(reg.remove(planId), false)
})
