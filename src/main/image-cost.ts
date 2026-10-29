/**
 * 图片链路成本护栏（轻量 fail-closed）—— 纯函数、零外部依赖，可 node --test 直跑。
 *
 * 视频链路的六道闸（确认凭证 / 幂等 / 记账 / 审计）套到单张出图上会让每次生成都弹确认，过重。
 * 这里取最小必要的两道：
 *   1) 预估价：模型单价 × 张数；价目缺失时按最高已知单价兜底（宁可高估，不可低估）
 *   2) 累计预算：spent + 本次预估 > budget → 直接拒，**不发起任何付费请求**
 *
 * 价目口径：只有 z-image-turbo(¥0.1) 与 wan2.7-image(¥0.2) 与官方账单核实过，
 * 其余为保守估价（对外必须以百炼账单为准）；新增模型请同步这里。
 */

export const IMAGE_UNIT_PRICE_CNY: Record<string, number> = {
  'z-image-turbo': 0.1,
  'wan2.7-image': 0.2,
  'wan2.7-image-pro': 0.3,
  'qwen-image-3.0': 0.2,
  'qwen-image-3.0-pro': 0.3,
  'gpt-image-1': 0.3,
  'Kwai-Kolors/Kolors': 0.14,
  'Kwai-Kolors/Kolors-Turbo': 0.05,
  'black-forest-labs/FLUX.1-schnell': 0.01
}

/** 价目表缺失时的兜底单价：取已知最高档，保证预估价不会低估 */
export const FALLBACK_UNIT_PRICE_CNY = 0.3

export interface ImageEstimate {
  cny: number
  unitCny: number
  count: number
  /** false = 该模型没收录价目，用的是兜底单价 */
  priced: boolean
}

export function estimateImageBatch(model: string, count: number): ImageEstimate {
  const n = Math.max(1, Math.round(Number(count) || 1))
  const unit = IMAGE_UNIT_PRICE_CNY[String(model || '')]
  const priced = typeof unit === 'number' && Number.isFinite(unit)
  const unitCny = priced ? unit : FALLBACK_UNIT_PRICE_CNY
  return { cny: Math.round(unitCny * n * 100) / 100, unitCny, count: n, priced }
}

export type ImageBudgetResult =
  | { ok: true; estimate: ImageEstimate; remainingCny: number }
  | { ok: false; code: 'BUDGET_EXCEEDED' | 'BUDGET_INVALID'; reason: string; estimate: ImageEstimate; remainingCny: number }

/** 付费出图前的唯一判定：预算有效 + 本次预估不超剩余 */
export function checkImageBudget(args: {
  model: string
  count: number
  spentCny: number
  budgetCny: number
}): ImageBudgetResult {
  const estimate = estimateImageBatch(args.model, args.count)
  const budget = Number(args.budgetCny)
  const spent = Number(args.spentCny) || 0
  if (!Number.isFinite(budget) || budget <= 0) {
    return { ok: false, code: 'BUDGET_INVALID', reason: '图片预算配置无效（需 > 0），已拒绝付费出图', estimate, remainingCny: 0 }
  }
  const remaining = Math.max(0, Math.round((budget - spent) * 100) / 100)
  if (spent + estimate.cny > budget + 1e-9) {
    return {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      reason:
        '图片预算不足：本次预估 ¥' + estimate.cny.toFixed(2) +
        '（' + estimate.count + ' 张 × ¥' + estimate.unitCny + '），已花 ¥' + spent.toFixed(2) +
        ' / 预算 ¥' + budget.toFixed(2) + '。可在 settings.json 调整 imageBudget，或把 imageBudget 设为更小批量再试',
      estimate,
      remainingCny: remaining
    }
  }
  return { ok: true, estimate, remainingCny: Math.max(0, Math.round((budget - spent - estimate.cny) * 100) / 100) }
}
