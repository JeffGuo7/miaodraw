// 工具注册表：UI 与 Agent 共用的单一事实源。
// 新增能力在此登记 spec，Agent 规划提示词与服务端校验自动跟进。

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
      { name: 'size', type: 'string', description: '尺寸，如 1024x1024 或 896x1152，默认 1024x1024' }
    ]
  },
  {
    name: 'edit_image',
    label: '改图',
    description: '基于上一步产出的图片按描述修改画面，会尽量保持原图主体',
    params: [
      { name: 'prompt', type: 'string', required: true, description: '修改要求，例：把背景换成海滩；提高整体亮度' },
      { name: 'size', type: 'string', description: '输出尺寸，默认沿用当前图片尺寸' }
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
  return `你是图片创作助手，通过调用工具完成用户的创作请求。

可用工具：
${toolLines}

规则：
- 只能使用以上工具；最多 6 步。
- 用户请求里有先后两个动作时（如「先…再…」「…然后…」），必须拆成多步：先生成用 generate_image，对生成结果再做修改用 edit_image。
- edit_image 作用于上一步的产出；没有上一步产出时不要调用 edit_image。
- 参数缺失时用画布信息与常识补齐，不要反问用户。
- 与创作无关、或工具确实做不到的请求，steps 留空并在 reply 里用一句中文说明。
- 不要输出解释或工具名之外的内容。

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
