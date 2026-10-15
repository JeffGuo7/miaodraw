/**
 * 文案/分镜（V1 `script.ts`）—— LLM 输出 → narrations + image_prompts，**纯函数可单测**。
 *
 * 设计稿依据：§一②「两段式」（先文案，再逐镜头画面提示词）＋ P0 文案检查卡：
 * - 台词密度硬指标（中文 3-4 字/秒）：超预算要求拆段/删词，不许指望念快
 * - 低质黑名单（震惊体/喊话体/标题党/绝对化/速成诱饵）：命中即标记，由调用方重写一次
 * - 上屏文字只写用户给的确切文案，未给一律留空（编造=交付事故）
 *
 * 本模块不做 IO：LLM 调用由 executor 用现有 httpChat 完成，这里只负责 prompt 与解析/校验。
 */
import { checkVoBlacklist, checkVoDensity, voBudget, type VoHit } from '../prompt-guards.ts'

export interface Shot {
  index: number
  /** 口播/旁白（该镜头说的话） */
  narration: string
  /** 画面提示词（交给出图节点） */
  image_prompt: string
}

export interface ScriptResult {
  title: string
  /** 全片口播（= 各镜头 narration 顺序拼接） */
  narration: string
  shots: Shot[]
  /** 需要调用方处理的问题（黑名单命中/密度超预算/结构缺失） */
  issues: string[]
  blacklistHits: VoHit[]
  /** 预算内建议字数（按镜头时长合计） */
  budget: { min: number; max: number }
}

/** 分成一段的默认时长（秒）：V1 每镜头默认 3 秒画面 */
export const DEFAULT_SHOT_SECONDS = 3

/** 给 LLM 的脚本 prompt（纯字符串，便于单测与复用） */
export function buildScriptPrompt(brief: string, opts: { shotCount?: number; shotSeconds?: number; onScreenText?: string } = {}): string {
  const n = Math.max(1, Math.round(opts.shotCount ?? 5))
  const sec = Math.max(1, Math.round(opts.shotSeconds ?? DEFAULT_SHOT_SECONDS))
  const b = voBudget(n * sec)
  return [
    `你是短视频编导。用户需求（原句，不得改写其商业事实）：${brief}`,
    ``,
    `请输出 ${n} 个分镜，每镜头画面时长约 ${sec} 秒，口播总字数控制在 ${b.min}-${b.max} 字（中文 ${3}-${4} 字/秒，超了要拆段或删词，不许指望念快）。`,
    opts.onScreenText ? `画面内只允许出现这些文字（逐字照抄，不得新增品牌名/电话/邮箱/价格/承诺）：${opts.onScreenText}` : `画面内不要出现任何文字。`,
    ``,
    `要求：`,
    `1. 只输出 JSON，不要解释；结构：{"title": "…", "shots": [{"narration": "…", "image_prompt": "…"}]}`,
    `2. image_prompt 是给文生图模型的画面描述：写清主体、环境、光位、构图、色彩，不要出现「不要 X」这类否定句`,
    `3. 不得编造用户没给的品牌名、联系方式、地址、价格、福利承诺`,
    `4. 口播是口语，短句为主，不堆形容词`
  ].join('\n')
}

/** 从任意文本里抽出 JSON（容忍 ```json 围栏与前后废话） */
export function extractJson(text: string): unknown | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], raw]
  for (const c of candidates) {
    if (!c) continue
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // 试下一个
    }
  }
  return null
}

/** 纯文本兜底：模型没给 JSON 时按行/句切分，保证流程不断（并在 issues 里说明） */
function fallbackShots(text: string, shotCount: number): Shot[] {
  const parts = String(text ?? '')
    .split(/\n+|(?<=[。！？!?])/)
    .map((s) => s.replace(/^[\s\-*\d.、]+/, '').trim())
    .filter((s) => s.length > 0)
  const picked = parts.slice(0, Math.max(1, shotCount))
  return picked.map((p, i) => ({ index: i + 1, narration: p, image_prompt: p }))
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/**
 * 解析 LLM 输出 → ScriptResult（含校验）。**不抛错**：结构坏了走兜底并在 issues 里记账。
 */
export function parseScript(llmText: string, opts: { shotCount?: number; shotSeconds?: number; expectedTotalSeconds?: number } = {}): ScriptResult {
  const wantShots = Math.max(1, Math.round(opts.shotCount ?? 5))
  const json = extractJson(llmText)
  const issues: string[] = []
  let title = ''
  let shots: Shot[] = []

  const root = asRecord(json)
  if (json && Array.isArray(root.shots)) {
    title = String(root.title ?? '').trim()
    shots = (root.shots as unknown[])
      .map((s, i) => {
        const r = asRecord(s)
        return {
          index: i + 1,
          narration: String(r.narration ?? '').trim(),
          image_prompt: String(r.image_prompt ?? r.imagePrompt ?? '').trim()
        }
      })
      .filter((s) => s.narration || s.image_prompt)
    if (!shots.length) issues.push('LLM 返回了空的 shots')
  } else {
    issues.push(json ? 'LLM JSON 缺少 shots 数组，已按文本兜底切分' : 'LLM 未返回可解析 JSON，已按文本兜底切分')
    shots = fallbackShots(llmText, wantShots)
  }

  // 缺画面提示词 → 用口播兜底（画面不能为空，否则出图节点会拒）
  shots = shots.map((s) => ({ ...s, image_prompt: s.image_prompt || s.narration }))
  if (shots.some((s) => !s.narration && s.image_prompt)) issues.push('部分分镜缺口播，已用画面提示词兜底')

  const narration = shots.map((s) => s.narration).filter(Boolean).join('')
  const totalSeconds = Math.max(1, Math.round(opts.expectedTotalSeconds ?? wantShots * (opts.shotSeconds ?? DEFAULT_SHOT_SECONDS)))
  const budget = voBudget(totalSeconds)

  const blacklistHits = checkVoBlacklist(narration)
  if (blacklistHits.length) issues.push(`口播命中低质黑名单：${blacklistHits.map((h) => h.kind).join('/')}`)

  const density = checkVoDensity(narration, totalSeconds)
  if (density.over) issues.push(`台词密度超预算（${density.chars} 字 / ${totalSeconds} 秒）：${density.advice}`)

  return { title, narration, shots, issues, blacklistHits, budget }
}

/** 分镜 → 出图提示词（尾部只追加确定性增强；文字未给就不写文字） */
export function shotImagePrompt(shot: Shot, opts: { ratio?: string; onScreenText?: string } = {}): string {
  const parts = [shot.image_prompt]
  if (opts.ratio) parts.push(`画幅 ${opts.ratio}`)
  parts.push(opts.onScreenText ? `画面内文字仅限：「${opts.onScreenText}」` : '画面内不出现任何文字')
  return parts.join('，')
}
