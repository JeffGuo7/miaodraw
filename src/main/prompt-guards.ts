/**
 * 提示词质量层（P0）—— 失败卡 QC + 厂商卡 + 海报配方 + 文案保真校验。
 *
 * 依据（团队已核实素材）：
 * - MiniMax Skills：knowledge/failures（13 卡）、knowledge/vendors（15 卡）、image-recipes/poster
 * - Painter《生图工作规程》v1（14 条自检 + A/B 实测反例）
 * - Writer《文案检查卡》（口播密度硬指标 + 低质/套版黑名单 + 上屏文字规则）
 * 说明：纯函数、零依赖，主进程与渲染层共用；单测见同目录 prompt-guards.test.mjs。
 */

// ── 一、失败卡 QC checklist（合并 MiniMax 失败卡 + Painter 十四条） ──

export interface FailureCheck {
  id: string
  /** 触发信号（用于自检匹配） */
  signal: string
  /** 后果 */
  verdict: string
  /** 处理 */
  fix: string
}

export const FAILURE_CHECKS: FailureCheck[] = [
  { id: 'constraint-negation', signal: 'prompt 正文出现「不要 X / 禁止 / 无」清单（>1 条）', verdict: '模型倾向把 X 画出来', fix: '否定项只放 negative prompt；正文改写成正向可见状态（"干净背景，空白画面"）' },
  { id: 'abstract-mood', signal: '抽象氛围词（高级感/治愈/温暖/氛围感）单独出现', verdict: '大概率跑偏', fix: '翻译成可见杠杆：光位、材质、构图密度、色彩比例、字体气质' },
  { id: 'on-image-text', signal: '画内文字没写位置/层级/引号', verdict: '文字必糊或乱', fix: '文字用引号包裹 + 写位置 + 写层级；长边 ≥2048' },
  { id: 'medium-drift', signal: '没写媒介（插画/摄影/3D/平面）', verdict: '媒介漂移，出来四不像', fix: '末尾加 Medium: <单一媒介>。只锁一种，不混写' },
  { id: 'aspect-missing', signal: '没写比例/尺寸', verdict: '画布飘，构图不可控', fix: 'size 参数 + prompt 正文同时写（9:16 竖屏海报）' },
  { id: 'era-disambiguation', signal: '年代词（复古/Y2K/80s）无地域+媒介', verdict: '出来是别的年代', fix: '绑定 年代+地域+媒介来源' },
  { id: 'plastic-skin', signal: '写实人脸/人像特写', verdict: '塑料脸', fix: '加自然皮肤纹理、细微毛孔、轻微瑕疵、单缕发丝；老人加皱纹老年斑' },
  { id: 'anatomy-traps', signal: '手/脚是主体或特写', verdict: '手部崩坏', fix: '主体手写明「五指清晰、比例自然」；非主体手脚用构图裁掉' },
  { id: 'intent-overreach', signal: '用户是短语长句（"改成XX""加点XX"）', verdict: '意图越界，被扩写成设计规范', fix: '保留用户原句序与语气，只在尾部追加确定性增强' },
  { id: 'ref-role-missing', signal: '多张参考图但没说每张干嘛', verdict: '参考角色串味', fix: '先给每张图标角色（主体/版式/风格/身份/氛围），prompt 只取该角色该给的维度' },
  { id: 'unenumerated-copy', signal: '要求"一行小字招聘信息/底部小字说明"却没给具体文案', verdict: '必糊或必编造（A/B 实测：编出品牌名+电话+地址+五险一金）', fix: '画内文字只写用户给的确切文案；其余区域留白或写无文字版式占位' },
  { id: 'fabrication-pressure', signal: '涉及联系方式/价格/承诺/品牌名但用户未给', verdict: '模型会自行"补全"海报（编造商业事实）', fix: '中性占位 + 显式声明"文字内容以上述引号内文案为准"' },
  { id: 'small-text-illegible', signal: '需要 <40px 的小字正文', verdict: '生成模型写不对小字', fix: '小字正文走确定性后处理（PIL/设计稿合成），不交给模型' },
  { id: 'retry-without-change', signal: '同一 prompt 已重抽 2 次仍不合格', verdict: '继续抽卡是浪费钱', fix: '第 3 次必须改参数或改 prompt；局部可改的用 image edit 保住已验证部分' }
]

export interface QcFinding {
  id: string
  evidence: string
}

