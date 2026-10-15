// 工具注册表：UI 与 Agent 共用的单一事实源。
// 新增能力在此登记 spec，Agent 规划提示词与服务端校验自动跟进。

import { FAILURE_CHECKS, VENDOR_CARDS } from './prompt-guards'

export interface ToolParamSpec {
  name: string
  type: 'string' | 'number'
  required?: boolean
  description: string
}

export interface ToolSpec {
  name: string
  label: string
  description: string
  params: ToolParamSpec[]
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'generate_image',
    label: '文生图',
    description: '根据描述从零生成一张全新的图',
    params: [
      { name: 'prompt', type: 'string', required: true, description: '画面描述，写清主体、风格、构图、光线' },
      { name: 'negative', type: 'string', description: '不想出现的元素' },
      { name: 'size', type: 'string', description: '尺寸，如 1024x1024 或 896x1152，默认 1024x1024' },
      { name: 'images', type: 'string', description: '可选：引用素材托盘里的素材序号，如 "1" 或 "1,2"（对应图1/图2）；不填为纯文生图' }
    ]
  },
  {
    name: 'edit_image',
    label: '改图/融合',
    description: '基于上一步产出的图片或素材托盘里的素材，按描述修改或融合画面，会尽量保持原图主体',
    params: [
      { name: 'prompt', type: 'string', required: true, description: '修改要求，例：把背景换成海滩；把图2的涂鸦喷到图1的车上' },
      { name: 'size', type: 'string', description: '输出尺寸，默认沿用当前图片尺寸' },
      { name: 'images', type: 'string', description: '可选：引用素材托盘里的素材序号，如 "1,2"；不填则基于上一步产出' }
    ]
  }
]

export function plannerSystem(context: string): string {
  const toolLines = TOOLS.map(
    (t) =>
      `- ${t.name}（${t.label}）：${t.description}。参数：${t.params
        .map((p) => `${p.name}${p.required ? '(必填)' : ''}=${p.description}`)
        .join('；')}`
  ).join('\n')
  // 提示词质量层（P0）：失败卡自检 + 厂商参考图上限，直接进规划约束
  const qcLines = FAILURE_CHECKS.slice(0, 12)
    .map((c) => `- ${c.signal} → ${c.verdict}；处理：${c.fix}`)
    .join('\n')
  const vendorLines = VENDOR_CARDS.map((c) => `- ${c.name}（${c.prefix}*）：参考图最多 ${c.maxRefs} 张`).join('\n')
  return `你是图片创作助手，通过调用工具完成用户的创作请求。

可用工具：
${toolLines}

规则：
- 只能使用以上工具；最多 6 步。
- 用户请求里有先后两个动作时（如「先…再…」「…然后…」），必须拆成多步：先生成用 generate_image，对生成结果再做修改用 edit_image。
- edit_image 作用于上一步的产出；没有上一步产出时不要调用 edit_image。
- 画布信息里若提到「素材托盘」，用户说到「图1/图2」时就给对应工具传 images（如 "1,2"）；没提到托盘就不要传 images。
- 参数缺失时用画布信息与常识补齐，不要反问用户。
- 与创作无关、或工具确实做不到的请求，steps 留空并在 reply 里用一句中文说明。
- 不要输出解释或工具名之外的内容。

【出图质量硬约束（失败卡 + 海报配方）】
- 用户原句保真：首段保留用户原句序与语气（"可以加点""要醒目点"这类词不要改），只允许在尾部追加确定性增强。
- 抽象氛围词（高级感/治愈/温暖）必须翻成可见杠杆：光位、材质、构图密度、色彩比例、字体气质。
- 没写媒介就补一个 \`Medium: <单一媒介>\`；没写比例就补尺寸（如 9:16 / 1024x1024）。
- 「不要 X」这类否定项**不要写进正向 prompt**，一律放 negative 参数。
- 色彩比例数值化：主色 60-70%、辅色 20-30%、高光 5-10%，并交代明暗层次位置。
- 画内文字**只写用户给的确切文案**（引号原样），没有文案的区域写留白，不得自行编造品牌名、卖点、联系方式、价格、承诺、福利。
- 需要 <40px 小字正文时不要交给生成模型，改说明"该区域走确定性后处理"。
- 常见翻车点（命中即先改 prompt 再出图）：
${qcLines}

【厂商参考图上限】
${vendorLines}

当前画布：${context}

示例：用户说「画一只猫，然后给它戴上圣诞帽」→
{"reply":"先画猫，再戴圣诞帽","steps":[{"tool":"generate_image","params":{"prompt":"一只楛色的猫，特写，柔和光线"}},{"tool":"edit_image","params":{"prompt":"给猫戴上一顶红色圣诞帽"}}]}

严格只输出一个 JSON 对象，格式：
{"reply": "一句话给用户的说明（可为空字符串）", "steps": [{"tool": "工具名", "params": {}}]}`
}

export interface PlanStep {
  tool: string
  params: Record<string, unknown>
}

/** 服务端校验：模型给出的计划不可直接执行 */
export function validatePlan(raw: unknown): { reply: string; steps: PlanStep[] } {
  if (typeof raw !== 'object' || raw === null) throw new Error('计划不是对象')
  const obj = raw as { reply?: unknown; steps?: unknown }
  const reply = typeof obj.reply === 'string' ? obj.reply : ''
  if (!Array.isArray(obj.steps)) throw new Error('计划缺少 steps')
  const steps: PlanStep[] = []
  for (const s of obj.steps.slice(0, 8)) {
    if (typeof s !== 'object' || s === null) throw new Error('步骤格式错误')
    const { tool, params } = s as { tool?: unknown; params?: unknown }
    const spec = TOOLS.find((t) => t.name === tool)
    if (!spec) throw new Error(`未知工具：${String(tool)}`)
    if (typeof params !== 'object' || params === null) throw new Error(`工具 ${tool} 缺少参数`)
    const cleaned: Record<string, unknown> = {}
    for (const p of spec.params) {
      const v = (params as Record<string, unknown>)[p.name]
      if (v === undefined || v === null || v === '') {
        if (p.required) throw new Error(`工具 ${tool} 缺少必填参数 ${p.name}`)
        continue
      }
      if (p.type === 'number') {
        const n = Number(v)
        if (Number.isNaN(n)) throw new Error(`工具 ${tool} 参数 ${p.name} 应为数字`)
        cleaned[p.name] = n
      } else {
        cleaned[p.name] = String(v)
      }
    }
    steps.push({ tool: spec.name, params: cleaned })
  }
  return { reply, steps }
}

/** 从模型输出中稳健地提取 JSON 计划 */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      /* 落入下方兜底 */
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('模型输出不是有效 JSON 计划')
  }
}
