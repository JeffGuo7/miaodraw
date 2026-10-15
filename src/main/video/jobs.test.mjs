// video_jobs 幂等单测（零成本）：三键主键 / 提交前必查 / 重试上限 / 续跑集合
// 运行：node --test src/main/video/jobs.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_JOB_ATTEMPTS,
  VideoJobRegistry,
  createJob,
  decideSubmit,
  hashText,
  jobKey,
  markDegraded,
  markDone,
  markFailed,
  markRunning,
  markSkipped,
  requestIdFor,
  resumableJobs
} from './jobs.ts'

const P = 'plan1'
const S = 'stage1'
const W = 'wi_1'

const make = (over = {}) => createJob({ planId: P, stageId: S, workItemId: W, kind: 'image', paid: true, promptHash: 'h1', ...over })

test('job key = planId|stageId|workItemId，三键任一变化都是新 job', () => {
  assert.equal(jobKey(P, S, W), 'plan1|stage1|wi_1')
  assert.equal(make().id, jobKey(P, S, W))
  assert.notEqual(make({ workItemId: 'wi_2' }).id, make().id)
  assert.notEqual(make({ stageId: 'stage2' }).id, make().id)
})

test('request_id 确定性：同 (plan,stage,item,prompt) → 同键；prompt 变则换键', () => {
  const a = requestIdFor(P, S, W, 'h1')
  assert.equal(a, requestIdFor(P, S, W, 'h1'))
  assert.notEqual(a, requestIdFor(P, S, W, 'h2'))
  assert.match(a, /^vjob_[0-9a-f]{8}$/)
  assert.equal(make().request_id, requestIdFor(P, S, W, 'h1'))
  assert.equal(make({ paid: false }).request_id, undefined, '非付费 job 不带幂等键')
})

test('ensure 幂等：重复调用不产生第二条，且不覆盖既有进度', () => {
  const reg = new VideoJobRegistry()
  const first = reg.ensure({ planId: P, stageId: S, workItemId: W, kind: 'image', paid: true })
  const running = reg.put(markRunning(first, 1000))
  const again = reg.ensure({ planId: P, stageId: S, workItemId: W, kind: 'image', paid: true })
  assert.equal(reg.listByStage(P, S).length, 1)
  assert.equal(again.status, 'running', '不得被覆盖回 pending')
  assert.equal(again.attempts, 1)
  assert.equal(running.attempts, 1)
})

test('提交前必查：done 复用产物（绝不重复付费）', () => {
  const d = decideSubmit(markDone(markRunning(make()), 'asset_1', 2000))
  assert.equal(d.action, 'reuse')
  assert.equal(d.output_asset_id, 'asset_1')
  assert.match(d.reason, /复用/)
})

test('提交前必查：running → 先对账（不直接重提）', () => {
  const d = decideSubmit(markRunning(make()))
  assert.equal(d.action, 'reconcile')
  assert.equal(d.request_id, make().request_id)
})

test('提交前必查：无 job / failed / pending → 允许提交；skipped → 跳过', () => {
  assert.equal(decideSubmit(undefined).action, 'submit')
  assert.equal(decideSubmit(make()).action, 'submit')
  assert.equal(decideSubmit(markFailed(markRunning(make()), 'boom')).action, 'submit')
  assert.equal(decideSubmit(markSkipped(make(), '用户跳过')).action, 'skip')
})

test('重试上限：连续失败到 MAX_JOB_ATTEMPTS 自动置 blocked，不再允许自动重提', () => {
  let job = make()
  for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) job = markFailed(markRunning(job), `err${i}`)
  assert.equal(job.status, 'blocked')
  assert.equal(job.attempts, MAX_JOB_ATTEMPTS)
  assert.match(job.last_error, /人工确认/)
  const d = decideSubmit(job)
  assert.equal(d.action, 'blocked')
})

test('续跑集合只含 failed / running（done/skipped 一律跳过）', () => {
  const jobs = [
    markDone(markRunning(make({ workItemId: 'a' })), 'x'),
    markRunning(make({ workItemId: 'b' })),
    markFailed(markRunning(make({ workItemId: 'c' })), 'e'),
    markSkipped(make({ workItemId: 'd' }), 'skip'),
    make({ workItemId: 'e' })
  ]
  assert.deepEqual(
    resumableJobs(jobs).map((j) => j.work_item_id),
    ['b', 'c']
  )
})

test('状态迁移不可变 + 降级标记', () => {
  const job = make()
  const running = markRunning(job, 5)
  assert.equal(job.status, 'pending', '原记录不被改写')
  assert.equal(running.attempts, 1)
  const deg = markDegraded(running)
  assert.equal(deg.degraded, true)
  assert.equal(markDone(deg, 'a', 9).finished_at, 9)
})

test('hashText 稳定（跨调用一致，不同输入不同值）', () => {
  assert.equal(hashText('abc'), hashText('abc'))
  assert.notEqual(hashText('abc'), hashText('abd'))
})