/** 出图前自检：命中项按风险排序返回（不阻塞，交给调用方决定） */
export function qcImagePrompt(prompt: string, opts: { hasRefs?: boolean; isRealisticFace?: boolean; needsText?: boolean } = {}): QcFinding[] {
  const p = prompt || ''
  const out: QcFinding[] = []
  const push = (id: string, evidence: string): void => {
    out.push({ id, evidence })
  }

  const negations = p.match(/(不要|禁止|避免|无)\s*[^，。；,;]+/g) ?? []
  if (negations.length > 1) push('constraint-negation', `${negations.length} 处否定式：${negations.slice(0, 2).join(' / ')}`)

  const moodWords = ['高级感', '治愈', '温暖', '氛围感', 'ins风', '质感', '唯美']
  const hitMood = moodWords.filter((w) => p.includes(w))
  const hasLevers = /(光位|侧光|逆光|柔光|硬光|材质|哑光|磨砂|玻璃|绸缎|构图|留白|三分|对称|色彩比例|主色|辅色|高光)/.test(p)
  if (hitMood.length && !hasLevers) push('abstract-mood', `抽象氛围词 ${hitMood.join('/')} 且无可见杠杆`)

  if (!/Medium:|插画|摄影|照片|3D|平面设计|水彩|油画/.test(p)) push('medium-drift', '未见媒介锁定')

  if (!/(\d+\s*[:：]\s*\d+)|\d{3,5}\s*[x×*]\s*\d{3,5}/.test(p)) push('aspect-missing', '未见比例/尺寸')

  if (/(复古|Y2K|80s|90s|赛博|蒸汽波)/.test(p) && !/(中国|日本|美国|香港|上海|东京|地域|年代)/.test(p)) push('era-disambiguation', '年代词未绑地域/来源')

  if (/(不要|禁止|避免)/.test(p) && !opts.needsText) push('constraint-negation', '正文含否定式（否定项应只放 negative prompt）')

  if (opts.needsText && !/["“「][^"”」]{2,}["”」]/.test(p)) push('on-image-text', '需要文字但未见引号内确切文案')

  if (opts.isRealisticFace && !/(皮肤纹理|毛孔|瑕疵|发丝|皱纹)/.test(p)) push('plastic-skin', '写实人脸未写皮肤细节')

  if (/(手|脚)/.test(p) && !/(五指|比例自然|裁切|裁掉)/.test(p)) push('anatomy-traps', '手/脚未写比例约束或裁切')

  if (opts.hasRefs && !/(图\s*1|图片1|image\s*1)/i.test(p)) push('ref-role-missing', '有参考图但未写引用位置/角色')

  return out
}

// ── 二、厂商卡（含 wan/qwen 补卡） ──

export interface VendorCard {
  /** 模型族匹配前缀 */
  prefix: string
  name: string
  /** 参考图上限（硬数据） */
  maxRefs: number
  notes: string[]
}

export const VENDOR_CARDS: VendorCard[] = [
  { prefix: 'z-image-turbo', name: 'Z-Image Turbo', maxRefs: 1, notes: ['省钱档打样默认（¥0.1/张）', '快速验证构图/配色/文案位置', '非终稿级质量，定稿换 qwen-image 或 wan2.7-image'] },
  { prefix: 'qwen-image-3', name: 'Qwen-Image 3.x', maxRefs: 3, notes: ['画内中文文字/版式定稿首选', '模型自带 prompt 扩写（prompt_extend 默认开），精确构图/文案时关掉', '小字正文（<40px）不可靠，走确定性后处理'] },
  { prefix: 'wan2.7-image', name: 'Wan 2.7 Image', maxRefs: 9, notes: ['写实质感/大图定稿', '多素材融合上限 9 张'] },
  { prefix: 'qwen-image', name: 'Qwen-Image（旧）', maxRefs: 3, notes: ['兼容旧配置'] },
  { prefix: 'doubao-seedream', name: 'Seedream', maxRefs: 14, notes: ['厂商硬上限 14 张参考图（MiniMax 厂商卡）'] },
  { prefix: 'gpt-image', name: 'GPT Image', maxRefs: 16, notes: ['厂商硬上限 16 张参考图'] },
  { prefix: 'kling', name: 'Kling', maxRefs: 1, notes: ['参考图仅 1 张'] }
]

export function vendorCardFor(model: string): VendorCard | null {
  const m = (model || '').toLowerCase()
  // 前缀按长度降序匹配，避免 qwen-image 抢走 qwen-image-3
  return [...VENDOR_CARDS].sort((a, b) => b.prefix.length - a.prefix.length).find((c) => m.startsWith(c.prefix)) ?? null
}

// ── 三、海报配方（原句保真 + 确定性增强尾句） ──

export interface PosterOptions {
  /** 比例或像素，如 '9:16' / '1080x1920' */
  size?: string
  /** 投放语境，如 '手机屏主视觉 KV' */
  context?: string
  /** 版式方向（只给一个宽泛词） */
  layout?: '信息阶梯' | '上图下文' | '三分留白' | '中心对称'
  /** 色彩比例（数值化，最高价值项） */
  palette?: { main?: string; accent?: string; highlight?: string }
  /** 材质光影词（仅产品/食物/玻璃/美妆类） */
  material?: string
  /** 画内文字：只允许用户确切给的文案（原文，逐字） */
  onImageText?: string[]
  /** 媒介锁（单一） */
  medium?: string
}

/**
 * 组装出图 prompt：**首段保留用户原句序与语气**，尾部只追加确定性增强。
 * 不写用户没给的商业事实；文字只写确切文案。
 */
export function buildImagePrompt(brief: string, opts: PosterOptions = {}): string {
  const parts: string[] = [brief.trim()]
  const tail: string[] = []
  if (opts.medium) tail.push(`Medium: ${opts.medium}。`)
  if (opts.size) tail.push(`${opts.size}${opts.size.includes('x') ? '' : ' 比例'}`)
  if (opts.context) tail.push(opts.context)
  if (opts.palette) {
    const { main, accent, highlight } = opts.palette
    const bits = [
      main ? `主色${main}约 60-70%` : null,
      accent ? `辅色${accent}约 20-30%` : null,
      highlight ? `高光${highlight}约 5-10%` : null
    ].filter(Boolean)
    if (bits.length) tail.push(`色彩比例：${bits.join('，')}，并交代明暗层次位置`)
  }
  if (opts.layout) tail.push(`版式方向：${opts.layout}`)
  if (opts.material) tail.push(`材质光影：${opts.material}`)
  if (opts.onImageText?.length) {
    tail.push(`画内文字仅限：${opts.onImageText.map((t) => `「${t}」`).join('、')}，逐字照排；其余区域留白`)
    tail.push('文字内容以上述引号内文案为准，不得新增或改写任何品牌名、联系方式、价格、承诺')
  } else {
    tail.push('画面内不出现可读文字；如需文字区域，留白或不含文字的版式占位')
  }
  return tail.length ? `${parts.join('\n')}\n${tail.join('，')}` : parts.join('\n')
}

// ── 四、文案检查卡：黑名单 / 密度 / 保真 ──

/** 低质黑名单（同时是平台限流信号）；命中即重写 */
export const VO_BLACKLIST: Array<{ kind: string; re: RegExp }> = [
  { kind: '震惊体', re: /(震惊|惊呆了|吓一跳)/ },
  { kind: '喊话体', re: /(别划走|一定要看到最后|谁懂啊|姐妹们听我说)/ },
  { kind: '标题党', re: /(\d+\s*秒教你|\d+%的人不知道|99%的人)/ },
  { kind: '绝对化', re: /(史上最强|全网最低|最好用|第一品牌|绝对|100%有效)/ },
  { kind: '速成诱饵', re: /(一秒变|立刻瘦|三天速成|快速暴富)/ },
  { kind: '套版开场', re: /^(我闺蜜|他不是那种|我之前一直觉得|姐妹们)/ },
  { kind: '粘合词', re: /反正(就这样|吧)?/ }
]

export interface VoHit {
  kind: string
  match: string
}

export function checkVoBlacklist(text: string): VoHit[] {
  const hits: VoHit[] = []
  for (const { kind, re } of VO_BLACKLIST) {
    const m = text.match(re)
    if (m) hits.push({ kind, match: m[0] })
  }
  return hits
}

/** 中文口播 3-4 字/秒；英文 2.5-3 词/秒 */
export function voBudget(seconds: number, lang: 'zh' | 'en' = 'zh'): { min: number; max: number } {
  return lang === 'zh' ? { min: Math.floor(seconds * 2.7), max: Math.floor(seconds * 3.7) } : { min: Math.round(seconds * 2.5), max: Math.round(seconds * 3) }
}

export interface DensityResult {
  chars: number
  seconds: number
  budget: { min: number; max: number }
  over: boolean
  advice?: string
}

/** 台词密度校验：超预算就删词/拆段，不许指望念快 */
export function checkVoDensity(text: string, seconds: number, lang: 'zh' | 'en' = 'zh'): DensityResult {
  const chars = lang === 'zh' ? text.replace(/\s/g, '').length : text.trim().split(/\s+/).filter(Boolean).length
  const budget = voBudget(seconds, lang)
  const over = chars > budget.max
  return { chars, seconds, budget, over, advice: over ? `超预算 ${chars - budget.max} ${lang === 'zh' ? '字' : '词'}：优先删修饰词，其次拆段，不要提高语速` : undefined }
}

/** 待核实事实特征（编造检测）：电话/邮箱/地址/价格/福利承诺 */
const FACT_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: '电话', re: /1[3-9]\d{9}|\d{3,4}[-\s]?\d{7,8}|\d{3,4}([-\s]\d{4}){1,2}/ },
  { kind: '邮箱', re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i },
  { kind: '地址', re: /[\u4e00-\u9fa5]{2,}(省|市)[\u4e00-\u9fa5]{2,}(区|县)|[\u4e00-\u9fa5]{2,}(路|街|大道|巷)\s*[\u4e00-\u9fa5\d]{1,8}|[\u4e00-\u9fa5]{2,}(大厦|广场|写字楼)[\u4e00-\u9fa5\d]{0,6}/ },
  { kind: '价格', re: /(￥|¥|\$)\s?\d+|\d+\s*元(起|内|整)?/ },
  { kind: '福利承诺', re: /(五险一金|包吃包住|七天无理由|终身保修|免费领取)/ }
]

