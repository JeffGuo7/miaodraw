import path from 'node:path'
import fsp from 'node:fs/promises'
import { extractJson, plannerSystem, validatePlan, type PlanStep } from './tools'
import { httpChat, httpBailianImage, persistImage, writeImageSidecar, clampRefs, DASHSCOPE_ORIGIN, type ModelConn, type RefImage } from './http'
import { httpGenerate } from './providers'

export interface AgentEvent {
  runId: string
  stage: 'plan' | 'step' | 'done' | 'error'
  index?: number
  total?: number
  label?: string
  detail?: string
  reply?: string
}

export interface AgentRunResult {
  reply: string
  files: Array<{ file: string; url: string }>
  last: { file: string; url: string } | null
}

interface RunOpts {
  runId: string
  goal: string
  baseImage?: string // outputs 目录内的文件名（无扩展名歧义）
  /** Agent 规划（文本对话）连接：来自通用配置 defaults.text */
  textConn: ModelConn
  /** 出图步骤连接：来自通用配置 defaults.image（或用户在创作页选择的模型） */
  imageConn: ModelConn
  /** 创作页素材托盘的素材（1-based 序号即"图1/图2"），供 edit_image/generate_image 的 images 参数引用 */
  materialPool?: RefImage[]
  outputsDir: string
  onEvent: (e: AgentEvent) => void
}

function parseSize(v: unknown, fallbackW: number, fallbackH: number): { w: number; h: number } {
  const m = typeof v === 'string' ? v.match(/(\d{2,5})\s*[xX*×]\s*(\d{2,5})/) : null
  if (!m) return { w: fallbackW, h: fallbackH }
  return { w: Number(m[1]), h: Number(m[2]) }
}

