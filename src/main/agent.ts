import path from 'node:path'
import fsp from 'node:fs/promises'
import { extractJson, plannerSystem, validatePlan, type PlanStep } from './tools'
import { httpChat, httpBailianImage, persistImage, writeImageSidecar, DASHSCOPE_ORIGIN, type ModelConn } from './http'
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
  outputsDir: string
  onEvent: (e: AgentEvent) => void
}

function parseSize(v: unknown, fallbackW: number, fallbackH: number): { w: number; h: number } {
  const m = typeof v === 'string' ? v.match(/(\d{2,5})\s*[xX*×]\s*(\d{2,5})/) : null
  if (!m) return { w: fallbackW, h: fallbackH }
  return { w: Number(m[1]), h: Number(m[2]) }
}

/** 单步出图：bailian 走 DashScope 原生（支持改图），其余走 OpenAI 兼容文生图 */
async function genImage(
  conn: ModelConn,
  p: { prompt: string; negative?: string; w: number; h: number; parent?: string; ref?: { name: string; data: ArrayBuffer }; runId?: string },
  outputsDir: string,
  onProgress?: (stage: string, detail?: string) => void
): Promise<{ file: string; url: string; seed: number }> {
  const usedSeed = Math.floor(Math.random() * 2147483647)
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
      ref: p.ref,
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
  if (p.ref) throw new Error('当前生图服务商暂不支持改图，请把「生图默认」切换为百炼模型后再用 AI 助手改图')
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
  const hasBase = !!opts.baseImage
  const context = hasBase
    ? `已有图片 1 张（文件 ${opts.baseImage}），edit_image 可直接基于它修改。`
    : '画布为空，只能使用 generate_image。'

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
    if (step.tool === 'edit_image' && !currentAbs) {
      throw new Error('没有可修改的图片，无法执行 edit_image')
    }
    const res = await genImage(
      opts.imageConn,
      {
        prompt: String(step.params.prompt ?? ''),
        negative: typeof step.params.negative === 'string' ? step.params.negative : undefined,
        w: size.w,
        h: size.h,
        parent: currentName,
        ref: currentAbs
          ? { name: path.basename(currentAbs), data: new Uint8Array(await fsp.readFile(currentAbs)).buffer as ArrayBuffer }
          : undefined,
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
