// C5 冻结边界单测：只拦「明确要改已完成阶段」的消息，其他一律不打扰
// 运行：node --test src/renderer/src/canvas/frozen-scope.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectFrozenTouch, isFrozenStage } from './frozen-scope.ts'

const stage = (id, name, order, status) => ({ id, name, order, status })

const DONE_1 = stage('s1', '脚本与分镜', 1, 'done')
const DOING_2 = stage('s2', '画面生成', 2, 'doing')
const DONE_2 = stage('s2', '画面生成', 2, 'done')

test('isFrozenStage：只有 done 是冻结', () => {
  assert.equal(isFrozenStage(DONE_1), true)
  assert.equal(isFrozenStage(DOING_2), false)
  assert.equal(isFrozenStage({ status: 'waiting_user' }), false)
  assert.equal(isFrozenStage({ status: 'blocked' }), false)
})

test('完成阶段被明确点名 + 修改意图 → 命中（任务卡原句「把第一步改成横屏」）', () => {
  const hit = detectFrozenTouch('把第一步改成横屏', [DONE_1, DOING_2])
  assert.equal(hit?.id, 's1')
})

test('多种点名写法都命中：第1步 / 第 1 步 / 第一阶段 / 阶段名', () => {
  for (const t of ['把第1步换成竖屏', '把第 1 步改一下', '第一阶段重做', '脚本与分镜要调整', '开头删掉']) {
    assert.equal(detectFrozenTouch(t, [DONE_1, DOING_2])?.id, 's1', `未命中：${t}`)
  }
})

test('命中按 order 对上：点名第 2 阶段不会错算到第 1 阶段', () => {
  const hit = detectFrozenTouch('把第2阶段改成 9:16', [DONE_1, DONE_2])
  assert.equal(hit?.id, 's2')
})

test('无修改意图 → 不打扰（纯确认/闲聊不得弹范围确认卡）', () => {
  for (const t of ['第一步做得不错', '确认第一步', '开始第二步吧', '继续']) {
    assert.equal(detectFrozenTouch(t, [DONE_1, DOING_2]), null, `误拦：${t}`)
  }
})

test('修改意图指向未完成阶段 → 不拦（交给三档增量协议）', () => {
  assert.equal(detectFrozenTouch('把第二步改成横屏', [DONE_1, DOING_2]), null)
  assert.equal(detectFrozenTouch('画面生成要调整', [DONE_1, DOING_2]), null)
})

test('泛指「开头」只在第 1 阶段冻结时命中', () => {
  assert.equal(detectFrozenTouch('开头重做一下', [DONE_1, DOING_2])?.id, 's1')
  assert.equal(detectFrozenTouch('开头重做一下', [DOING_2, DONE_2]), null)
  assert.equal(detectFrozenTouch('前面删掉', [stage('s3', '合成', 3, 'done')]), null)
})

test('没有冻结阶段 / 空消息 → 永不命中', () => {
  assert.equal(detectFrozenTouch('把第一步改成横屏', [DOING_2]), null)
  assert.equal(detectFrozenTouch('把第一步改成横屏', []), null)
  assert.equal(detectFrozenTouch('', [DONE_1]), null)
  assert.equal(detectFrozenTouch('   ', [DONE_1]), null)
  assert.equal(detectFrozenTouch(undefined, [DONE_1]), null)
})

test('冻结判定先于一切：命中的一定是 done 阶段', () => {
  const stages = [stage('a', '甲', 1, 'done'), stage('b', '乙', 2, 'doing'), stage('c', '丙', 3, 'done')]
  for (const t of ['第1阶段改一下', '第3阶段改一下', '甲乙丙都重做']) {
    const hit = detectFrozenTouch(t, stages)
    assert.ok(hit === null || hit.status === 'done', `返回了非冻结阶段：${t}`)
  }
})