/** 解析模型给的素材引用参数："1,2" / "1 3" / "图1、图2" → 1-based 序号数组 */
function parseImageRefs(v: unknown): number[] {
  if (typeof v === 'number') return [v]
  if (typeof v !== 'string') return []
  return [
    ...new Set(
      (v.match(/\d+/g) ?? [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  ]
}

/** 单步出图：bailian 走 DashScope 原生（支持多素材/改图），其余走 OpenAI 兼容文生图 */
async function genImage(
  conn: ModelConn,
  p: { prompt: string; negative?: string; w: number; h: number; parent?: string; refs?: RefImage[]; runId?: string },
  outputsDir: string,
  onProgress?: (stage: string, detail?: string) => void
): Promise<{ file: string; url: string; seed: number }> {
  const usedSeed = Math.floor(Math.random() * 2147483647)
  const refs = p.refs ?? []
  if (conn.kind === 'bailian') {
    const r = await httpBailianImage({
      origin: conn.origin || DASHSCOPE_ORIGIN,
      apiKey: conn.apiKey,
      model: conn.model,
      prompt: p.prompt,
      negative: p.negative,
      w: p.w,
      h: p.h,
      seed: usedSeed,
      refs,
      runId: p.runId,
      onProgress
    })
    const { file, url } = await persistImage(r.buffer, outputsDir, {
      prompt: p.prompt,
      negative: p.negative,
      w: p.w,
      h: p.h,
      seed: usedSeed,
      model: conn.model,
      provider: 'bailian',
      parent: p.parent
    })
    return { file, url, seed: usedSeed }
  }
  if (refs.length) throw new Error('当前生图服务商暂不支持改图/素材融合，请把「生图默认」切换为百炼模型后再用 AI 助手')
  const r = await httpGenerate({
    provider: conn.provider,
    apiBase: conn.apiBase,
    apiKey: conn.apiKey,
    prompt: p.prompt,
    negative: p.negative,
    w: p.w,
    h: p.h,
    seed: usedSeed,
    model: conn.model,
    outputsDir
  })
  const url = `media://local/out/${encodeURIComponent(r.file)}`
  await writeImageSidecar(outputsDir, r.file, {
    prompt: p.prompt,
    negative: p.negative,
    w: p.w,
    h: p.h,
    seed: r.seed,
    model: conn.model,
    provider: conn.provider,
    parent: p.parent
  })
  return { file: r.file, url, seed: r.seed }
}

export async function runAgent(opts: RunOpts): Promise<AgentRunResult> {
  const { runId, goal, outputsDir } = opts
  const pool = opts.materialPool ?? []
  const hasBase = !!opts.baseImage
  const poolDesc = pool.length
    ? `创作页素材托盘已有 ${pool.length} 张素材（${pool.map((r, idx) => `图${idx + 1}${r.role && r.role !== 'ref' ? `=${r.role}` : ''}`).join('、')}），可让工具用 images 参数引用（如 "1,2"）。`
    : '创作页素材托盘为空。'
  const context = `${poolDesc}${hasBase ? `画布上已有图片 1 张（文件 ${opts.baseImage}），edit_image 不传 images 时默认基于它修改。` : '画布为空，纯文生图请用 generate_image。'}`

  // ---- 规划（文本模型来自通用配置 defaults.text） ----
  opts.onEvent({ runId, stage: 'plan', label: 'AI 规划步骤中' })
  let content: string
  try {
    content = await httpChat({
      apiBase: (opts.textConn.apiBase || '').trim(),
      apiKey: opts.textConn.apiKey,
      model: opts.textConn.model,
      system: plannerSystem(context),
      message: goal,
      temperature: 0.3,
      timeoutMs: 180000,
      disableThinking: opts.textConn.kind === 'bailian'
    })
  } catch (e) {
    throw new Error(`AI 规划失败：${e instanceof Error ? e.message : e}`, { cause: e })
  }
  let plan: { reply: string; steps: PlanStep[] }
  try {
    plan = validatePlan(extractJson(content))
  } catch (e) {
    throw new Error(`AI 规划失败：${e instanceof Error ? e.message : e}`, { cause: e })
  }
  if (plan.steps.length === 0) {
    return { reply: plan.reply || '这个需求当前工具还做不到。', files: [], last: null }
  }

  // ---- 顺序执行 ----
  const files: Array<{ file: string; url: string }> = []
  let currentAbs: string | null = opts.baseImage ? path.join(outputsDir, opts.baseImage) : null
  let currentName: string | undefined = opts.baseImage
  let i = 0
  for (const step of plan.steps) {
    i++
    const specLabel = step.tool === 'generate_image' ? '文生图' : '改图'
    opts.onEvent({
      runId,
      stage: 'step',
      index: i,
      total: plan.steps.length,
      label: `${specLabel}：${String(step.params.prompt ?? '').slice(0, 30)}`
    })
    const size = parseSize(step.params.size, 1024, 1024)
    if (step.tool === 'edit_image' && !currentAbs && !opts.materialPool?.length) {
      throw new Error('没有可修改的图片，无法执行 edit_image')
    }
    // 素材引用优先：模型给出 images=[1,2] 时用托盘里的图1/图2；否则沿用上一步产出
    const picked = parseImageRefs(step.params.images)
      .map((n) => pool[n - 1])
      .filter((r): r is RefImage => !!r)
    let stepRefs: RefImage[] = []
    if (picked.length) {
      stepRefs = picked
    } else if (currentAbs) {
      stepRefs = [
        { name: path.basename(currentAbs), data: new Uint8Array(await fsp.readFile(currentAbs)).buffer as ArrayBuffer }
      ]
    }
    stepRefs = clampRefs(stepRefs, opts.imageConn.model).refs
    const res = await genImage(
      opts.imageConn,
      {
        prompt: String(step.params.prompt ?? ''),
        negative: typeof step.params.negative === 'string' ? step.params.negative : undefined,
        w: size.w,
        h: size.h,
        parent: currentName,
        refs: stepRefs.length ? stepRefs : undefined,
        runId: `${opts.runId}-s${i}`
      },
      outputsDir
    )
    files.push({ file: res.file, url: res.url })
    currentAbs = path.join(outputsDir, res.file)
    currentName = res.file
  }

  const last = files.length ? files[files.length - 1] : null
  opts.onEvent({ runId, stage: 'done', reply: plan.reply })
  return { reply: plan.reply, files, last }
}
