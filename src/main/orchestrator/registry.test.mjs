// B 批增量协议单测：冻结前缀不可改 / 幂等重放 / CAS 冲突 / 后缀原子性
// 运行：node --test src/main/orchestrator/registry.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PlanRegistry } from './registry.ts'

function setup() {
  const changes = []
  const events = []
  const reg = new PlanRegistry((s) => changes.push(s), (e) => events.push(e))
  const created = reg.create('帮我做一条带货短视频，要有分镜和口播')
  const planId = created.snapshot.plan.id
  return { reg, planId, changes, events }
}

/** 走完一个阶段：author → confirm_plan → execution_done → confirm_result */
function completeStage(reg, planId) {
  const snap = reg.get(planId)
  const order = snap.stages.length === 0 ? 1 : Math.max(...snap.stages.map((s) => s.order)) + 1
  let r = reg.get(planId).stages.find((s) => s.order === order)
  if (!r) r = reg.authorFirstStage(planId).value.stages.find((s) => s.order === order)
  const a1 = reg.advance(planId, r.id, 'confirm_plan', r.revision)
  const a2 = reg.advance(planId, r.id, 'execution_done', a1.value.revision)
  const a3 = reg.advance(planId, r.id, 'confirm_result', a2.value.revision)
  return a3.value
}

