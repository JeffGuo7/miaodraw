/**
 * 成本护栏（硬约束②：fail-closed）—— 预估 → 一次性 confirmToken → 硬上限 → 记账。**纯逻辑，零 IO**。
 *
 * fail-closed 落点（设计稿 §2.6，Jeff 硬要求）：
 * - 主进程校验 token 的 stageId/revision/付费项哈希与当前 stage 一致（用后作废），且 spent + 本次上限 ≤ budget
 * - 任一不满足 → 返回 COST_GATE_REQUIRED，**不发起任何付费请求**
 * - 价格缺失（"无法预估"）默认拒付，需显式勾选「接受按量计费」才签发 token
 */
import { hashText, type VideoJobKind } from './jobs.ts'

export type Currency = 'CNY'

// ── 价目表（元）：与 docs/todo-cost-guard.md 第 3 节同源；未核实的档位 verified=false ──
export interface PriceSpec {
  unit: 'per_image' | 'per_second' | 'per_kchar' | 'free'
  cny: number
  verified: boolean
}

export const PRICES: Record<string, PriceSpec> = {
  // 图片
  'z-image-turbo': { unit: 'per_image', cny: 0.1, verified: true },
  'wan2.7-image': { unit: 'per_image', cny: 0.2, verified: true },
  // 视频（V0 实测基准：2 秒 720P ≈ ¥1.2）
  'wan2.7-t2v@720P': { unit: 'per_second', cny: 0.6, verified: false },
  'wan2.7-t2v@1080P': { unit: 'per_second', cny: 1.2, verified: false },
  // 配音（按字符，极低）
  'qwen3-tts-flash': { unit: 'per_kchar', cny: 0.02, verified: false },
  // 本地步骤（离屏渲染 / ffmpeg 合成）不花钱
  'local-frame': { unit: 'free', cny: 0, verified: true },
  'local-compose': { unit: 'free', cny: 0, verified: true }
}

/** 单次提交的硬上限（元）：与 video-protocol 的 VIDEO_HARD_CAP_CNY 同一红线 */
export const HARD_CAP_PER_SUBMIT_CNY = 6

export interface CostItem {
  kind: VideoJobKind
  /** 价目表 key（图片/视频模型，或 local-frame/local-compose） */
  price_key: string
  qty?: number
  seconds?: number
  chars?: number
}

export interface CostLine {
  kind: VideoJobKind
  price_key: string
  cny: number
  priced: boolean
  verified: boolean
  detail: string
}

export interface CostEstimate {
  lines: CostLine[]
  /** 确定能算出来的最小花费 */
  minCny: number
  /** 预计花费（= 所有已收录价目的合计） */
  expectCny: number
  /** 最坏花费：存在未收录价目时为 null（无法预估） */
  maxCny: number | null
  currency: Currency
  /** 有价目缺失 → UI 必须要求显式勾选「接受按量计费」 */
  unpriced: boolean
  note: string
}