export interface FabricationFinding {
  kind: string
  match: string
}

/**
 * 编造检测：prompt 里出现的事实型内容，若用户输入中不存在 → 判定为编造。
 * （A/B 实测反例：口语直投时模型自行补出品牌名/电话/邮箱/地址/五险一金）
 */
export function scanFabrications(prompt: string, userText: string): FabricationFinding[] {
  const out: FabricationFinding[] = []
  for (const { kind, re } of FACT_PATTERNS) {
    const m = prompt.match(re)
    if (m && !userText.includes(m[0])) out.push({ kind, match: m[0] })
  }
  return out
}

/** 用户原句关键短语保真检查：引号内文案优先；无引号时取最长的中文片段 */
export function checkPhrasePreservation(userText: string, prompt: string): { total: number; missing: string[] } {
  const quoted = [...userText.matchAll(/["“「'']([^"”」'']{2,})["”」'']/g)].map((m) => m[1])
  let anchors = [...new Set(quoted)]
  if (anchors.length === 0) {
    const runs = userText.match(/[\u4e00-\u9fa5]{4,}/g) ?? []
    anchors = [...new Set(runs)].sort((a, b) => b.length - a.length).slice(0, 3)
  }
  const missing = anchors.filter((a) => !prompt.includes(a))
  return { total: anchors.length, missing }
}

export interface PromptAudit {
  prompt: string
  findings: {
    fabrications: FabricationFinding[]
    missingPhrases: string[]
    blacklist: VoHit[]
    qc: QcFinding[]
  }
  /** 需要用户确认（有编造或关键短语缺失时） */
  needsAttention: boolean
}

/**
 * 计划期审计：改 prompt 之前先跑一遍，把风险摊开（不擅自编造中性占位文案）。
 */
export function auditPlannedPrompt(prompt: string, userText: string, opts: { hasRefs?: boolean; needsText?: boolean; isRealisticFace?: boolean } = {}): PromptAudit {
  const fabrications = scanFabrications(prompt, userText)
  const { missing } = checkPhrasePreservation(userText, prompt)
  const blacklist = checkVoBlacklist(prompt)
  const qc = qcImagePrompt(prompt, opts)
  return {
    prompt,
    findings: { fabrications, missingPhrases: missing, blacklist, qc },
    needsAttention: fabrications.length > 0 || missing.length > 0 || blacklist.length > 0
  }
}

/**
 * 中性化改写（不改写用户原句）：
 * - 未确认的商业事实 → 直接置空（不编造替代内容）
 * - 用户指定文案缺失 → 追加「必须逐字包含」约束
 */
export function neutralizePrompt(prompt: string, userText: string, audit?: PromptAudit): string {
  const a = audit ?? auditPlannedPrompt(prompt, userText)
  let out = prompt
  for (const f of a.findings.fabrications) out = out.split(f.match).join('')
  out = out
    .replace(/[，,、；;]{2,}/g, '，')
    .replace(/^[，,、；;\s]+|[，,、；;\s]+$/g, '')
    .trim()
  if (a.findings.missingPhrases.length) {
    out += `\n文字内容必须逐字包含：${a.findings.missingPhrases.map((t) => `「${t}」`).join('、')}；未经确认的品牌名、联系方式、价格、承诺一律留空`
  }
  return out
}

/** 厂商参考图上限前置校验（不截断，只报告；截断仍由 clampRefs 负责） */
export function refCapCheck(requested: number, model: string): { cap: number; requested: number; over: boolean } {
  const cap = vendorCardFor(model)?.maxRefs ?? 1
  return { cap, requested, over: requested > cap }
}