test('冻结前缀不可被增量改动（revise_stage 命中冻结阶段 → 拒绝且状态不变）', () => {
  const { reg, planId } = setup()
  const s1 = completeStage(reg, planId)
  const s2 = reg.authorFirstStage(planId).value.stages.find((s) => s.order === 2)

  const before = JSON.stringify(reg.get(planId))
  const r = reg.replan({
    planId,
    requestId: 'req-freeze-1',
    preserveThroughStageId: s1.id,
    ops: [{ kind: 'revise_stage', stage_id: s1.id, patch: { name: '偷改冻结阶段' } }]
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /冻结前缀/)
  assert.equal(JSON.stringify(reg.get(planId)), before, '拒绝后计划必须原样不动')
  assert.equal(s2.status, 'waiting_user')
})

test('replan 正常路径：改后缀阶段 + 追加 outline，revision 递增且广播', () => {
  const { reg, planId, changes, events } = setup()
  const s1 = completeStage(reg, planId)
  const s2 = reg.authorFirstStage(planId).value.stages.find((s) => s.order === 2)
  const revBefore = reg.get(planId).plan.revision

  const r = reg.replan({
    planId,
    requestId: 'req-ok-1',
    preserveThroughStageId: s1.id,
    expectedRevision: revBefore,
    ops: [
      { kind: 'revise_stage', stage_id: s2.id, patch: { goal: '按新需求重写画面方向' } },
      { kind: 'insert_stage_outline', entry: { id: `${planId}_s9`, order: 9, name: '加映·花絮' } }
    ],
    actor: 'chat',
    sourceMessageId: 'msg_42'
  })

  assert.equal(r.ok, true)
  assert.equal(r.revision, revBefore + 1)
  assert.equal(r.frozen_through, s1.id)
  const snap = reg.get(planId)
  assert.equal(snap.stages.find((s) => s.id === s2.id).goal, '按新需求重写画面方向')
  assert.equal(snap.plan.stage_outline.some((o) => o.order === 9), true)
  // 冻结前缀内容未被改动（revision 不变）
  assert.equal(snap.stages.find((s) => s.id === s1.id).revision, s1.revision)
  assert.ok(changes.length > 0)
  const ev = events.at(-1)
  assert.equal(ev.event, 'replan')
  assert.equal(ev.actor, 'chat')
  assert.equal(ev.source_message_id, 'msg_42')
  assert.equal(ev.before_revision, revBefore)
  assert.equal(ev.after_revision, revBefore + 1)
})

test('幂等重放：同 requestId + 同 payload 返回既有结果且不再改动计划', () => {
  const { reg, planId } = setup()
  const s1 = completeStage(reg, planId)
  const s2 = reg.authorFirstStage(planId).value.stages.find((s) => s.order === 2)
  const req = {
    planId,
    requestId: 'req-idem-1',
    preserveThroughStageId: s1.id,
    ops: [{ kind: 'revise_stage', stage_id: s2.id, patch: { name: '第一次改名' } }]
  }
  const first = reg.replan({ ...req })
  assert.equal(first.ok, true)
  const revAfterFirst = reg.get(planId).plan.revision

  const replay = reg.replan({ ...req })
  assert.equal(replay.ok, true)
  assert.equal(replay.replayed, true)
  assert.equal(reg.get(planId).plan.revision, revAfterFirst, '重放不得再推进 revision')
  assert.equal(reg.get(planId).stages.find((s) => s.id === s2.id).name, '第一次改名')
})

test('同 requestId 不同 payload：视为新请求（不套用旧结果）', () => {
  const { reg, planId } = setup()
  const s1 = completeStage(reg, planId)
  const s2 = reg.authorFirstStage(planId).value.stages.find((s) => s.order === 2)
  const first = reg.replan({ planId, requestId: 'req-x', preserveThroughStageId: s1.id, ops: [{ kind: 'revise_stage', stage_id: s2.id, patch: { name: 'A' } }] })
  assert.equal(first.ok, true)
  const second = reg.replan({ planId, requestId: 'req-x', preserveThroughStageId: s1.id, ops: [{ kind: 'revise_stage', stage_id: s2.id, patch: { name: 'B' } }] })
  assert.equal(second.ok, true)
  assert.equal(second.replayed, undefined)
  assert.equal(reg.get(planId).stages.find((s) => s.id === s2.id).name, 'B')
})

test('CAS 冲突：expectedRevision 过期 → 结构化 PLAN_REVISION_CONFLICT', () => {
  const { reg, planId } = setup()
  const s1 = completeStage(reg, planId)
  const stale = reg.get(planId).plan.revision - 1
  const r = reg.replan({ planId, requestId: 'req-cas-1', expectedRevision: stale, ops: [] })
  assert.equal(r.ok, false)
  assert.equal(r.conflict.code, 'PLAN_REVISION_CONFLICT')
  assert.equal(r.conflict.current_state.expected_revision, stale)
  assert.equal(r.conflict.current_state.actual_revision, stale + 1)
  assert.deepEqual(r.conflict.allowed_actions, ['reread_plan'])
})

test('后缀原子性：批量里任一 op 非法 → 全部不生效（不留半成品）', () => {
  const { reg, planId } = setup()
  const s1 = completeStage(reg, planId)
  const s2 = reg.authorFirstStage(planId).value.stages.find((s) => s.order === 2)
  const before = JSON.stringify(reg.get(planId))

  const r = reg.replan({
    planId,
    requestId: 'req-atomic-1',
    preserveThroughStageId: s1.id,
    ops: [
      { kind: 'revise_stage', stage_id: s2.id, patch: { name: '这一步本身合法' } },
      { kind: 'revise_stage', stage_id: 'not-exist', patch: { name: '非法阶段' } }
    ]
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /阶段不存在/)
  assert.equal(JSON.stringify(reg.get(planId)), before, '失败批次不得留下任何改动')
})

test('remove_unexecuted_stage：拒绝删除已完成/进行中阶段，允许删除未执行阶段', () => {
  const { reg, planId } = setup()
  const s1 = completeStage(reg, planId)
  const s2 = reg.authorFirstStage(planId).value.stages.find((s) => s.order === 2)

  const bad = reg.replan({ planId, requestId: 'req-rm-1', ops: [{ kind: 'remove_unexecuted_stage', stage_id: s1.id }] })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /已开始\/已完成/)

  const ok = reg.replan({ planId, requestId: 'req-rm-2', ops: [{ kind: 'remove_unexecuted_stage', stage_id: s2.id }] })
  assert.equal(ok.ok, true)
  assert.equal(reg.get(planId).stages.some((s) => s.id === s2.id), false)
})

test('insert_stage：新阶段直接进入 plan_review（不预铺后续）', () => {
  const { reg, planId } = setup()
  completeStage(reg, planId)
  const r = reg.replan({
    planId,
    requestId: 'req-ins-1',
    ops: [
      {
        kind: 'insert_stage',
        spec: { id: 'extra', name: '补拍特写', goal: '补一个产品特写镜头', review: { before_execution: ['确认构图'], after_execution: ['确认特写'] }, work_items: [{ id: 'extra_1', name: '特写图', modality: 'image' }] }
      }
    ]
  })
  assert.equal(r.ok, true)
  const inserted = reg.get(planId).stages.find((s) => s.name === '补拍特写')
  assert.equal(inserted.status, 'waiting_user')
  assert.equal(inserted.waiting_reason, 'plan_review')
  assert.equal(inserted.work_items[0].id.includes('_extra_1'), true)
})

test('plan:cancel 语义：标记终态，阶段保持原状，并记审计事件', () => {
  const { reg, planId, events } = setup()
  reg.authorFirstStage(planId)
  const r = reg.cancel(planId)
  assert.equal(r.ok, true)
  const snap = reg.get(planId)
  assert.equal(snap.plan.status, 'cancelled')
  assert.equal(snap.stages[0].status, 'waiting_user')
  assert.equal(events.at(-1).event, 'cancel')
  // 取消后 author 不再把计划拉回 running
  reg.authorFirstStage(planId)
  assert.equal(reg.get(planId).plan.status, 'cancelled')
})
