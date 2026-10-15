/**
 * C5：冻结前缀判定（纯函数，零依赖 → 可在 Node 里直接单测）。
 *
 * 规则来源：任务卡 C5 —— 已确认/已完成阶段为「冻结区」，改动它必须先经用户选择处理方式
 * （从其后重排 / 新建计划），**未选定前不落任何变更**。
 *
 * 这里只做「这句话是不是想改冻结阶段」的判定，不做档位分类
 * （三档由 B 批次 registry.replan 决定，UI 只负责拦下来并让用户确认）。
 */

/** 判定所需的最小结构（避免依赖 StageRecord 里与规则无关的字段） */
export interface FreezeCandidate {
  id: string
  name: string
  order: number
  status: string
}

/** 已完成 = 冻结 */
export function isFrozenStage(stage: { status: string }): boolean {
  return stage.status === 'done'
}

/** 明确的「想改动」意图词（只有配到冻结阶段才拦，不是所有消息都拦） */
const CHANGE_INTENT = /(改成|换掉|换成|改为|调整|重做|重新做|修改|不要|去掉|删掉|换一个|换个|改一下|改下|改一改|再改|重排|横屏|竖屏)/

/** 指向阶段的口头序号：第一步 / 第1步 / 第一阶段 / 第 2 阶段 … */
function orderHeads(order: number): string[] {
  return [
    `第一步`,
    `第1步`,
    `第 1 步`,
    `第一阶段`,
    `第1阶段`,
    `第${order}步`,
    `第 ${order} 步`,
    `第${order}阶段`,
    `第 ${order} 阶段`
  ]
}

/**
 * 返回被点名的冻结阶段；没有命中返回 null。
 * 只认「明确点名」与「泛指开头且第 1 阶段已冻结」两类，避免误拦正常的新需求。
 */
export function detectFrozenTouch(text: string, stages: FreezeCandidate[]): FreezeCandidate | null {
  const t = (text ?? '').trim()
  if (!t) return null
  const frozen = stages.filter(isFrozenStage)
  if (frozen.length === 0) return null
  if (!CHANGE_INTENT.test(t)) return null

  for (const s of frozen) {
    if (orderHeads(s.order).some((h) => t.includes(h))) return s
    if (s.name && t.includes(s.name)) return s
  }

  // 泛指「开头/前面」且第 1 阶段已冻结
  if (/(开头|前面|最初|一开始)/.test(t)) {
    const first = frozen.find((s) => s.order === 1)
    if (first) return first
  }
  return null
}