function lineCost(item: CostItem, spec: PriceSpec | undefined): { cny: number; priced: boolean; verified: boolean; detail: string } {
  if (!spec) return { cny: 0, priced: false, verified: false, detail: '价目未收录' }
  if (spec.unit === 'free') return { cny: 0, priced: true, verified: true, detail: '本地执行，不花钱' }
  const qty = Math.max(0, Number(item.qty ?? 1) || 0)
  if (spec.unit === 'per_image') return { cny: round2(spec.cny * qty), priced: true, verified: spec.verified, detail: `${qty} 张 × ¥${spec.cny}` }
  if (spec.unit === 'per_second') {
    const sec = Math.max(0, Number(item.seconds ?? 0) || 0)
    return { cny: round2(spec.cny * sec), priced: true, verified: spec.verified, detail: `${sec} 秒 × ¥${spec.cny}` }
  }
  const kchars = Math.max(0, Number(item.chars ?? 0) || 0) / 1000
  return { cny: round2(spec.cny * kchars), priced: true, verified: spec.verified, detail: `${Math.round(Number(item.chars ?? 0))} 字` }
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** 阶段级预估：按 work_item 粒度累加；任何一项无价目 → unpriced（fail-closed 的输入） */
export function estimateCost(items: CostItem[]): CostEstimate {
  const lines: CostLine[] = (items ?? []).map((it) => {
    const spec = PRICES[it.price_key]
    const r = lineCost(it, spec)
    return { kind: it.kind, price_key: it.price_key, cny: r.cny, priced: r.priced, verified: r.verified, detail: r.detail }
  })
  const priced = lines.filter((l) => l.priced)
  const unpriced = priced.length !== lines.length
  const expectCny = round2(priced.reduce((s, l) => s + l.cny, 0))
  return {
    lines,
    minCny: expectCny,
    expectCny,
    maxCny: unpriced ? null : expectCny,
    currency: 'CNY',
    unpriced,
    note: unpriced
      ? '存在未收录价目的付费项：默认拒绝执行，需显式勾选「接受按量计费」'
      : lines.some((l) => !l.verified)
        ? '含未与账单核实的档位，实际以百炼账单为准'
        : '价目已核实'
  }
}

/** 付费项指纹：绑定进 confirmToken（改一项即失效） */
export function paidItemsHash(items: CostItem[]): string {
  const norm = (items ?? [])
    .map((i) => `${i.kind}:${i.price_key}:${i.qty ?? ''}:${i.seconds ?? ''}:${i.chars ?? ''}`)
    .sort()
    .join(';')
  return hashText(norm)
}

// ── 一次性确认凭证（主进程签发 + 校验；签发必须发生在用户确认之后） ──

export interface ConfirmToken {
  token: string
  stage_id: string
  /** 绑定的 stage revision：闸门推进后旧凭证自动失效 */
  revision: number
  paid_hash: string
  issued_at: number
  expires_at: number
  used: boolean
  /** 用户显式接受「按量计费」 */
  accept_unpriced: boolean
}

export interface IssueTokenInput {
  stageId: string
  revision: number
  /** 付费项指纹（paidItemsHash 的结果） */
  paidHash: string
  now?: number
  ttlMs?: number
  /** 熵来源（主进程传 crypto.randomUUID()；测试可传固定值） */
  nonce: string
  acceptUnpriced?: boolean
}

export const TOKEN_TTL_MS = 10 * 60 * 1000

export function issueConfirmToken(input: IssueTokenInput): ConfirmToken {
  const now = input.now ?? Date.now()
  const ttl = input.ttlMs ?? TOKEN_TTL_MS
  return {
    token: `ct_${hashText(`${input.stageId}|${input.revision}|${input.paidHash}|${input.nonce}`)}`,
    stage_id: input.stageId,
    revision: input.revision,
    paid_hash: input.paidHash,
    issued_at: now,
    expires_at: now + ttl,
    used: false,
    accept_unpriced: input.acceptUnpriced === true
  }
}

export type GateCode = 'COST_GATE_REQUIRED' | 'TOKEN_EXPIRED' | 'TOKEN_USED' | 'TOKEN_MISMATCH' | 'BUDGET_EXCEEDED' | 'UNPRICED_REQUIRES_CONSENT'

export interface GateResult {
  ok: boolean
  code?: GateCode
  reason: string
  token?: ConfirmToken
}

export interface VerifyTokenExpectation {
  stageId: string
  revision: number
  paidHash: string
}

/** 校验凭证：绑定项一致 + 未用过 + 未过期；通过则返回「已作废」的新凭证（一次性） */
export function verifyConfirmToken(token: ConfirmToken | undefined | null, expect: VerifyTokenExpectation, now = Date.now()): GateResult {
  if (!token) return { ok: false, code: 'COST_GATE_REQUIRED', reason: '缺少成本确认凭证：请先在审阅卡上确认本次付费项' }
  if (token.used) return { ok: false, code: 'TOKEN_USED', reason: '该确认凭证已使用过，请重新确认' }
  if (token.expires_at <= now) return { ok: false, code: 'TOKEN_EXPIRED', reason: '确认凭证已过期，请重新确认' }
  if (token.stage_id !== expect.stageId || token.revision !== expect.revision || token.paid_hash !== expect.paidHash) {
    return { ok: false, code: 'TOKEN_MISMATCH', reason: '计划或付费项已变化，确认凭证失效，请重新确认' }
  }
  return { ok: true, reason: '凭证有效', token: { ...token, used: true } }
}

export interface BudgetCheck {
  ok: boolean
  code?: GateCode
  remainingCny: number
  requiredMaxCny: number | null
  reason: string
}

/** 硬上限：spent + 本次最坏花费 ≤ budget；最坏花费未知（unpriced）且未显式接受 → 拒 */
export function checkBudget(args: {
  spentCny: number
  estimate: CostEstimate
  budgetCny: number
  acceptUnpriced?: boolean
}): BudgetCheck {
  const spent = Number(args.spentCny) || 0
  const remaining = round2(Math.max(0, (Number(args.budgetCny) || 0) - spent))
  if (args.estimate.unpriced && args.acceptUnpriced !== true) {
    return { ok: false, code: 'UNPRICED_REQUIRES_CONSENT', remainingCny: remaining, requiredMaxCny: null, reason: '存在未收录价目：默认拒绝执行，请显式勾选「接受按量计费」' }
  }
  const required = args.estimate.maxCny
  if (required === null) {
    // 已显式接受按量计费：只要还有余额就放行（最坏值未知）
    return remaining > 0
      ? { ok: true, remainingCny: remaining, requiredMaxCny: null, reason: '已接受按量计费，余额充足' }
      : { ok: false, code: 'BUDGET_EXCEEDED', remainingCny: remaining, requiredMaxCny: null, reason: '预算已用尽' }
  }
  if (required > HARD_CAP_PER_SUBMIT_CNY) {
    return { ok: false, code: 'BUDGET_EXCEEDED', remainingCny: remaining, requiredMaxCny: required, reason: `本次预估价 ¥${required.toFixed(2)} 超过单次硬上限 ¥${HARD_CAP_PER_SUBMIT_CNY.toFixed(2)}` }
  }
  if (required > remaining) {
    return { ok: false, code: 'BUDGET_EXCEEDED', remainingCny: remaining, requiredMaxCny: required, reason: `预算不足：已花 ¥${spent.toFixed(2)}，剩余 ¥${remaining.toFixed(2)}，本次最多需要 ¥${required.toFixed(2)}` }
  }
  return { ok: true, remainingCny: remaining, requiredMaxCny: required, reason: '预算充足' }
}

// ── 付费执行总闸门：预算 + 凭证一次判完（V1 executor 的唯一入口） ──

export interface PaidSubmitRequest {
  stageId: string
  /** 当前 stage revision（凭证绑定项） */
  revision: number
  items: CostItem[]
  token?: ConfirmToken | null
  spentCny: number
  budgetCny: number
  acceptUnpriced?: boolean
  now?: number
}

export interface PaidSubmitAuth {
  ok: boolean
  code?: GateCode
  reason: string
  estimate: CostEstimate
  /** 校验通过时返回「已作废」的新凭证（调用方必须落库并替换旧凭证） */
  token?: ConfirmToken
}

/**
 * 付费执行前的一次判定：预估 → 硬上限/预算 → 一次性凭证。
 * 任何一步不过 → ok:false 且带结构化 code，**调用方不得发起任何付费请求**（fail-closed）。
 */
export function authorizePaidSubmit(req: PaidSubmitRequest): PaidSubmitAuth {
  const estimate = estimateCost(req.items)
  const budget = checkBudget({ spentCny: req.spentCny, estimate, budgetCny: req.budgetCny, acceptUnpriced: req.acceptUnpriced })
  if (!budget.ok) return { ok: false, code: budget.code, reason: budget.reason, estimate }
  const verified = verifyConfirmToken(req.token, { stageId: req.stageId, revision: req.revision, paidHash: paidItemsHash(req.items) }, req.now ?? Date.now())
  if (!verified.ok) return { ok: false, code: verified.code, reason: verified.reason, estimate }
  return { ok: true, reason: '成本闸门通过', estimate, token: verified.token }
}

// ── 记账（内存账本；持久化由调用方写 plan_events + video_jobs.cost_cny） ──
export interface LedgerEntry {
  plan_id: string
  stage_id: string
  job_id: string
  kind: VideoJobKind
  cny: number
  request_id?: string
  at: number
}

export class CostLedger {
  private entries: LedgerEntry[] = []

  record(entry: LedgerEntry): LedgerEntry {
    this.entries.push(entry)
    return entry
  }

  spentOf(planId: string): number {
    return round2(this.entries.filter((e) => e.plan_id === planId).reduce((s, e) => s + e.cny, 0))
  }

  byStage(planId: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const e of this.entries.filter((x) => x.plan_id === planId)) out[e.stage_id] = round2((out[e.stage_id] ?? 0) + e.cny)
    return out
  }

  list(planId?: string): LedgerEntry[] {
    return planId ? this.entries.filter((e) => e.plan_id === planId) : [...this.entries]
  }

  /** 与外部 persisted 账本对账（重启后把 IndexedDB 里的历史花费合并回来） */
  seed(entries: LedgerEntry[]): void {
    for (const e of entries ?? []) {
      if (!this.entries.some((x) => x.job_id === e.job_id && x.at === e.at)) this.entries.push(e)
    }
  }

  clear(): void {
    this.entries = []
  }
}
